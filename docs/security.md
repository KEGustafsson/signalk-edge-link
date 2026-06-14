# Signal K Edge Link — Security Guide

> Encryption, key management, and deployment hardening.

---

## Encryption

Every packet is encrypted with **AES-256-GCM** regardless of protocol version:

```text
[12-byte random IV] [AES-256-GCM ciphertext] [16-byte auth tag]
```

The GCM auth tag makes any bit-flip in transit detectable. Packets that fail authentication are silently dropped and counted in `encryptionErrors`.

---

## Key Formats

| Format             | Length | Example                                        | Notes                                                       |
| ------------------ | ------ | ---------------------------------------------- | ----------------------------------------------------------- |
| **32-char ASCII**  | 32 B   | `MySecretKey12345678901234567890`              | Easy to type; use `stretchAsciiKey: true` for full security |
| **64-char hex**    | 32 B   | `a3f1e2d4b5c6...`                              | Full 256-bit entropy directly                               |
| **44-char base64** | 32 B   | `o/HitLXG8AmQEjRWeJCrzvEjRZVwmkrN5TI9Xabc12s=` | Full 256-bit entropy directly                               |

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

A 32-character ASCII key has ~208 bits of raw entropy. Setting `stretchAsciiKey: true` routes the key through **PBKDF2-SHA256** (600,000 iterations, salt `signalk-edge-link-v1`) before use, deriving a 256-bit AES key from the passphrase. The effective security still depends on the passphrase entropy — PBKDF2 makes brute-force computationally expensive but does not add entropy to a weak passphrase.

**Both peers must have the same `stretchAsciiKey` setting.** A mismatch causes every packet to fail authentication silently — `encryptionErrors` will rise and no data will flow.

### Authenticated packet headers (`authenticatedHeaders`)

By default the DATA/METADATA packet header (type, flags, sequence, payload length) is protected only by a CRC16 — a non-cryptographic checksum. The AES-256-GCM auth tag covers the encrypted payload but **not** the header, so an on-path attacker can flip header bits (for example the sequence number that drives the reliable-transport ACK/NAK logic, or the COMPRESSED/MESSAGEPACK flags) and recompute the CRC. The payload still authenticates, but the tampered header can cause a valid packet to be dropped as a duplicate, ACKed under the wrong number, or trigger a spurious resync.

Setting `authenticatedHeaders: true` (v3 only) appends a **16-byte truncated HMAC-SHA256 tag** to every DATA/METADATA packet — the same construction already used for control packets — binding the header to the encrypted payload. A receiver configured with `authenticatedHeaders: true` rejects any DATA/METADATA packet that lacks the `AUTHENTICATED_HEADER` flag (downgrade protection) or carries an invalid tag. Because the **DATA** sequence number is then authenticated, the server's sequence-based de-duplication becomes a meaningful anti-replay defence for DATA.

> **Scope note:** this is integrity/tamper protection, not a full anti-replay layer. METADATA uses a separate, unacknowledged envelope sequence and is de-duplicated on the inner envelope `seq`/`idx`, not the authenticated header sequence — so a captured authenticated METADATA packet can still be replayed within the dedup window. A dedicated sliding replay window is planned for the v4 protocol work (`.planning/phases/999.2-*`).

Cost: 16 extra bytes per DATA/METADATA packet plus one HMAC per packet. **Both peers must have the same `authenticatedHeaders` setting** — a mismatch fails authentication and drops every DATA packet. A receiver with the setting _off_ that receives authenticated packets logs an explicit `authenticatedHeaders mismatch` error (rather than a misleading key-mismatch hint). The setting is backward compatible: left at its `false` default, the wire format is byte-for-byte unchanged.

> Relay topologies (boat client → proxy server → proxy client → cloud server) can enable `authenticatedHeaders` independently on each hop, and each hop may use its own `secretKey`.

---

## Security Properties

| Property                       | Status      | Detail                                                          |
| ------------------------------ | ----------- | --------------------------------------------------------------- |
| Data confidentiality           | ✓ Strong    | AES-256-GCM                                                     |
| Data integrity                 | ✓ Strong    | GCM auth tag (16 bytes)                                         |
| DATA/METADATA header integrity | Opt-in (v3) | CRC16 by default; HMAC-SHA256 with `authenticatedHeaders: true` |
| Control packet authentication  | v3 only     | HMAC-SHA256; v1 uses no control layer                           |
| Forward secrecy                | ✗ None      | Same pre-shared key for lifetime of connection                  |
| Client authentication          | ✗ None      | Any holder of the key can connect                               |
| Compression side-channel       | ✗ Low risk  | Brotli before encryption — size observable                      |

### Advanced (v3) control-plane authentication

Advanced mode adds a **16-byte truncated HMAC-SHA256 tag** (first 16 bytes of the 32-byte HMAC output) to every control packet (ACK, NAK, HEARTBEAT, HELLO). This closes the forgery vectors that exist in v1:

- **Forged FULL_STATUS_REQUEST** — triggers a full snapshot replay (reflection amplifier)
- **Forged NAK** — causes spurious retransmissions
- **Forged HELLO** — creates a spurious server session

The plugin emits a startup warning when a v1 connection is configured on a publicly reachable port.

---

## Key Rotation

There is no online key rotation. To rotate:

1. Update `secretKey` on both ends simultaneously
2. Restart the plugin on both ends
3. During the transition, packets encrypted with the old key are dropped (counted in `encryptionErrors`)

---

## Firewall Hardening

Restrict UDP ingress to the known peer address whenever possible:

```bash
# UFW — allow only from known vessel IP
ufw allow from <VESSEL_IP> to any port 4446 proto udp
ufw deny 4446/udp

# iptables
iptables -A INPUT -p udp --dport 4446 -s <VESSEL_IP> -j ACCEPT
iptables -A INPUT -p udp --dport 4446 -j DROP

# nftables
nft add rule inet filter input ip saddr <VESSEL_IP> udp dport 4446 accept
nft add rule inet filter input udp dport 4446 drop
```

If the vessel IP is dynamic (cellular), restrict by the operator's APN subnet, or deploy a VPN in front.

---

## Known Limitations

- **No forward secrecy** — compromise of the key allows decryption of all captured past traffic
- **Compression side-channel** — CRIME/BREACH class; low risk for maritime telemetry (predictable, structured data)
- **No client identity** — any party with the shared key can send and receive

For the planned key-rotation and key-agreement roadmap, see [docs/future-security-and-protocol-roadmap.md](future-security-and-protocol-roadmap.md).

---

## Management API Security

Management API endpoints require a token when `managementApiToken` is configured. See [management-tools.md](management-tools.md) for authentication details.

Endpoints intentionally exclude from their responses: token values, transport secrets, client addresses, user agents, and raw request paths.
