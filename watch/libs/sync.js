// BLE sync client: scan -> connect -> profile -> hello -> batches -> bye.
// The watch is BLE Central (libs/ble.js over raw @zos/ble); weightlog on the
// PC is the GATT peripheral and the source of truth.
// Every step is wrapped so failures surface on screen instead of freezing.
import { setTimeout, clearTimeout } from '@zos/timer'
import {
  PROTO_VERSION,
  SVC_UUID,
  RX_UUID,
  TX_UUID,
  INFO_UUID,
  PERIPHERAL_NAME,
  SVC_MATCH,
  CHUNK_PAYLOAD,
  SCAN_TIMEOUT_MS,
  CONNECT_TIMEOUT_MS,
  PREPARE_TIMEOUT_MS,
  ACK_TIMEOUT_MS,
  ACK_RETRIES,
  BATCH_SIZE,
} from './config'
import { createBle, normUuid } from './ble'
import { encodeChunks, createReassembler } from './proto'
import { deviceId, pendingItems, removeAcked, markSynced } from './store'

export function createSyncClient(onState) {
  const ble = createBle()
  const TX_N = normUuid(TX_UUID)
  const INFO_N = normUuid(INFO_UUID)
  let payloadSize = CHUNK_PAYLOAD
  let msgId = 1 + Math.floor(Math.random() * 30000)
  let scanTimer = null
  let connectTimer = null
  let prepareTimer = null
  let ackTimer = null
  // ble.close() calls mstOffAllCb(), which drops BLE callbacks process-wide —
  // not just this client's. So the delayed close after a finished sync must be
  // cancellable, or it will silently unhook whichever client started next.
  let closeTimer = null
  let retries = 0
  let finished = false
  let batchSeq = 0
  let currentBatch = null
  let totals = { sent: 0, rejected: 0 }
  let awaiting = null // 'hello_ack' | 'batch_ack'
  let seen = 0
  let seenNames = []

  function state(name, detail) {
    if (onState) {
      try {
        onState(name, detail || '')
      } catch (e) {}
    }
  }

  function clearTimers() {
    if (scanTimer) clearTimeout(scanTimer)
    if (connectTimer) clearTimeout(connectTimer)
    if (prepareTimer) clearTimeout(prepareTimer)
    if (ackTimer) clearTimeout(ackTimer)
    scanTimer = connectTimer = prepareTimer = ackTimer = null
  }

  // Tear down now instead of on the delayed timer, so no stale close() can
  // unhook a client that started after this one.
  function closeNow() {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    try {
      ble.close()
    } catch (e) {}
  }

  function fail(reason) {
    if (finished) return
    finished = true
    clearTimers()
    closeNow()
    state('error', reason)
  }

  function guard(fn) {
    return function () {
      if (finished) return
      try {
        fn.apply(null, arguments)
      } catch (e) {
        fail('exc: ' + (e && e.message ? e.message : String(e)))
      }
    }
  }

  function done() {
    if (finished) return
    finished = true
    clearTimers()
    markSynced()
    try {
      sendMsg({ m: 'bye' })
    } catch (e) {}
    // Give 'bye' time to flush before tearing the link down.
    closeTimer = setTimeout(() => {
      closeTimer = null
      try {
        ble.close()
      } catch (e) {}
    }, 500)
    state('done', totals.sent + ' enviados' + (totals.rejected ? ', ' + totals.rejected + ' con error' : ''))
  }

  function armAck(kind, resend) {
    awaiting = kind
    if (ackTimer) clearTimeout(ackTimer)
    ackTimer = setTimeout(
      guard(() => {
        retries++
        if (retries > ACK_RETRIES) {
          fail('sin respuesta de la PC (' + kind + ')')
          return
        }
        state('retry', kind + ' intento ' + retries)
        resend()
        armAck(kind, resend)
      }),
      ACK_TIMEOUT_MS
    )
  }

  function sendMsg(obj) {
    const chunks = encodeChunks(msgId, obj, payloadSize)
    msgId = (msgId + 1) % 0xffff
    for (let n = 0; n < chunks.length; n++) ble.write(RX_UUID, chunks[n])
  }

  const feed = createReassembler((msg) => {
    if (finished) return
    if (msg.m === 'hello_ack' && awaiting === 'hello_ack') {
      clearTimeout(ackTimer)
      retries = 0
      if (!msg.ok) {
        fail(msg.err === 'version' ? 'Actualizar app' : 'PC rechazó: ' + (msg.err || '?'))
        return
      }
      nextBatch()
    } else if (msg.m === 'batch_ack' && awaiting === 'batch_ack' && currentBatch && msg.b === currentBatch.b) {
      clearTimeout(ackTimer)
      retries = 0
      removeAcked((msg.acc || []).concat(msg.dup || []))
      totals.sent += (msg.acc || []).length
      totals.rejected += (msg.rej || []).length
      nextBatch()
    }
  })

  function nextBatch() {
    const pending = pendingItems()
    if (pending.length === 0) {
      done()
      return
    }
    batchSeq++
    currentBatch = { b: batchSeq, items: pending.slice(0, BATCH_SIZE) }
    state('sending', totals.sent + currentBatch.items.length + ' de ' + (totals.sent + pending.length))
    const send = guard(() => sendMsg({ m: 'batch', b: currentBatch.b, w: currentBatch.items }))
    send()
    armAck('batch_ack', send)
  }

  function sendHello() {
    const hello = {
      m: 'hello',
      v: PROTO_VERSION,
      d: deviceId(),
      ts: Math.floor(Date.now() / 1000),
      p: pendingItems().length,
    }
    state('hello')
    const send = guard(() => sendMsg(hello))
    send()
    armAck('hello_ack', send)
  }

  function onConnected(mac, name) {
    state('preparing')
    const services = {}
    services[SVC_UUID] = {}
    services[SVC_UUID][RX_UUID] = []
    services[SVC_UUID][TX_UUID] = ['2902']
    services[SVC_UUID][INFO_UUID] = []
    prepareTimer = setTimeout(
      guard(() => fail('perfil GATT: sin respuesta')),
      PREPARE_TIMEOUT_MS
    )
    ble.buildProfile(
      mac,
      name,
      services,
      guard((ok, msg) => {
        if (prepareTimer) {
          clearTimeout(prepareTimer)
          prepareTimer = null
        }
        if (!ok) {
          fail('perfil GATT: ' + msg)
          return
        }
        ble.setupWriteQueue((err) => fail('escritura: ' + err))
        ble.onNotification(
          guard((uuid, data, length) => {
            if (uuid === TX_N) feed(data, length)
          })
        )
        // Operations must not overlap on the Zepp BLE stack: enable notify
        // (CCCD write), and only once it completes, send hello. INFO read is
        // dropped for now — payloadSize stays at the safe MTU-23 default.
        ble.enableNotifications(
          TX_UUID,
          guard(() => sendHello())
        )
      })
    )
  }

  function matches(raw, name) {
    if (name === PERIPHERAL_NAME) return true
    try {
      const uuids = raw.service_uuid_array
      if (uuids && uuids.length) {
        for (let n = 0; n < uuids.length; n++) {
          if (normUuid(uuids[n]).indexOf(SVC_MATCH) >= 0) return true
        }
      }
      // last resort: the UUID may sit in a field we didn't anticipate
      if (JSON.stringify(raw).toLowerCase().replace(/-/g, '').indexOf(SVC_MATCH) >= 0) return true
    } catch (e) {}
    return false
  }

  function start() {
    try {
      finished = false
      totals = { sent: 0, rejected: 0 }
      seen = 0
      seenNames = []
      if (pendingItems().length === 0) {
        finished = true
        state('done', 'nada pendiente')
        return
      }
      state('scanning', 'vistos 0')
      let target = null
      scanTimer = setTimeout(
        guard(() => {
          ble.stopScan()
          if (!target) {
            fail('PC no encontrada · vistos ' + seen + (seenNames.length ? ' · ' + seenNames.join(', ') : ''))
          }
        }),
        SCAN_TIMEOUT_MS
      )
      const ok = ble.startScan(
        guard((raw, mac) => {
          if (target) return
          seen++
          const name = raw.dev_name || ''
          if (name && seenNames.length < 4 && seenNames.indexOf(name) < 0) seenNames.push(name)
          if (!matches(raw, name) || !mac) {
            state('scanning', 'vistos ' + seen)
            return
          }
          target = mac
          clearTimeout(scanTimer)
          ble.stopScan()
          state('connecting', name || mac)
          connectTimer = setTimeout(guard(() => fail('no se pudo conectar')), CONNECT_TIMEOUT_MS)
          ble.connect(
            mac,
            guard((status) => {
              if (status === 0) {
                clearTimeout(connectTimer)
                onConnected(mac, name)
              } else if (status === 1) {
                fail('conexión falló')
              } else if (!finished) {
                fail('desconectado')
              }
            })
          )
        })
      )
      if (ok === false) fail('no se pudo iniciar el scan')
    } catch (e) {
      fail('exc: ' + (e && e.message ? e.message : String(e)))
    }
  }

  // Always releases the radio, even when the sync already finished — the
  // pending close from done() would otherwise fire later and unhook the next
  // client (mstOffAllCb is process-wide).
  function cancel() {
    closeNow()
    fail('cancelado')
  }

  return { start: start, cancel: cancel }
}
