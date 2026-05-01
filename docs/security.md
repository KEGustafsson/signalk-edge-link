# Security Guide

This document captures operational security practices and implementation notes for Signal K Edge Link.

## Crypto primitives in use

- Payload confidentiality and integrity use **AES-256-GCM** (`src/crypto.ts`).
- IVs/nonces are generated with `crypto.randomBytes()` per packet.
- Authentication failures reject packets during decrypt and should be treated as security events.

## Management API hardening

- Protect management, configuration, and control endpoints with `managementApiToken`.
- This includes `/instances*`, `/bonding*`, `/status`, `/plugin-config`, `/config/*`,
  `/connections/:id/config/*`, `/monitoring/alerts`, `/capture/*`, and `/delta-timer`.
- Token can be supplied via:
  - `X-Edge-Link-Token`
  - `X-Management-Token` (legacy)
  - `Authorization: Bearer <token>`
- For backward compatibility, deployments with no configured management token remain open unless `requireManagementApiToken` or `SIGNALK_EDGE_LINK_REQUIRE_MANAGEMENT_TOKEN` requires token auth.
- When token auth is required but no token is configured, management routes fail closed with a `403` response and setup guidance.
- Management auth decisions are exposed through the `managementAuth` JSON block and the Prometheus counter `signalk_edge_link_management_auth_requests_total{decision,reason,action}`.
- These telemetry surfaces use bounded labels only and do not include token values, transport secrets, client addresses, user agents, or raw request paths.
- Prefer a reverse proxy with TLS and an allowlist for management endpoints.

## Secret-key handling recommendations

- Generate per-instance keys with CSPRNG output.
- Prefer **64-character hex** or **44-character base64** keys for full 256-bit
  entropy. A 32-character ASCII key provides only ~208 bits of raw entropy
  unless `stretchAsciiKey` is enabled (see below).
- For 32-character ASCII keys, set the per-connection option
  **`stretchAsciiKey: true`** to route the key through PBKDF2-SHA256
  (600,000 iterations, salt `signalk-edge-link-v1`) before it is used as the
  AES-GCM key. PBKDF2 restores full 256-bit AES strength and makes offline
  brute-force significantly more expensive. The derived key is cached per
  process, so there is no steady-state performance penalty. Hex and base64
  keys bypass PBKDF2.
  - **Both ends of the connection must use the same `stretchAsciiKey`
    setting** — mismatched values will fail AES-GCM authentication and drop
    every packet. Treat the flag as part of the key.
  - Default is `false` (raw ASCII bytes used directly) so existing
    deployments are unchanged.
- Avoid copying keys into shell history; use environment variables or secrets managers.
- Rotate keys regularly (for example every 90 days) and after incident response events.
- Do not log plaintext key material.

## Protocol version pinning

- Each server pins to its configured `protocolVersion` (2 or 3) and rejects any
  packet whose header advertises a different version. This prevents a MITM from
  downgrading a v3 session to v2 by injecting forged v2 control frames
  (ACK/NAK/HEARTBEAT/HELLO) — v2 control frames carry no HMAC tag and would
  otherwise be accepted on header parse alone.
- Operators upgrading a peer pair from v2 to v3 must switch both ends; mixed
  versions will log `malformedPackets` increments and the link will not converge.

## Key rotation

- Changing the secret key requires a plugin restart on both client and server.
- There is no online key rotation or key agreement protocol — the same pre-shared key
  is used for the lifetime of a connection session.
- To rotate: update the `secretKey` in the configuration on both ends, then restart
  the plugin. During the transition, packets encrypted with the old key will fail
  authentication and be dropped.

## Future planning

Future online key rotation, key agreement, and protocol migration options are tracked in docs/future-security-and-protocol-roadmap.md.

## Input validation checklist

- Validate configuration against the runtime `plugin.schema` in `src/index.ts`
  (served by the Signal K plugin loader and the admin UI).
- Validate management API payloads for mutable keys and value ranges.
- Drop malformed packets and track drop/error metrics for observability.

## Known limitations

- **No forward secrecy**: The shared secret key is used directly. Compromise of the key
  allows decryption of all past captured traffic.
- **Compression side-channel**: Data is Brotli-compressed before encryption. An observer
  can infer information from ciphertext size differences (similar to CRIME/BREACH attacks
  on TLS). For maritime telemetry data this risk is low, but be aware if transmitting
  sensitive payloads.
- **No client authentication**: Protocol v3 authenticates control packets (ACK/NAK) but
  does not authenticate client identity. Any party with the shared secret key can send
  and receive data.

## Deployment best practices

- Restrict UDP ingress to known peers.
- Keep plugin and Signal K server updated.
- Run management API on trusted networks only.
- Use least-privilege firewall rules between vessel and shore links.

### Firewall examples

Allow UDP ingress only from a specific vessel IP (replace `<VESSEL_IP>` and `<PORT>` with actual values):

**UFW (Ubuntu/Debian):**

```sh
# Allow UDP from vessel IP on the Edge Link port
ufw allow from <VESSEL_IP> to any port <PORT> proto udp

# Deny all other UDP on that port
ufw deny <PORT>/udp
```

**iptables:**

```sh
# Allow UDP from trusted peer
iptables -A INPUT -p udp --dport <PORT> -s <VESSEL_IP> -j ACCEPT

# Drop all other UDP on that port
iptables -A INPUT -p udp --dport <PORT> -j DROP
```

**nftables:**

```sh
nft add rule inet filter input \
  ip saddr <VESSEL_IP> udp dport <PORT> accept

nft add rule inet filter input \
  udp dport <PORT> drop
```

If the vessel IP is dynamic (e.g., cellular), consider restricting by subnet (the operator's APN range) or deploying a VPN to provide a stable peer address.
