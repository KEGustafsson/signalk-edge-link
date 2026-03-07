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
- Avoid copying keys into shell history; use environment variables or secrets managers.
- Rotate keys regularly (for example every 90 days) and after incident response events.
- Do not log plaintext key material.

## Input validation checklist

- Validate configuration against `schemas/config.schema.json`.
- Validate management API payloads for mutable keys and value ranges.
- Drop malformed packets and track drop/error metrics for observability.

## Deployment best practices

- Restrict UDP ingress to known peers.
- Keep plugin and Signal K server updated.
- Run management API on trusted networks only.
- Use least-privilege firewall rules between vessel and shore links.
