// Device identity and the queue of memos waiting to be sent.
// Audio lives in the app's own `data://` sandbox, one file per memo; this
// tracks what each one is and whether the PC has taken it.
import { localStorage } from '@zos/storage'

const KEY_DEVICE_ID = 'device_id'
const KEY_QUEUE = 'memo_queue'

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (raw === undefined || raw === null || raw === '') return fallback
    return JSON.parse(raw)
  } catch (e) {
    return fallback
  }
}

function writeJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value))
}

export function deviceId() {
  let id = readJSON(KEY_DEVICE_ID, null)
  if (!id) {
    id = 'gtr4-' + Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
    writeJSON(KEY_DEVICE_ID, id)
  }
  return id
}

// Ids double as the PC's dedupe key and as the filename, so they must be
// unique across memos.
export function newMemoId() {
  const ts = Math.floor(Date.now() / 1000).toString(16)
  const rnd = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
  return ts + rnd
}

export function memoFile(memoId) {
  return 'memo-' + memoId + '.opus'
}

export function addMemo(memo) {
  const queue = readJSON(KEY_QUEUE, [])
  queue.push(memo)
  writeJSON(KEY_QUEUE, queue)
  return queue.length
}

export function pendingMemos() {
  return readJSON(KEY_QUEUE, [])
}

export function pendingCount() {
  return pendingMemos().length
}

// Only ever called once the PC has acknowledged the memo as stored.
export function removeMemo(memoId) {
  const queue = readJSON(KEY_QUEUE, []).filter((m) => m.id !== memoId)
  writeJSON(KEY_QUEUE, queue)
  return queue.length
}
