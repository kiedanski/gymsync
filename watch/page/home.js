import { createWidget, widget, align, prop, event } from '@zos/ui'
import { push } from '@zos/router'
import { setTimeout, clearTimeout } from '@zos/timer'
import { Vibrator, VIBRATOR_SCENE_SHORT_MIDDLE } from '@zos/sensor'
import { KG_MIN, KG_MAX, KG_DEFAULT } from '../libs/config'
import { lastKg, pushWeight, pendingCount } from '../libs/store'
import { createSyncClient } from '../libs/sync'

// Weight entry: one large readout with -0.1/+0.1 steppers. Dragging the
// readout still scrubs, for long jumps. On-device, assignments to `this`
// inside Page methods do not persist (see page/sync.js), so all mutable
// state lives at module scope.
const STEP_PX = 18 // drag pixels per 0.1 kg

const COLOR_TITLE = 0x6c7581
const COLOR_DIM1 = 0xc4cbd4
const COLOR_DIM2 = 0x6c7581
const COLOR_UP = 0xe7a13c
const COLOR_DOWN = 0x35c4b6
const COLOR_FLAT = 0x6c7581
const COLOR_OK = 0x35c4b6
const COLOR_ERR = 0xe06a5a

// Progress labels for the sync that runs after a save.
const SYNC_LABEL = {
  scanning: 'buscando PC…',
  connecting: 'conectando…',
  preparing: 'preparando…',
  hello: 'saludando…',
  sending: 'enviando…',
  retry: 'reintentando…',
}

let value = KG_DEFAULT
let last = null
let valueW = null
let deltaW = null
let pillW = null
let badgeBg = null
let badgeTx = null

let touchLastY = null
let touchAccum = 0

let syncing = false
let client = null
let statusTimer = null

function clamp(v) {
  return Math.min(KG_MAX, Math.max(KG_MIN, v))
}
function round1(v) {
  return Math.round(v * 10) / 10
}
function fmt(v) {
  return v.toFixed(1)
}

function vibrate() {
  try {
    const vib = new Vibrator()
    if (VIBRATOR_SCENE_SHORT_MIDDLE !== undefined) vib.setMode(VIBRATOR_SCENE_SHORT_MIDDLE)
    vib.start()
  } catch (e) {}
}

function renderValue() {
  if (valueW) valueW.setProperty(prop.TEXT, fmt(value))
}

function renderDelta() {
  if (!deltaW) return
  let text, color
  if (last === null) {
    text = 'first weigh-in'
    color = COLOR_FLAT
  } else {
    const d = round1(value - last)
    if (d > 0.001) { text = '▲ ' + fmt(Math.abs(d)) + ' vs last'; color = COLOR_UP }
    else if (d < -0.001) { text = '▼ ' + fmt(Math.abs(d)) + ' vs last'; color = COLOR_DOWN }
    else { text = '= same as last'; color = COLOR_FLAT }
  }
  deltaW.setProperty(prop.TEXT, text)
  deltaW.setProperty(prop.COLOR, color)
}

// The delta line doubles as the sync status line. revertMs 0 leaves the text
// up (sync still running); otherwise it falls back to the delta on its own.
function setStatus(text, color, revertMs) {
  if (!deltaW) return
  if (statusTimer) {
    clearTimeout(statusTimer)
    statusTimer = null
  }
  deltaW.setProperty(prop.TEXT, text)
  deltaW.setProperty(prop.COLOR, color)
  if (revertMs) {
    statusTimer = setTimeout(() => {
      statusTimer = null
      renderDelta()
    }, revertMs)
  }
}

function setValue(v) {
  v = clamp(round1(v))
  if (v === value) return
  value = v
  renderValue()
  renderDelta()
}

function renderBadge() {
  const n = pendingCount()
  const vis = n > 0
  if (badgeBg) badgeBg.setProperty(prop.VISIBLE, vis)
  if (badgeTx) {
    badgeTx.setProperty(prop.VISIBLE, vis)
    if (vis) badgeTx.setProperty(prop.TEXT, n > 9 ? '9+' : String(n))
  }
}

// Fire-and-forget sync straight after a save, so a weigh-in next to the PC
// needs no second tap. Failures are reported on the status line and left for
// the manual SYNC button; nothing here blocks further entry.
function autoSync() {
  if (syncing || pendingCount() === 0) return
  syncing = true
  try {
    client = createSyncClient((state, detail) => {
      if (state === 'done') {
        syncing = false
        renderBadge()
        setStatus('✓ ' + (detail || 'sincronizado'), COLOR_OK, 4000)
      } else if (state === 'error') {
        syncing = false
        renderBadge()
        setStatus('sin sincronizar · ' + (detail || ''), COLOR_ERR, 4000)
      } else {
        setStatus(SYNC_LABEL[state] || state, COLOR_DIM1, 0)
      }
    })
    client.start()
  } catch (e) {
    syncing = false
    setStatus('sin sincronizar', COLOR_ERR, 4000)
  }
}

function onSave() {
  pushWeight(value)
  vibrate()
  last = value
  if (pillW) pillW.setProperty(prop.TEXT, 'last ' + fmt(value) + ' kg  ›')
  renderBadge()
  renderDelta()
  autoSync()
}

// Only ever one sync client alive at a time: the Zepp BLE callbacks are
// process-wide, so a client left running here would fight the Sync page's.
function stopSync() {
  if (client) {
    client.cancel()
    client = null
  }
  syncing = false
}

function openHistory() {
  push({ url: 'page/history' })
}

Page({
  onInit() {
    const lk = lastKg()
    value = lk === null ? KG_DEFAULT : lk
    last = lk
  },

  build() {
    createWidget(widget.TEXT, {
      x: 0, y: 38, w: 480, h: 30, text: 'WEIGH-IN',
      text_size: 24, color: COLOR_TITLE, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    // Reference reading; doubles as the way into the history page.
    pillW = createWidget(widget.TEXT, {
      x: 0, y: 72, w: 480, h: 30,
      text: last === null ? 'no readings yet' : 'last ' + fmt(last) + ' kg  ›',
      text_size: 22, color: COLOR_DIM1, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })
    createWidget(widget.IMG, { x: 120, y: 66, w: 240, h: 42, src: 'touch.png' })
      .addEventListener(event.CLICK_UP, openHistory)

    // Steppers flank the readout; nothing overlaps it any more.
    createWidget(widget.BUTTON, {
      x: 26, y: 152, w: 84, h: 84, text: '−', text_size: 46,
      normal_color: 0x2a2f36, press_color: 0x454d57, radius: 42,
      click_func: () => setValue(value - 0.1),
    })
    createWidget(widget.BUTTON, {
      x: 370, y: 152, w: 84, h: 84, text: '+', text_size: 46,
      normal_color: 0x2a2f36, press_color: 0x454d57, radius: 42,
      click_func: () => setValue(value + 0.1),
    })

    valueW = createWidget(widget.TEXT, {
      x: 110, y: 146, w: 260, h: 96, text: fmt(value),
      text_size: 92, color: 0xffffff, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })
    createWidget(widget.TEXT, {
      x: 0, y: 248, w: 480, h: 30, text: 'kg',
      text_size: 26, color: COLOR_DIM2, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })

    // Delta / sync status, clear of both the readout and the buttons.
    deltaW = createWidget(widget.TEXT, {
      x: 40, y: 292, w: 400, h: 34, text: '',
      text_size: 24, color: COLOR_FLAT, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })
    renderDelta()

    createWidget(widget.BUTTON, {
      x: 81, y: 352, w: 150, h: 68, text: 'SAVE', text_size: 26,
      normal_color: 0x1a4f8a, press_color: 0x123a66, radius: 34,
      click_func: onSave,
    })
    createWidget(widget.BUTTON, {
      x: 249, y: 352, w: 150, h: 68, text: 'SYNC', text_size: 26,
      normal_color: 0x333b44, press_color: 0x4c5560, radius: 34,
      click_func: () => {
        stopSync()
        push({ url: 'page/sync' })
      },
    })

    // Pending badge, pinned to the SYNC button's top-right corner.
    badgeBg = createWidget(widget.FILL_RECT, { x: 379, y: 342, w: 28, h: 28, radius: 14, color: COLOR_UP })
    badgeTx = createWidget(widget.TEXT, {
      x: 379, y: 342, w: 28, h: 28, text: '',
      text_size: 18, color: 0x20160a, align_h: align.CENTER_H, align_v: align.CENTER_V,
    })
    renderBadge()

    // Transparent drag surface over the readout only, so it never steals
    // taps from the steppers on either side.
    const touch = createWidget(widget.IMG, { x: 112, y: 140, w: 256, h: 112, src: 'touch.png' })
    touch.addEventListener(event.CLICK_DOWN, (info) => {
      touchLastY = info.y
      touchAccum = 0
    })
    touch.addEventListener(event.MOVE, (info) => {
      if (touchLastY === null) return
      touchAccum += info.y - touchLastY // drag down -> higher numbers
      touchLastY = info.y
      while (touchAccum >= STEP_PX) { setValue(value + 0.1); touchAccum -= STEP_PX }
      while (touchAccum <= -STEP_PX) { setValue(value - 0.1); touchAccum += STEP_PX }
    })
    touch.addEventListener(event.CLICK_UP, () => {
      touchLastY = null
      touchAccum = 0
    })
  },

  onDestroy() {
    if (statusTimer) {
      clearTimeout(statusTimer)
      statusTimer = null
    }
    stopSync()
    valueW = deltaW = pillW = badgeBg = badgeTx = null
  },
})
