# Signal K Edge Link Protocol v3 Specification

Protocol v3 keeps the v2 reliable data path and upgrades the control plane so ACK, NAK, HEARTBEAT, and HELLO packets are authenticated.

## Why v3 exists

- v2 DATA packets are already protected by AES-256-GCM.
- v2 control packets only had header/payload CRC checks, which detect corruption but do not prove who sent the packet.
- v3 closes that gap by adding a keyed authentication tag to every control packet while leaving the data-packet flow unchanged.

## Wire compatibility

- `protocolVersion: 3` must be configured on both peers.
- v2 and v3 are not wire-compatible with each other.
- v1 remains the lowest-overhead option for trusted/stable links where reliable retransmission features are not needed.

## Packet versioning

- Version byte `0x02`: v2 reliable transport
- Version byte `0x03`: v3 reliable transport with authenticated control packets

## Control-packet authentication

- Applies to `ACK`, `NAK`, `HEARTBEAT`, and `HELLO`
- Uses the configured shared `secretKey`
- Authentication tag: truncated HMAC-SHA256, 16 bytes
- Covered bytes: packet header bytes `0..12` plus the unhashed control payload
- Header CRC16 remains in place for fast corruption detection

## Packet layout differences from v2

- DATA packets: same payload processing as v2
  - optional path dictionary
  - JSON or MessagePack serialization
  - Brotli compression
  - AES-256-GCM encryption
- Control packets: payload is followed by a 16-byte authentication tag
  - ACK: `uint32 ackedSequence` + auth tag
  - NAK: repeated `uint32 missingSequence` values + auth tag
  - HEARTBEAT: auth tag only
  - HELLO: JSON payload + auth tag

## Operational guidance

- Prefer `protocolVersion: 3` for WAN, cellular, satellite, or otherwise untrusted networks.
- Keep `protocolVersion: 2` only when you explicitly need backward compatibility with already deployed v2 peers.
- If you upgrade one side to v3, upgrade the other side in the same maintenance window.

## Verification checklist

1. Set `protocolVersion` to `3` on both client and server.
2. Restart both peers.
3. Confirm data flow resumes normally.
4. Confirm ACK/NAK traffic is present in metrics/logs.
5. If the peers do not connect, verify both sides use the same protocol version and `secretKey`.
