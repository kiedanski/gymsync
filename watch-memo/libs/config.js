// Shared constants for the VoiceMemo watch app.
// The GATT service is the weightlog daemon's — memos ride the same link and
// the same protocol, they are just a different message type.

export const PROTO_VERSION = 1

export const SVC_UUID = 'b7c9a1f0-8e2d-4c5b-9a3e-d41f0c8b6e21'
export const RX_UUID = 'b7c9a1f1-8e2d-4c5b-9a3e-d41f0c8b6e21' // watch -> PC, write
export const TX_UUID = 'b7c9a1f2-8e2d-4c5b-9a3e-d41f0c8b6e21' // PC -> watch, notify
export const INFO_UUID = 'b7c9a1f3-8e2d-4c5b-9a3e-d41f0c8b6e21' // PC -> watch, read

export const PERIPHERAL_NAME = 'weightlog'
export const SVC_MATCH = 'b7c9a1f0'

// Bytes of message payload per BLE write, after the 4-byte chunk header.
//
// 16 assumes an un-negotiated ATT MTU of 23. Zepp exposes no MTU API, but the
// native stack negotiates higher on its own: 96 was measured working on a
// GTR 4, taking throughput from ~158 B/s to ~550 B/s. The write *rate* is
// fixed by the connection interval (~10/s), so bytes-per-write is the only
// lever. 240 assumes the common MTU of 247. A stack that cannot manage it
// truncates writes and the daemon rejects the memo on its byte count — a safe
// failure. Fall back to 96, which is known good.
export const CHUNK_PAYLOAD = 240

export const SCAN_TIMEOUT_MS = 15000
export const CONNECT_TIMEOUT_MS = 10000
export const PREPARE_TIMEOUT_MS = 20000
// A part must finish well inside both this timeout and the daemon's reassembly
// window, or the two deadlock: the watch retransmits a part the daemon has just
// discarded. Writes land at ~10/second whatever their size, so the budget is
// chunks-per-part divided by 10.
export const ACK_TIMEOUT_MS = 30000
export const ACK_RETRIES = 3

// Raw bytes per memo part. Every part costs an ack round trip, which at the
// larger chunk size is now a big share of the transfer, so parts grow too.
// 4096 raw bytes become 5464 base64 characters plus envelope — 23 chunks at a
// 240-byte payload, a few seconds in flight, well inside both timeouts and far
// below the 255-chunk ceiling a single message has.
export const MEMO_PART_BYTES = 4096

// Recording
export const MEMO_MAX_S = 15
