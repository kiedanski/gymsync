// Wire framing shared with the gymsync daemon (see pc/gymsync/protocol.py).
// Chunk = 4-byte header (msg_id LE16, index u8, total u8) + payload.
// One message = one UTF-8 JSON document, max 255 chunks.

export function utf8Encode(str) {
  const bytes = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const low = str.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00)
        i++
      }
    }
    if (code < 0x80) {
      bytes.push(code)
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      )
    }
  }
  return bytes
}

export function utf8Decode(bytes) {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i]
    let code
    if (b < 0x80) {
      code = b
      i += 1
    } else if (b < 0xe0) {
      code = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f)
      i += 2
    } else if (b < 0xf0) {
      code = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      i += 3
    } else {
      code = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f)
      i += 4
    }
    if (code < 0x10000) {
      out += String.fromCharCode(code)
    } else {
      code -= 0x10000
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 0x3ff))
    }
  }
  return out
}

// Split a message object into ArrayBuffer chunks ready to write to RX.
export function encodeChunks(msgId, obj, payloadSize) {
  const bytes = utf8Encode(JSON.stringify(obj))
  const total = Math.max(1, Math.ceil(bytes.length / payloadSize))
  if (total > 255) throw new Error('message too large: ' + bytes.length + ' bytes')
  const chunks = []
  for (let idx = 0; idx < total; idx++) {
    const part = bytes.slice(idx * payloadSize, (idx + 1) * payloadSize)
    const buf = new Uint8Array(4 + part.length)
    buf[0] = msgId & 0xff
    buf[1] = (msgId >> 8) & 0xff
    buf[2] = idx
    buf[3] = total
    buf.set(part, 4)
    chunks.push(buf.buffer)
  }
  return chunks
}

// Reassembles chunks arriving over TX notifications into parsed messages.
export function createReassembler(onMessage) {
  const partial = {} // msg_id -> {total, parts: {idx: bytes}, count}
  return function feed(data, length) {
    const view = new Uint8Array(data, 0, length === undefined ? undefined : length)
    if (view.length < 5) return
    const msgId = view[0] | (view[1] << 8)
    const idx = view[2]
    const total = view[3]
    let entry = partial[msgId]
    if (!entry || entry.total !== total) {
      entry = { total: total, parts: {}, count: 0 }
      partial[msgId] = entry
    }
    if (entry.parts[idx] === undefined) {
      entry.parts[idx] = Array.prototype.slice.call(view, 4)
      entry.count++
    }
    if (entry.count === entry.total) {
      delete partial[msgId]
      let bytes = []
      for (let n = 0; n < entry.total; n++) bytes = bytes.concat(entry.parts[n])
      try {
        onMessage(JSON.parse(utf8Decode(bytes)))
      } catch (e) {
        // corrupted message; sender will time out waiting for our reaction and retry
      }
    }
  }
}
