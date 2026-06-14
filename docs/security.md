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

---

## Security Properties

| Property                      | Status     | Detail                                         |
| ----------------------------- | ---------- | ---------------------------------------------- |
| Data confidentiality          | ✓ Strong   | AES-256-GCM                                    |
| Data integrity                | ✓ Strong   | GCM auth tag (16 bytes)                        |
| Control packet authentication | v3 only    | HMAC-SHA256; v1 uses no control layer          |
| Forward secrecy               | ✗ None     | Same pre-shared key for lifetime of connection |
| Client authentication         | ✗ None     | Any holder of the key can connect              |
| Compression side-channel      | ✗ Low risk | Brotli before encryption — size observable     |

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
