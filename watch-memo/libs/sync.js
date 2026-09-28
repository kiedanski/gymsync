// BLE client for voice memos: scan -> connect -> hello -> memo -> parts -> bye.
// Same GATT service and framing as the weight app; only the message types
// differ. The watch is Central, the weightlog daemon is the GATT peripheral.
//
// A memo is far bigger than a weight batch — roughly 40 KB for 15 seconds, or
// about two minutes on this link — so the daemon stores each part as it lands
// and answers every ack with the index it wants next. That index is the single
// source of truth for where to continue: after a drop, or after any refused
// part, the client simply seeks to whatever the daemon asks for.
import { setTimeout, clearTimeout } from '@zos/timer'
import { openSync, readSync, closeSync, statSync, rmSync, O_RDONLY } from '@zos/fs'
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
  MEMO_PART_BYTES,
} from './config'
import { createBle, normUuid } from './ble'
import { encodeChunks, createReassembler, base64Encode } from './proto'
import { deviceId, pendingMemos, removeMemo, memoFile } from './store'

export function createSyncClient(onState) {
  const ble = createBle()
  const TX_N = normUuid(TX_UUID)
  let msgId = 1 + Math.floor(Math.random() * 30000)
  let scanTimer = null
  let connectTimer = null
  let prepareTimer = null
  let ackTimer = null
  let closeTimer = null
  let retries = 0
  let finished = false
  let awaiting = null // 'hello_ack' | 'memo_ack' | 'part_ack'
  let queue = []
  let qIndex = 0
  let sentCount = 0
  let memo = null
  let totalParts = 0
  let partIndex = 0
  let fd = null
  let seen = 0

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

  function closeFile() {
    if (fd !== null) {
      try {
        closeSync({ fd })
      } catch (e) {}
      fd = null
    }
  }

  // ble.close() drops Zepp BLE callbacks process-wide, so any delayed close
  // must be cancellable rather than fire under a later client.
  function closeNow() {
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    closeFile()
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

  function finishAll(detail) {
    if (finished) return
    finished = true
    clearTimers()
    closeFile()
    try {
      sendMsg({ m: 'bye' })
    } catch (e) {}
    closeTimer = setTimeout(() => {
      closeTimer = null
      try {
        ble.close()
      } catch (e) {}
    }, 500)
    state('done', detail || sentCount + ' enviado' + (sentCount === 1 ? '' : 's'))
  }

  // The PC has it: drop the local copy, then move on to the next memo.
  function memoComplete() {
    closeFile()
    try {
      rmSync({ path: memoFile(memo.id) })
    } catch (e) {}
    removeMemo(memo.id)
    sentCount++
    qIndex++
    nextMemo()
  }

  function nextMemo() {
    closeFile()
    if (qIndex >= queue.length) {
      finishAll()
      return
    }
    memo = queue[qIndex]
    const path = memoFile(memo.id)
    // Trust the file over the queue entry: the recording is what gets sent,
    // and a size mismatch would fail the daemon's check.
    let size = null
    try {
      const info = statSync({ path: path })
      if (info) size = info.size
    } catch (e) {}
    if (!size) {
      // Recording vanished; forget it rather than blocking the rest.
      removeMemo(memo.id)
      qIndex++
      nextMemo()
      return
    }
    memo.bytes = size
    totalParts = Math.ceil(size / MEMO_PART_BYTES)
    fd = openSync({ path: path, flag: O_RDONLY })
    if (fd === undefined || fd === null) {
      fail('no se pudo abrir ' + path)
      return
    }
    state('sending', qIndex + 1 + '/' + queue.length)
    sendMemoHeader()
  }

  function armAck(kind, resend) {
    awaiting = kind
    if (ackTimer) clearTimeout(ackTimer)
    ackTimer = setTimeout(
      guard(() => {
        retries++
        if (retries > ACK_RETRIES) {
          fail('sin respuesta (' + kind + ')')
          return
        }
        state('retry', kind + ' ' + retries)
        resend()
        armAck(kind, resend)
      }),
      ACK_TIMEOUT_MS
    )
  }

  function sendMsg(obj) {
    const chunks = encodeChunks(msgId, obj, CHUNK_PAYLOAD)
    msgId = (msgId + 1) % 0xffff
    for (let n = 0; n < chunks.length; n++) ble.write(RX_UUID, chunks[n])
  }

  // Read one part straight off the recording; the file is the source of
  // truth, so resuming is just a different offset.
  function sendPart(n) {
    partIndex = n
    const offset = n * MEMO_PART_BYTES
    const length = Math.min(MEMO_PART_BYTES, memo.bytes - offset)
    if (length <= 0) {
      fail('parte fuera de rango')
      return
    }
    const buffer = new ArrayBuffer(length)
    readSync({ fd, buffer, options: { offset: 0, length: length, position: offset } })
    const payload = base64Encode(new Uint8Array(buffer))
    state('sending', qIndex + 1 + '/' + queue.length + ' · ' + (n + 1) + '/' + totalParts)
    const send = guard(() => sendMsg({ m: 'memo_part', id: memo.id, n: n, d: payload }))
    send()
    armAck('part_ack', send)
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
      nextMemo()
    } else if (msg.m === 'memo_ack' && awaiting === 'memo_ack' && msg.id === memo.id) {
      clearTimeout(ackTimer)
      retries = 0
      if (!msg.ok) {
        fail('PC rechazó: ' + (msg.err || '?'))
        return
      }
      if (msg.done) {
        memoComplete() // already stored on the PC
        return
      }
      sendPart(msg.have || 0)
    } else if (msg.m === 'part_ack' && awaiting === 'part_ack' && msg.id === memo.id) {
      clearTimeout(ackTimer)
      retries = 0
      if (msg.done) {
        memoComplete()
        return
      }
      // `have` is authoritative whether the part was taken or refused, so a
      // rejected or duplicated part simply re-seeks instead of failing.
      const next = typeof msg.have === 'number' ? msg.have : partIndex + 1
      if (next >= totalParts) {
        fail('PC no confirmó el final')
        return
      }
      sendPart(next)
    }
  })

  function sendMemoHeader() {
    state('preparing', 'memo')
    const hdr = {
      m: 'memo',
      id: memo.id,
      ts: memo.ts,
      secs: memo.secs,
      bytes: memo.bytes,
      parts: totalParts,
    }
    const send = guard(() => sendMsg(hdr))
    send()
    armAck('memo_ack', send)
  }

  function sendHello() {
    state('hello')
    const hello = {
      m: 'hello',
      v: PROTO_VERSION,
      d: deviceId(),
      ts: Math.floor(Date.now() / 1000),
      p: queue.length,
    }
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
    prepareTimer = setTimeout(guard(() => fail('perfil GATT: sin respuesta')), PREPARE_TIMEOUT_MS)
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
        ble.enableNotifications(TX_UUID, guard(() => sendHello()))
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
      if (JSON.stringify(raw).toLowerCase().replace(/-/g, '').indexOf(SVC_MATCH) >= 0) return true
    } catch (e) {}
    return false
  }

  function start() {
    try {
      finished = false
      seen = 0
      sentCount = 0
      qIndex = 0
      queue = pendingMemos()
      if (!queue.length) {
        finished = true
        state('done', 'nada para enviar')
        return
      }

      state('scanning', 'vistos 0')
      let target = null
      scanTimer = setTimeout(
        guard(() => {
          ble.stopScan()
          if (!target) fail('PC no encontrada · vistos ' + seen)
        }),
        SCAN_TIMEOUT_MS
      )
      const ok = ble.startScan(
        guard((raw, mac) => {
          if (target) return
          seen++
          const name = raw.dev_name || ''
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

  function cancel() {
    closeNow()
    fail('cancelado')
  }

  return { start: start, cancel: cancel }
}
