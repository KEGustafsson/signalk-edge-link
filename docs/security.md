# Signal K Edge Link — Security Guide

> Encryption, key management, replay protection and deployment hardening. The wire format is in [protocol-v3-spec.md](protocol-v3-spec.md); settings are in [configuration-reference.md](configuration-reference.md).

---

## Security Properties

| Property                       | Status          | Detail                                                                                                                                      |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Data confidentiality           | Strong          | AES-256-GCM                                                                                                                                 |
| Data integrity                 | Strong          | GCM auth tag (16 bytes)                                                                                                                     |
| DATA/METADATA header integrity | Default on (v3) | HMAC-SHA256 by default; CRC16 only with `authenticatedHeaders: false`                                                                       |
| DATA replay protection         | Strong (v3)     | Per-peer sliding window survives idle expiry and eviction; epoch-gated reset; `epochBoundAuth` closes cross-epoch and spoofed-source replay |
| METADATA replay protection     | Strong (v3)     | Second per-peer window over the METADATA header sequence, same epoch rules; envelope `seq`/`idx` dedup within the live session              |
| Control packet authentication  | v3 only         | HMAC-SHA256; v1 has no control packets                                                                                                      |
| Forward secrecy                | None            | The same pre-shared key is used for the life of the connection                                                                              |
| Client authentication          | None            | Any holder of the key can connect                                                                                                           |
| Compression side-channel       | Low risk        | Brotli runs before encryption, so packet size is observable                                                                                 |

---

## Encryption

Data payloads (v1 packets; v3 DATA, METADATA and FLEET_DATA) are encrypted with AES-256-GCM:

```text
[12-byte random IV] [AES-256-GCM ciphertext] [16-byte auth tag]
```

v3 control packets are not encrypted: their payload is plaintext with a 16-byte HMAC-SHA256 tag. HELLO's JSON, including protocol version and client ID, is readable on the path; HEARTBEAT carries only the tag. The HELLO `fleet` field, which holds the vessel identity, is AES-256-GCM encrypted on its own.

The GCM auth tag detects any bit flip in transit. Packets that fail authentication are dropped and counted in `encryptionErrors`.

---

## Key Formats

The examples show the format only; generate your own key with the commands below.

| Format         | Length | Example                                        | Notes                                                                             |
| -------------- | ------ | ---------------------------------------------- | --------------------------------------------------------------------------------- |
| 32-char ASCII  | 32 B   | `Xk9mPq2vRt7wLz4nBc8dFg1hJs5aYe3u`             | Easy to type; use `stretchAsciiKey: true`                                         |
| 64-char hex    | 32 B   | `a3f1e2d4b5c6...`                              | 256 bits if the 32 bytes are random (`openssl rand -hex 32`)                      |
| 44-char base64 | 32 B   | `o/HitLXG8AmQEjRWeJCrzvEjRZVwmkrN5TI9Xabc12s=` | 256 bits if random; URL-safe alphabet and 43 characters without `=` also accepted |

Validation does not measure randomness; it rejects only obviously weak keys: an ASCII key needs at least 8 different characters and 3.0 bits/char of entropy, with no short repeating pattern and no sequential run of 20 or more characters; a hex or base64 key's decoded bytes must pass the same 8-unique / 3.0-bit test.

### Generating a secure key

```bash
# 64-character hex (recommended)
openssl rand -hex 32

# 44-character base64
openssl rand -base64 32

# 32-character ASCII (use with stretchAsciiKey: true)
openssl rand -base64 32 | tr -d '/+=' | cut -c1-32
```

### Key stretching (`stretchAsciiKey`)

A 32-character ASCII key has at most about 210 bits of entropy, and only when each character is drawn at random from the 95 printable ASCII characters; a human-chosen key has far less, even when it passes the checks above. `stretchAsciiKey: true` runs it through PBKDF2-SHA256 (600,000 iterations, salt `signalk-edge-link-v1`) to derive the 256-bit AES key. PBKDF2 makes brute force expensive but does not add entropy to a weak passphrase. Hex and base64 keys are not stretched.

Both peers should have the same `stretchAsciiKey` setting. With an ASCII key, a mismatch fails authentication on every packet: `encryptionErrors` rises and no data flows. Hex and base64 keys are not stretched, so the setting has no effect on them.

The derived key is cached, so PBKDF2 runs once per key, not per packet:

- The cache is keyed by a SHA-256 digest of the ASCII secret, so the plaintext key is not retained beyond the derivation; it stays only in the connection config.
- At most 32 entries, least recently used evicted first. An evicted key is re-derived on next use.
- Each caller gets a copy of the derived key, so a caller that mutates its buffer cannot corrupt later operations on the same key.
- Hex and base64 keys are decoded on each call; the decode costs less than a cache lookup.

### Authenticated packet headers (`authenticatedHeaders`)

The GCM tag covers the encrypted payload, not the cleartext header (type, flags, sequence, payload length). Without header authentication the header is protected only by a CRC16, which an on-path attacker can recompute after flipping bits. The payload still authenticates, but a tampered sequence number or COMPRESSED/MESSAGEPACK flag can make a valid packet be dropped as a duplicate, ACKed under the wrong number, or trigger a spurious resync.

With `authenticatedHeaders: true` (default since 3.0.0), v3 appends a 16-byte truncated HMAC-SHA256 tag to every DATA and METADATA packet, the same construction as for control packets, binding the header to the encrypted payload:

- A receiver with the setting on rejects DATA/METADATA without the `AUTHENTICATED_HEADER` flag (downgrade protection) or with an invalid tag.
- The DATA sequence number is authenticated, so the server's sequence de-duplication works as anti-replay for DATA.
- Cost: 16 bytes and one HMAC per DATA/METADATA packet.
- Both peers must match; a mismatch drops every DATA packet. A receiver with the setting off that receives authenticated packets logs `authenticatedHeaders mismatch` instead of a key-mismatch hint.
- `authenticatedHeaders: false` on both ends restores the legacy CRC-only DATA/METADATA header for a v3 peer that cannot enable it. The packets are still v3 (`0x03`); a v2-only peer cannot use them.

Header authentication is integrity protection. Replay is limited by the anti-replay windows below. In a relay chain (boat client → proxy server → proxy client → cloud server), each hop sets `authenticatedHeaders` and `secretKey` independently.

### DATA anti-replay window

A verbatim copy of an encrypted DATA packet still carries a valid GCM tag. The per-session sequence tracker blocks duplicates only while the session is live, so a packet replayed after the session is gone (idle expiry, eviction at capacity, forced resync) would re-inject a stale value such as an old position or depth.

The server keeps a per-peer anti-replay window that survives session idle expiry and eviction: a high-water mark plus a record of recently accepted sequences (IPsec/DTLS style). A DATA sequence already accepted, or more than the window size behind the high-water mark, is rejected as a replay.

A peer restart picks a fresh random sequence baseline. The window is re-baselined only when the client advertises a strictly higher connection epoch in its HMAC-authenticated HELLO. A replayed old HELLO carries an epoch at or below the recorded one and is ignored, so it cannot clear the window. The epoch is an optional HELLO field; there is no per-packet wire change. Peers that do not advertise an epoch are not subject to the strict window and keep the previous behavior.

Three residuals remain:

- **Cross-epoch replay:** a packet captured before a restart whose random sequence baseline falls inside the post-restart window. Very unlikely, and only briefly after a restart. Closed by `epochBoundAuth`.
- **Spoofed-source replay:** a guard is created per `address:port` on first sight, so a replay from a source the receiver has never seen lands on a fresh guard with epoch 0 and nothing to enforce. Source-port rotation is closed: packets from an unhandshaked port of an already handshaked address fail closed. Source-IP spoofing is closed by `epochBoundAuth`.
- **Post-server-restart race:** the window is in memory and does not survive a server restart. An attacker who beats the client's reconnect in that window could replay once. The client re-establishes a higher epoch on reconnect.

The METADATA channel has a second per-peer window over the METADATA header sequence (its own sequence space), under the same rules: epoch-armed peers only, re-baselined only on a strictly higher epoch, fail-closed for unhandshaked ports of handshaked addresses. Without it, the envelope `seq`/`idx` dedup lives in the evictable session, and a METADATA packet replayed after session expiry would re-inject stale meta entries or a stale source snapshot.

### Epoch-bound packet authentication (`epochBoundAuth`)

Both residuals above exist because the auth tag does not depend on the connection epoch, so a captured packet stays valid. `epochBoundAuth` appends the sender's connection epoch to the HMAC input as a big-endian uint64 ([protocol-v3-spec.md §5.1](protocol-v3-spec.md#51-epoch-bound-authentication-optional)), so a packet authenticates only within the epoch it was sent in:

- a receiver with no epoch for the source (a fresh guard, as a spoofed source address produces) has no value to verify with;
- a receiver whose peer has restarted holds a strictly newer epoch, so a pre-restart capture fails.

The `EPOCH_BOUND_AUTH` flag is inside the HMAC-covered header, so clearing it to force a downgrade changes the authenticated bytes. HELLO is always exempt: it establishes the epoch. Wire cost: zero, the tag length is unchanged.

Requirements: off by default. Enable it on both ends, both running 4.0.0 or later. A receiver with it on refuses every DATA and METADATA packet from a sender with it off; a receiver older than 4.0.0 computes the tag without the epoch, so every DATA and METADATA packet from a sender with it on fails authentication. It also requires `authenticatedHeaders` and `protocolVersion: 3`. Upgrade one end, then the other, then enable the flag on both.

Enforcement is in the receiver:

| Sender | Receiver | Result                                                                                                                        |
| ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| off    | off      | Works. No epoch binding.                                                                                                      |
| on     | on       | Works. Protected.                                                                                                             |
| on     | off      | Works, but unprotected: the receiver still accepts unbound packets from anyone. Enabling it on the sender alone does nothing. |
| off    | on       | Link carries nothing. The receiver refuses every DATA and METADATA packet.                                                    |

The last row is counted in `stats.epochAuthMismatches` and logged as a configuration mismatch naming `epochBoundAuth`, not as an authentication failure: the keys are correct and nothing was tampered with. See [troubleshooting.md](troubleshooting.md#epoch-bound-authentication-epochboundauth).

### Fleet sharing (`fleetSharing`)

Fleet sharing ([protocol-v3-spec.md §15](protocol-v3-spec.md)) sends each client of a server connection the other clients' vessel data.

- **Trust group = one server connection.** Every client of a server connection shares its `secretKey`, so any of them can decrypt another's captured traffic. Fleet sharing does not widen that group: with scope `fleet` the server shares only vessels declared by clients of the same server connection. Use a separate server connection (port and key) for vessels that must not see each other.
- **A relay can bridge two trust groups.** A relay's client connection with fleet sharing brings the upstream fleet's vessels into the relay's tree, and the relay's server connection with scope `all` shares everything in that tree with the relay's own clients. In the other direction, the relay's uplink carries its local vessels upstream as on any relay, and an upstream server with scope `all` shares them with its fleet. Keep scope `fleet` on both servers, or fleet sharing off on the relay's client connection, when the two groups must not see each other's vessels.
- **Vessel ID is encrypted.** HELLO is HMAC-authenticated but plaintext. The client's own vessel context, which usually contains its MMSI, is carried in HELLO only as AES-256-GCM ciphertext.
- **Answers are bound to the HELLO.** Each fleet HELLO carries a fresh nonce; the client adopts a new fleet stream only from a HELLO_ACK echoing its latest nonce, and drops FLEET_DATA for any other stream. FLEET_DATA always carries the HMAC header tag (independent of `authenticatedHeaders`) and is checked by a per-stream replay window before it is decrypted, so a flood of replayed packets costs no decryption and does not use up the inbound packet cap. Under `epochBoundAuth`, fleet packets are bound to the client's epoch like other control packets.
- **Delivery depends on the vessel's NAT mapping.** The server sends fleet data to the address and port the client's packets come from. The client's outbound packets, including its heartbeats, keep the vessel's NAT mapping open, and fleet data reaches the vessel only while it is open. Set `heartbeatInterval` (default 25000 ms) below the NAT's UDP timeout. See [troubleshooting.md](troubleshooting.md#fleet-sharing).
- **One owner per vessel: a claim, not a proof.** A vessel can be claimed by one session at a time; the newest HELLO wins (`fleet.identityConflicts`). While fleet sharing is on, the server drops uplink deltas and METADATA entries for a member's vessel from any other session (`fleet.originDrops`). This enforces the current claim: a client that holds the connection's `secretKey` can send a HELLO claiming another vessel and take ownership of it. Clients that must not be able to impersonate each other need separate server connections with separate keys.
- **Replayed HELLOs cannot move ownership.** HELLO authentication does not bind the source address, so a captured HELLO could be replayed from another address. Another session takes a vessel from its live owner only with a HELLO strictly newer than the owner's newest accepted one (`fleet.replayedHellos`). HELLOs are ordered by the tag-covered connection `epoch`, which the client persists and raises on every restart, then the tag-covered `timestamp`, which it writes strictly increasing within a run. So while the owner is live no HELLO it sent earlier, including one from the same millisecond, can displace it, and a vessel restarted with its clock set back is still recognised as newer. A session in the fleet also ignores any HELLO not newer than the one it was last accepted with, so an old HELLO without a fleet request replayed with a member's source address cannot take the member out of the fleet. Residuals: the record is in memory, so right after a _server_ restart, or while the vessel has no live session, a replayed HELLO can claim the vessel until the owner's next HELLO (at most 60 s after it stops receiving fleet packets). A client that cannot persist its epoch (no writable data directory) and restarts with its clock set back cannot reclaim its vessel until its old session expires.
- **No traffic reflection.** A replayed fleet HELLO with a spoofed source address creates a session at that address. Until the client confirms the stream with a FLEET_ACK or FLEET_NAK from that address, the server has at most one FLEET_DATA in flight to it, with at most 3 retransmits, and starts a new one at most once every 20 s, plus a HELLO_ACK keepalive every 20 s, until the session expires after 5 minutes idle. A spoofed address therefore receives at most about 15 FLEET_DATA packets, each sent up to 4 times, plus about 15 HELLO_ACK keepalives per replayed HELLO, not the fleet's data stream. FLEET_DATA packets are normally at most 1400 bytes, which bounds this at under about 100 KB; a single value too large for one packet travels alone and can make one packet up to the 65,507-byte UDP limit.
- **The server's own vessel stays private.** A HELLO declaring the server's own vessel is refused (`fleet.identityRejected`), so `includeServerVessel: false` cannot be bypassed by a member claiming that vessel. With `includeServerVessel: true`, a claim accepted before the server resolved its own vessel ID is dropped once it does. A refused claim only keeps the session out of the fleet; its uplink is accepted as from any client holding the key, as it was before fleet sharing, so a client on the same vessel can still feed the server's own vessel.
- **Own data is never accepted from the fleet.** A client discards fleet deltas for its own vessel and drops from its uplink every vessel it learned from the fleet (`fleet.loopDrops`). To keep doing so after a restart, it saves the contexts of those vessels (vessel IDs such as MMSIs, no data) to `instances/<id>/fleet-learned.json` in the plugin data directory, next to the connection's other runtime files. A context not received for 24 h is removed.
- **Bounded inbound work.** Clients cap how many FLEET_DATA they accept per second, and servers cap retransmits per packet and the retransmit queue per client. The values are in [protocol-v3-spec.md §15.10](protocol-v3-spec.md).
- **AES-GCM nonce budget.** IVs are random 96-bit values (`src/codec/crypto.ts`). NIST SP 800-38D limits random IVs to 2^32 encryptions per key. With fleet sharing one key encrypts the uplink of every client plus the fleet traffic to every client: at 100 clients × 10 packets/s in each direction (2,000 packets/s) that limit is reached after about 25 days. Rotate `secretKey` well before that on high-rate hubs (see [Key Rotation](#key-rotation)).

---

## Advanced (v3) control-plane authentication

Every v3 control packet (ACK, NAK, HEARTBEAT, HELLO, META_REQUEST, FULL_STATUS_REQUEST) carries a 16-byte truncated HMAC-SHA256 tag (the first 16 bytes of the 32-byte output). Without it, any host that can reach the UDP port could forge:

- `FULL_STATUS_REQUEST`, triggering a full snapshot replay toward a spoofed address (a reflection amplifier);
- `META_REQUEST`, triggering a metadata snapshot replay;
- `NAK`, causing spurious retransmissions;
- `HELLO`, creating a spurious server session.

Bonding heartbeat probes carry an 8-byte truncated HMAC-SHA256 tag; the server drops unverified probes and the client drops unverified responses. Basic (v1) has no control packets and no reliability layer; use it only on trusted or private links.

---

## Key Rotation

There is no online key rotation. To rotate:

1. Update `secretKey` on both ends at the same time.
2. Restart the plugin on both ends.
3. During the change, packets encrypted with the old key are dropped and counted in `encryptionErrors`.

---

## Firewall Hardening

Restrict UDP ingress to the known peer address where possible:

```bash
# UFW
ufw allow from <VESSEL_IP> to any port 4446 proto udp
ufw deny 4446/udp

# iptables
iptables -A INPUT -p udp --dport 4446 -s <VESSEL_IP> -j ACCEPT
iptables -A INPUT -p udp --dport 4446 -j DROP

# nftables
nft add rule inet filter input ip saddr <VESSEL_IP> udp dport 4446 accept
nft add rule inet filter input udp dport 4446 drop
```

If the vessel IP is dynamic (cellular), restrict by the operator's APN subnet, or put a VPN in front.

---

## Known Limitations

- **No forward secrecy:** a compromised key decrypts all captured past traffic.
- **Compression side-channel:** CRIME/BREACH class; low risk for structured, predictable telemetry.
- **No client identity:** any party with the shared key can send and receive.

The planned key-rotation and key-agreement work is in [future-security-and-protocol-roadmap.md](future-security-and-protocol-roadmap.md).

---

## Management API Security

When `managementApiToken` is set, every management route requires it; with `requireManagementApiToken: true` and no token, the routes fail closed with 403. Token handling, the web UI token sources and the auth telemetry block (which excludes token values, transport secrets, client addresses, user agents and raw request paths) are in [management-tools.md](management-tools.md).

### Dependency / supply-chain audit policy

| Where                                                                       | Command                                   | Blocks                                                                                                                                                                                        |
| --------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `__tests__/npm-audit.test.js`, in `npm test` (the required per-PR `ci` job) | `npm audit --omit=dev` and `npm audit`    | Yes: any advisory in runtime dependencies, or a high/critical advisory in the dev packages bundled into `public/` (`@rjsf/core`, `@rjsf/utils`, `@rjsf/validator-ajv8`, `react`, `react-dom`) |
| CI `audit` job, every push/PR                                               | `npm audit --omit=dev`, then `npm audit`  | No (`continue-on-error`); reports the dev tree                                                                                                                                                |
| CI `audit-blocking` job, weekly schedule                                    | `npm audit --omit=dev --audit-level=high` | Yes: high/critical runtime advisories                                                                                                                                                         |

The audit test skips its assertions with a warning when the registry is unreachable, and skips the audit entirely when `SIGNALK_REGISTRY_TEST=1` (the sandboxed Signal K plugin registry harness). Run it locally with `npx jest __tests__/npm-audit.test.js` or `npm audit --omit=dev --audit-level=high`.

### Packet capture is sensitive data

Packet capture and PCAP export (`/capture/*`) record raw on-the-wire bytes: encrypted payloads, sequence numbers and peer addresses. With no forward secrecy, a stored capture becomes decryptable if the key is later compromised.

- Protect the capture endpoints with a `managementApiToken`; do not run the management API in open-access mode with captures enabled.
- Keep captures only as long as the analysis needs, then delete them.
- Store and transfer exported PCAP files as you would the shared key.
