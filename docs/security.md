# Security Guide

This document captures operational security practices and implementation notes for Signal K Edge Link.

## Crypto primitives in use

- Payload confidentiality and integrity use **AES-256-GCM** (`lib/crypto.js`).
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
- Prefer a reverse proxy with TLS and an allowlist for management endpoints.

## Secret-key handling recommendations

- Generate per-instance keys with CSPRNG output.
- Prefer **64-character hex** or **44-character base64** keys for full 256-bit entropy.
  A 32-character ASCII key provides only ~208 bits of effective entropy.
- Avoid copying keys into shell history; use environment variables or secrets managers.
- Rotate keys regularly (for example every 90 days) and after incident response events.
- Do not log plaintext key material.

## Key rotation

- Changing the secret key requires a plugin restart on both client and server.
- There is no online key rotation or key agreement protocol — the same pre-shared key
  is used for the lifetime of a connection session.
- To rotate: update the `secretKey` in the configuration on both ends, then restart
  the plugin. During the transition, packets encrypted with the old key will fail
  authentication and be dropped.

## Input validation checklist

- Validate configuration against `schemas/config.schema.json`.
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
