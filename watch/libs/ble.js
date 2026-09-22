// Thin BLE Central wrapper over the raw @zos/ble mst* APIs.
// Replaces @silver-zepp/easy-ble: its 1.7.8 dist throws a ReferenceError in
// connect() (undeclared vars passed to #initiateConnection) and its scan
// callback crashes on results without a `uuid` field. The mstBuildProfile
// object shape and CCCD sequence below replicate what easy-ble generates.
import * as hmBle from '@zos/ble'
import { setTimeout, clearTimeout } from '@zos/timer'

function mac2ab(mac) {
  return new Uint8Array(mac.split(':').map((b) => parseInt(b, 16))).buffer
}

function ab2mac(ab) {
  return Array.prototype.map
    .call(new Uint8Array(ab), (b) => ('0' + b.toString(16)).slice(-2))
    .join(':')
}

function normUuid(u) {
  return String(u || '').toLowerCase().replace(/-/g, '')
}

export function createBle() {
  let connectId = null
  let profilePid = null
  let scanning = false
  let writeQueue = []
  let writing = false
  let writeTimer = null
  let onWriteError = null

  function startScan(onDevice) {
    scanning = true
    return hmBle.mstStartScan((raw) => {
      // keep raw fields; only add a printable MAC. Never assume optional
      // fields exist (that assumption is what crashes easy-ble here).
      let mac = ''
      try {
        mac = typeof raw.dev_addr === 'string' ? raw.dev_addr : ab2mac(raw.dev_addr)
      } catch (e) {}
      onDevice(raw, mac)
    })
  }

  function stopScan() {
    if (!scanning) return
    scanning = false
    try {
      hmBle.mstStopScan()
    } catch (e) {}
  }

  // cb(status): 0 connected, 1 failed, 2 disconnected (raw API semantics)
  function connect(mac, cb) {
    return hmBle.mstConnect(mac2ab(mac), (result) => {
      if (result.connected === 0) connectId = result.connect_id
      cb(result.connected)
    })
  }

  // services: { svcUuid: { charUuid: [descUuids] } } — easy-ble mini format
  function buildProfile(mac, devName, services, cb) {
    const svcEntries = Object.keys(services)
    const profile = {
      pair: true,
      id: connectId,
      profile: devName || 'gymsync',
      dev: mac2ab(mac),
      len: 1,
      list: [{ uuid: true, size: svcEntries.length, len: svcEntries.length, list: [] }],
    }
    for (let s = 0; s < svcEntries.length; s++) {
      const charMap = services[svcEntries[s]]
      const charUuids = Object.keys(charMap)
      const service = {
        uuid: svcEntries[s],
        permission: 0,
        len1: charUuids.length,
        len2: charUuids.length,
        list: [],
      }
      for (let c = 0; c < charUuids.length; c++) {
        const descs = charMap[charUuids[c]]
        const chara = { uuid: charUuids[c], permission: 32, desc: descs.length, len: descs.length }
        if (descs.length > 0) {
          chara.list = descs.map((d) => ({ uuid: d, permission: 32 }))
        }
        service.list.push(chara)
      }
      profile.list[0].list.push(service)
    }

    hmBle.mstOnPrepare((response) => {
      if (response.status === 0) {
        profilePid = response.profile
        cb(true, '')
      } else {
        cb(false, 'prepare status ' + response.status)
      }
    })
    setTimeout(() => {
      hmBle.mstBuildProfile(profile)
    }, 50)
  }

  function onNotification(cb) {
    hmBle.mstOnCharaNotification((response) => {
      if (response.profile === profilePid) cb(normUuid(response.uuid), response.data, response.length)
    })
  }

  function onValueArrived(cb) {
    hmBle.mstOnCharaValueArrived((response) => {
      if (response.profile === profilePid) cb(normUuid(response.uuid), response.data, response.length)
    })
  }

  // CCCD 2902 <- 01 00 (enable notify). cb() fires on desc-write-complete, so
  // callers can serialize the next operation and never overlap it with this
  // write (the Zepp BLE stack handles one operation at a time).
  function enableNotifications(charUuid, cb) {
    let called = false
    const fire = () => {
      if (called) return
      called = true
      if (cb) cb()
    }
    hmBle.mstOnDescWriteComplete((response) => {
      if (response.profile === profilePid) fire()
    })
    const value = new Uint8Array([0x01, 0x00]).buffer
    hmBle.mstWriteDescriptor(profilePid, charUuid, '2902', value, 2)
    // Fallback: some stacks don't emit desc-write-complete reliably.
    setTimeout(fire, 600)
  }

  function readCharacteristic(charUuid) {
    hmBle.mstReadCharacteristic(profilePid, charUuid)
  }

  // Sequential write queue: one in-flight write, advance on write-complete.
  function setupWriteQueue(onError) {
    onWriteError = onError
    hmBle.mstOnCharaWriteComplete((response) => {
      if (response.profile !== profilePid) return
      if (writeTimer) {
        clearTimeout(writeTimer)
        writeTimer = null
      }
      if (response.status !== 0) {
        writeQueue = []
        writing = false
        if (onWriteError) onWriteError('write status ' + response.status)
        return
      }
      writing = false
      pump()
    })
  }

  function pump() {
    if (writing || writeQueue.length === 0) return
    writing = true
    const item = writeQueue.shift()
    hmBle.mstWriteCharacteristic(profilePid, item.uuid, item.data, item.data.byteLength)
    writeTimer = setTimeout(() => {
      writeQueue = []
      writing = false
      if (onWriteError) onWriteError('write timeout')
    }, 5000)
  }

  function write(charUuid, arrayBuffer) {
    writeQueue.push({ uuid: charUuid, data: arrayBuffer })
    pump()
  }

  function close() {
    stopScan()
    writeQueue = []
    writing = false
    if (writeTimer) {
      clearTimeout(writeTimer)
      writeTimer = null
    }
    try {
      hmBle.mstOffAllCb()
    } catch (e) {}
    try {
      if (profilePid !== null) hmBle.mstDestroyProfileInstance(profilePid)
    } catch (e) {}
    try {
      if (connectId !== null) hmBle.mstDisconnect(connectId)
    } catch (e) {}
    profilePid = null
    connectId = null
  }

  return {
    startScan,
    stopScan,
    connect,
    buildProfile,
    onNotification,
    onValueArrived,
    enableNotifications,
    readCharacteristic,
    setupWriteQueue,
    write,
    close,
    normUuid,
  }
}

export { normUuid }
