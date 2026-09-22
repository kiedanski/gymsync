// Persistence for the watch: pending-item queue + last values + device id.
// v0 keeps the queue in localStorage (few items/day for body weight).
// Swap to a queue.jsonl on @zos/fs when sets/sessions land (spec §Almacenamiento).
import { localStorage } from '@zos/storage'

const KEY_QUEUE = 'queue'
const KEY_LAST_KG = 'last_kg'
const KEY_DEVICE_ID = 'device_id'
const KEY_LAST_SYNC = 'last_sync_ts'
const KEY_SEQ = 'id_seq'

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

// Item ids: epoch seconds (hex) + per-device sequence + random tail.
// Unique per device at personal scale; the PC dedupes on this string.
export function newItemId() {
  const seq = (readJSON(KEY_SEQ, 0) + 1) % 0xffff
  writeJSON(KEY_SEQ, seq)
  const ts = Math.floor(Date.now() / 1000).toString(16)
  const rnd = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0')
  return ts + seq.toString(16).padStart(4, '0') + rnd
}

export function lastKg() {
  return readJSON(KEY_LAST_KG, null)
}

export function pushWeight(kg) {
  const item = {
    i: newItemId(),
    k: Math.round(kg * 10) / 10,
    t: Math.floor(Date.now() / 1000),
  }
  const queue = readJSON(KEY_QUEUE, [])
  queue.push(item)
  writeJSON(KEY_QUEUE, queue)
  writeJSON(KEY_LAST_KG, item.k)
  return item
}

export function pendingItems() {
  return readJSON(KEY_QUEUE, [])
}

export function pendingCount() {
  return pendingItems().length
}

// Remove every item whose id the PC accepted (or already had).
export function removeAcked(ids) {
  const set = {}
  for (let n = 0; n < ids.length; n++) set[ids[n]] = true
  const queue = readJSON(KEY_QUEUE, []).filter((item) => !set[item.i])
  writeJSON(KEY_QUEUE, queue)
  return queue.length
}

export function markSynced() {
  writeJSON(KEY_LAST_SYNC, Math.floor(Date.now() / 1000))
}

export function lastSyncTs() {
  return readJSON(KEY_LAST_SYNC, null)
}
