// Shared constants for the GymLog watch app.
// UUIDs must match pc/config.example.yaml on the gymsync daemon.

export const PROTO_VERSION = 1

// Custom GATT service exposed by the gymsync daemon (PC side).
export const SVC_UUID = 'b7c9a1f0-8e2d-4c5b-9a3e-d41f0c8b6e21'
export const RX_UUID = 'b7c9a1f1-8e2d-4c5b-9a3e-d41f0c8b6e21' // watch -> PC, write
export const TX_UUID = 'b7c9a1f2-8e2d-4c5b-9a3e-d41f0c8b6e21' // PC -> watch, notify
export const INFO_UUID = 'b7c9a1f3-8e2d-4c5b-9a3e-d41f0c8b6e21' // PC -> watch, read

// The daemon advertises this local name (in the scan response packet).
// Note: passive scans may never see it — match on SVC_MATCH too.
export const PERIPHERAL_NAME = 'gymsync'

// First segment of SVC_UUID, lowercase: matched as a substring against the
// whole scan result, so it works whatever field/format the ad lands in.
export const SVC_MATCH = 'b7c9a1f0'

// Conservative chunk payload assuming un-negotiated MTU 23 (23 - 3 ATT - 4 header).
// After the INFO read succeeds, its "mp" field can raise this for the session.
export const CHUNK_PAYLOAD = 16

export const SCAN_TIMEOUT_MS = 15000
export const CONNECT_TIMEOUT_MS = 10000
export const ACK_TIMEOUT_MS = 5000
export const ACK_RETRIES = 3
export const BATCH_SIZE = 10

// Body weight picker
export const KG_MIN = 30.0
export const KG_MAX = 250.0
export const KG_DEFAULT = 80.0
