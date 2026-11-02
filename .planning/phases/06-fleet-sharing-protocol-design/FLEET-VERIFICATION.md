# v2 Fleet Data Sharing - Verification

**Date:** 2026-11-02
**Branch:** `claude/zen-bell-l5clz3`
**Commits:** `dbe475a` (planning), `89aca48` (spec, Phase 6), `218272c` (transport, Phases 7-8), `eb1743e` (config/metrics/docs, Phases 9-10), `f30c004` (first verification), plus the follow-up commit containing this revision (open items closed).

Phases 7-10 were executed in one pass without separate PLAN/SUMMARY files. This file is their verification record.

## Commands Run

| Command                                              | Result                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------- |
| `npm run check:ts`                                   | Pass                                                                |
| `npm run lint`                                       | Pass (0 warnings)                                                   |
| `npm test`                                           | 137 suites, 2585 tests, all passing                                 |
| `npm run check:ts:webapp`                            | Pass                                                                |
| `npm run smoke:fleet -- <signalk-server 2.35.1 bin>` | 15/15 checks pass: hub + 2 vessels as real signalk-server processes |
| `npm run build`                                      | Pass; webpack asset-size warning for the 304 KiB web bundle         |
| `npm run check:release-docs`                         | Pass                                                                |

## Requirement Evidence

| ID              | Status | Evidence                                                                                                                                                                                                                           |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLEET-PROTO-001 | Met    | `docs/protocol-v3-spec.md` §15; layout tests in `__tests__/v2/fleet-codec.test.js` ("fleet wire layout matches protocol-v3-spec §15")                                                                                              |
| FLEET-PROTO-002 | Met    | `__tests__/v2/fleet-sharing.test.js`: clients have no server socket; hub sends to the client's source port                                                                                                                         |
| FLEET-PROTO-003 | Met    | "a client without fleet sharing never receives fleet packet types"; "a server with fleet sharing off answers 'declined'"                                                                                                           |
| FLEET-PROTO-004 | Met    | "lost FLEET_DATA is recovered by NAK and retransmit; older values never win"                                                                                                                                                       |
| FLEET-PROTO-005 | Met    | Existing v2 suite passes unmodified; "HELLO without a fleet field is byte-identical in its JSON keys"                                                                                                                              |
| FLEET-ID-001    | Met    | "the vessel identity never appears in plaintext on the wire"; "round-trips and hides the vessel context on the wire"                                                                                                               |
| FLEET-ID-002    | Met    | "each vessel receives the other two and never itself"                                                                                                                                                                              |
| FLEET-ID-003    | Met    | "scope 'fleet' excludes AIS targets; scope 'all' includes them"; "includeServerVessel shares the hub's own vessel"                                                                                                                 |
| FLEET-LOOP-001  | Met    | "the client uplink drops contexts learned from the fleet (no echo)"; server side: "origin authority"                                                                                                                               |
| FLEET-SNAP-001  | Met    | "a late-joining vessel gets a snapshot of the fleet"; "join snapshots stay rate-limited across repeated client restarts"                                                                                                           |
| FLEET-BW-001    | Met    | "the per-session byte budget defers values and keeps only the newest"                                                                                                                                                              |
| FLEET-SEC-001   | Met    | "tampered FLEET_DATA is rejected"; "a replayed FLEET_DATA is counted as a duplicate and not applied again"; wrong key / wrong epoch in `fleet-codec.test.js`; real-socket run with `epochBoundAuth` in `real-socket-fleet.test.js` |
| FLEET-SEC-002   | Met    | "a client accepts at most 200 FLEET_DATA per second" (260 sent, ≤200 accepted, ≥60 rejected); option-off client tested                                                                                                             |
| FLEET-SEC-003   | Met    | `docs/security.md` "Fleet sharing" section                                                                                                                                                                                         |
| FLEET-CFG-001   | Met    | `__tests__/fleet-config.test.js`; `PluginConfigurationPanel.test.js` ui:order coverage; `config-docs-parity.test.js` validates `samples/v3-fleet-sharing.json`                                                                     |
| FLEET-CFG-002   | Met    | `fleet-config.test.js` rejects v1 and client bonding                                                                                                                                                                               |
| FLEET-OPS-001   | Met    | `__tests__/fleet-metrics.test.js`; `docs/metrics.md` "Fleet Sharing Metrics"                                                                                                                                                       |
| FLEET-OPS-002   | Met    | `active`, `declined`, `disabled`, and "a server that never answers is reported as 'not-offered' after three HELLOs"; Fleet Sharing card shows the state and its next step (`__tests__/webapp/components/cards/FleetCard.test.tsx`) |
| FLEET-TEST-001  | Met    | In-process hub + 3 clients; `__tests__/v2/real-socket-fleet.test.js` (real UDP sockets, hostname peers, asserted via GET /metrics, two codec sets); `scripts/fleet-smoke.js` against real signalk-server 2.35.1                    |
| FLEET-DOC-001   | Met    | README, configuration reference, metrics, security, troubleshooting, web UI, protocol spec                                                                                                                                         |

## Behavior Added Beyond the Proposal

- Client drops fleet values older than one already applied for the same `(context, $source, path)` (`fleet.staleValues`). Found while testing retransmission: a retransmitted older packet otherwise overwrote a newer value.
- Metadata (FLEET-FUT-002, metadata part): sent inside FLEET_DATA as `updates[].meta` the first time a session receives a `(context, path)`, read from the hub's tree, and forwarded when it changes (spec §15.8). Tests: "metadata travels with a path the first time a vessel receives it", "live metadata changes are forwarded to the other members"; real signalk-server run shows `units: m/s` on the other vessel.
- Loss-adaptive rate (FLEET-FUT-003): per-member factor ×0.7 on NAK or 2 s timeout, at most once per second, recovering +0.05/s after 2 s without loss (spec §15.9). Test: "downlink loss cuts the fleet rate once per burst and it recovers when loss stops".
- Web UI Fleet Sharing card on client and server dashboards.
- Server `fleet.state` reads `active` while sharing runs (it read `disabled`, found in the real signalk-server run).
- The client's fleet loop guard now runs before live-metadata extraction, so fleet metadata is not echoed upstream either.

## Known Limitations and Follow-Up

- Bonded clients cannot use fleet sharing (FLEET-FUT-001; out of scope by decision).
- The `/sources` tree is not copied as such; each update's `source` object and `$source` travel with the values, and the receiver builds its sources from them.
- `scripts/fleet-smoke.js` needs a separately installed signalk-server and is not run in CI.
- No screenshot of the Fleet Sharing card was taken; it is covered by component tests only.

## Rollback

Set `fleetSharing.enabled: false` (or remove the block) on either end. The server then sends no fleet packets and the client sends no fleet capability, so HELLO and the uplink return to their pre-feature bytes. Reverting the commits removes the feature; peers on older versions are unaffected because they never receive fleet packet types.
