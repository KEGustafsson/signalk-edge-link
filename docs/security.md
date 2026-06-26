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

The AES-256-GCM auth tag covers the encrypted payload but **not** the cleartext header (type, flags, sequence, payload length). Without header authentication the header is protected only by a CRC16 — a non-cryptographic checksum — so an on-path attacker can flip header bits (for example the sequence number that drives the reliable-transport ACK/NAK logic, or the COMPRESSED/MESSAGEPACK flags) and recompute the CRC. The payload still authenticates, but the tampered header can cause a valid packet to be dropped as a duplicate, ACKed under the wrong number, or trigger a spurious resync.

**v3 authenticates DATA/METADATA headers by default** (`authenticatedHeaders`, default `true`). It appends a **16-byte truncated HMAC-SHA256 tag** to every DATA/METADATA packet — the same construction already used for control packets — binding the header to the encrypted payload. A receiver with header authentication enabled rejects any DATA/METADATA packet that lacks the `AUTHENTICATED_HEADER` flag (downgrade protection) or carries an invalid tag. Because the **DATA** sequence number is then authenticated, the server's sequence-based de-duplication becomes a meaningful anti-replay defence for DATA.

> **Scope note:** this is integrity/tamper protection, not a full anti-replay layer. METADATA uses a separate, unacknowledged envelope sequence and is de-duplicated on the inner envelope `seq`/`idx`, not the authenticated header sequence — so a captured authenticated METADATA packet can still be replayed within the dedup window. A dedicated sliding replay window is planned for the v4 protocol work (`.planning/phases/999.2-*`).

Cost: 16 extra bytes per DATA/METADATA packet plus one HMAC per packet. **Both peers must have the same `authenticatedHeaders` setting** — a mismatch fails authentication and drops every DATA packet. A receiver with the setting _off_ that receives authenticated packets logs an explicit `authenticatedHeaders mismatch` error (rather than a misleading key-mismatch hint). Since 3.0.0 the default is `true`, so two default-configured v3 peers authenticate headers automatically. To interoperate with a peer that cannot enable it, set `authenticatedHeaders: false` on **both** ends — that restores the legacy CRC-only header (byte-for-byte the pre-3.0.0 wire format).

> Relay topologies (boat client → proxy server → proxy client → cloud server) can enable `authenticatedHeaders` independently on each hop, and each hop may use its own `secretKey`.

---

## Security Properties

| Property                       | Status          | Detail                                                                |
| ------------------------------ | --------------- | --------------------------------------------------------------------- |
| Data confidentiality           | ✓ Strong        | AES-256-GCM                                                           |
| Data integrity                 | ✓ Strong        | GCM auth tag (16 bytes)                                               |
| DATA/METADATA header integrity | Default on (v3) | HMAC-SHA256 by default; CRC16-only with `authenticatedHeaders: false` |
| Control packet authentication  | v3 only         | HMAC-SHA256; v1 uses no control layer                                 |
| Forward secrecy                | ✗ None          | Same pre-shared key for lifetime of connection                        |
| Client authentication          | ✗ None          | Any holder of the key can connect                                     |
| Compression side-channel       | ✗ Low risk      | Brotli before encryption — size observable                            |

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

### Dependency / supply-chain audit policy

`npm audit` depends on the network and on freshly-published advisories, so it is
intentionally **not** part of the required per-PR gate (a registry hiccup or a
brand-new advisory must not block unrelated merges):

- The default unit-test suite (`npm test` / `npm run verify`) **skips** the
  audit test unless `RUN_NPM_AUDIT=1` is set.
- CI runs a **non-blocking** audit job on every push/PR (`continue-on-error`),
  so regressions are visible without gating merges.
- A **weekly scheduled** `audit-blocking` CI job runs
  `npm audit --omit=dev --audit-level=high` and **fails** on any high/critical
  advisory in the production dependency tree, so newly-disclosed vulnerabilities
  surface as a red scheduled run.

Run it locally any time with `RUN_NPM_AUDIT=1 npx jest __tests__/npm-audit.test.js`
or `npm audit --omit=dev --audit-level=high`.

### Packet capture is sensitive data

The packet-capture/inspector tooling (and PCAP export) records raw on-the-wire
bytes — encrypted payloads, sequence numbers, and peer addresses. Because the
protocol has **no forward secrecy** (see Known Limitations), any historical
capture of encrypted traffic becomes decryptable if the shared key is later
compromised. Treat captures as sensitive:

- Access-control capture endpoints behind a `managementApiToken` (do not run the
  management API in open-access mode if captures are enabled).
- Retain captures only as long as needed for the analysis at hand, and delete
  them afterwards rather than archiving them.
- Store and transfer exported PCAP files as you would the shared secret itself.
