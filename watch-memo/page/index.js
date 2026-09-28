import { createWidget, widget, align, prop } from '@zos/ui'
import { setTimeout, clearTimeout } from '@zos/timer'
import { setPageBrightTime, pauseDropWristScreenOff } from '@zos/display'
import { create, id, codec } from '@zos/media'
import { statSync } from '@zos/fs'
import { Vibrator, VIBRATOR_SCENE_SHORT_MIDDLE } from '@zos/sensor'
import { MEMO_MAX_S } from '../libs/config'
import { newMemoId, addMemo, pendingCount, memoFile } from '../libs/store'
import { createSyncClient } from '../libs/sync'

// Voice memo recorder. Separate mini-app from WeightLog on purpose: recording
// and weighing in are different activities, and `data://` is sandboxed per
// app, so memos cannot collide with the weight queue.
//
// Memos queue up: each recording gets its own id and file, so several can
// wait and ENVIAR sends them in turn, deleting each only once the PC confirms
// it. Sending is manual rather than automatic as in the weight app — the link
// carries ~350 B/s, so a 15-second memo holds the radio for minutes, which is
// not something to start behind the user's back.
//
// The recorder is released through a single path used by stop, auto-stop and
// onDestroy alike — leaving a page with a live recorder is the reported
// trigger for the GTR 4 freeze in zepp-health discussion #301.

const COLOR_TITLE = 0x6c7581
const COLOR_DIM = 0xc4cbd4
const COLOR_REC = 0xe06a5a
const COLOR_OK = 0x35c4b6

const SYNC_LABEL = {
  scanning: 'buscando PC…',
  connecting: 'conectando…',
  preparing: 'preparando…',
  hello: 'saludando…',
  sending: 'enviando',
  retry: 'reintentando',
}

let recorder = null
let recording = false
let startedAt = 0
let currentId = null
let tickTimer = null
let client = null
let syncing = false

let statusW = null
let detailW = null
let recBtn = null
let sendBtn = null

function setStatus(text, color) {
  if (statusW) {
    statusW.setProperty(prop.TEXT, text)
    statusW.setProperty(prop.COLOR, color || 0xffffff)
  }
}

function setDetail(text) {
  if (detailW) detailW.setProperty(prop.TEXT, text || '')
}

function vibrate() {
  try {
    const vib = new Vibrator()
    if (VIBRATOR_SCENE_SHORT_MIDDLE !== undefined) vib.setMode(VIBRATOR_SCENE_SHORT_MIDDLE)
    vib.start()
  } catch (e) {}
}

function releaseRecorder() {
  if (tickTimer) {
    clearTimeout(tickTimer)
    tickTimer = null
  }
  if (recorder) {
    try {
      if (recording) recorder.stop()
    } catch (e) {}
    recorder = null
  }
  recording = false
}

function stopSync() {
  if (client) {
    client.cancel()
    client = null
  }
  syncing = false
}

function showPending() {
  const n = pendingCount()
  if (!n) {
    setStatus('listo', 0xffffff)
    setDetail('máx ' + MEMO_MAX_S + 's por memo')
    if (sendBtn) sendBtn.setProperty(prop.VISIBLE, false)
    return
  }
  setStatus(n + ' memo' + (n === 1 ? '' : 's'), COLOR_OK)
  setDetail('sin enviar')
  if (sendBtn) sendBtn.setProperty(prop.VISIBLE, true)
}

function elapsed() {
  return Math.floor((Date.now() - startedAt) / 1000)
}

function tick() {
  if (!recording) return
  const secs = elapsed()
  if (secs >= MEMO_MAX_S) {
    stopRecording()
    return
  }
  setStatus(secs + 's', COLOR_REC)
  tickTimer = setTimeout(tick, 250)
}

function startRecording() {
  if (recording || syncing) return
  // The id is minted up front: it names the file, so each memo gets its own
  // and recording again never overwrites one still waiting to be sent.
  currentId = newMemoId()
  try {
    recorder = create(id.RECORDER)
    recorder.setFormat(codec.OPUS, { target_file: 'data://' + memoFile(currentId) })
    recorder.start()
  } catch (e) {
    releaseRecorder()
    setStatus('error', COLOR_REC)
    setDetail('rec: ' + (e && e.message ? e.message : String(e)))
    return
  }
  recording = true
  startedAt = Date.now()
  if (recBtn) recBtn.setProperty(prop.TEXT, 'PARAR')
  if (sendBtn) sendBtn.setProperty(prop.VISIBLE, false)
  setDetail('grabando… máx ' + MEMO_MAX_S + 's')
  tick()
}

function stopRecording() {
  if (!recording) return
  const secs = Math.max(1, elapsed())
  releaseRecorder()
  vibrate()
  if (recBtn) recBtn.setProperty(prop.TEXT, 'GRABAR')

  let size = null
  try {
    const info = statSync({ path: memoFile(currentId) })
    if (info) size = info.size
  } catch (e) {}

  if (!size) {
    setStatus('sin archivo', COLOR_REC)
    setDetail('statSync no encontró ' + memoFile(currentId))
    currentId = null
    return
  }
  addMemo({ id: currentId, ts: Math.floor(Date.now() / 1000), secs: secs, bytes: size })
  currentId = null
  showPending()
}

function startSync() {
  if (recording || syncing) return
  if (!pendingCount()) return
  syncing = true
  if (sendBtn) sendBtn.setProperty(prop.TEXT, 'CANCELAR')
  try {
    client = createSyncClient((st, detail) => {
      if (st === 'done') {
        syncing = false
        client = null
        if (sendBtn) sendBtn.setProperty(prop.TEXT, 'ENVIAR')
        setDetail(detail || 'enviado')
        showPending()
      } else if (st === 'error') {
        syncing = false
        client = null
        if (sendBtn) sendBtn.setProperty(prop.TEXT, 'ENVIAR')
        setStatus('error', COLOR_REC)
        setDetail(detail || '')
      } else {
        setStatus(st === 'sending' ? detail : '…', 0xffffff)
        setDetail(SYNC_LABEL[st] || st)
      }
    })
    client.start()
  } catch (e) {
    syncing = false
    client = null
    setStatus('error', COLOR_REC)
    setDetail('exc: ' + (e && e.message ? e.message : String(e)))
  }
}

Page({
  build() {
    try {
      setPageBrightTime({ brightTime: 300000 })
      pauseDropWristScreenOff({ duration: 300000 })
    } catch (e) {}

    createWidget(widget.TEXT, {
      x: 0, y: 44, w: 480, h: 32, text: 'MEMO',
      text_size: 26, color: COLOR_TITLE, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    statusW = createWidget(widget.TEXT, {
      x: 30, y: 136, w: 420, h: 80, text: 'listo',
      text_size: 54, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    detailW = createWidget(widget.TEXT, {
      x: 40, y: 222, w: 400, h: 72, text: '',
      text_size: 24, color: COLOR_DIM, align_h: align.CENTER_H, align_v: align.CENTER_V,
      text_style: 3, // wrap
    })

    recBtn = createWidget(widget.BUTTON, {
      x: 81, y: 306, w: 318, h: 72, text: 'GRABAR', text_size: 30,
      normal_color: 0x1a4f8a, press_color: 0x123a66, radius: 36,
      click_func: () => (recording ? stopRecording() : startRecording()),
    })

    sendBtn = createWidget(widget.BUTTON, {
      x: 120, y: 388, w: 240, h: 56, text: 'ENVIAR', text_size: 24,
      normal_color: 0x333b44, press_color: 0x4c5560, radius: 28,
      click_func: () => (syncing ? stopSync() : startSync()),
    })

    showPending()
  },

  onDestroy() {
    releaseRecorder()
    stopSync()
    statusW = detailW = recBtn = sendBtn = null
  },
})
