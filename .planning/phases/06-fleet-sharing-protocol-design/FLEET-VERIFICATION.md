# v2 Fleet Data Sharing - Verification

**Date:** 2026-11-02
**Branch:** `claude/zen-bell-l5clz3`
**Commits:** `dbe475a` (planning), `89aca48` (spec, Phase 6), `218272c` (transport, Phases 7-8), `eb1743e` (config/metrics/docs, Phases 9-10), plus the verification commit containing this file.

Phases 7-10 were executed in one pass without separate PLAN/SUMMARY files. This file is their verification record.

## Commands Run

| Command                      | Result                                                      |
| ---------------------------- | ----------------------------------------------------------- |
| `npm run check:ts`           | Pass                                                        |
| `npm run lint`               | Pass (0 warnings)                                           |
| `npm test`                   | 135 suites, 2569 tests, all passing                         |
| `npm run build`              | Pass; webpack asset-size warning for the 304 KiB web bundle |
| `npm run check:release-docs` | Pass                                                        |

## Requirement Evidence

| ID              | Status  | Evidence                                                                                                                                                             |
| --------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FLEET-PROTO-001 | Met     | `docs/protocol-v3-spec.md` §15; layout tests in `__tests__/v2/fleet-codec.test.js` ("fleet wire layout matches protocol-v3-spec §15")                                |
| FLEET-PROTO-002 | Met     | `__tests__/v2/fleet-sharing.test.js`: clients have no server socket; hub sends to the client's source port                                                           |
| FLEET-PROTO-003 | Met     | "a client without fleet sharing never receives fleet packet types"; "a server with fleet sharing off answers 'declined'"                                             |
| FLEET-PROTO-004 | Met     | "lost FLEET_DATA is recovered by NAK and retransmit; older values never win"                                                                                         |
| FLEET-PROTO-005 | Met     | Existing v2 suite passes unmodified; "HELLO without a fleet field is byte-identical in its JSON keys"                                                                |
| FLEET-ID-001    | Met     | "the vessel identity never appears in plaintext on the wire"; "round-trips and hides the vessel context on the wire"                                                 |
| FLEET-ID-002    | Met     | "each vessel receives the other two and never itself"                                                                                                                |
| FLEET-ID-003    | Met     | "scope 'fleet' excludes AIS targets; scope 'all' includes them"; "includeServerVessel shares the hub's own vessel"                                                   |
| FLEET-LOOP-001  | Met     | "the client uplink drops contexts learned from the fleet (no echo)"; server side: "origin authority"                                                                 |
| FLEET-SNAP-001  | Met     | "a late-joining vessel gets a snapshot of the fleet"; "join snapshots stay rate-limited across repeated client restarts"                                             |
| FLEET-BW-001    | Met     | "the per-session byte budget defers values and keeps only the newest"                                                                                                |
| FLEET-SEC-001   | Partial | Tamper: "tampered FLEET_DATA is rejected"; wrong key / wrong epoch: `fleet-codec.test.js`. No end-to-end test of a replayed FLEET_DATA through the client.           |
| FLEET-SEC-002   | Partial | Option-off client tested. The 200 packets/s inbound cap is implemented (`reliable-client/fleet.ts`) but has no test.                                                 |
| FLEET-SEC-003   | Met     | `docs/security.md` "Fleet sharing" section                                                                                                                           |
| FLEET-CFG-001   | Met     | `__tests__/fleet-config.test.js`; `PluginConfigurationPanel.test.js` ui:order coverage; `config-docs-parity.test.js` validates `samples/v3-fleet-sharing.json`       |
| FLEET-CFG-002   | Met     | `fleet-config.test.js` rejects v1 and client bonding                                                                                                                 |
| FLEET-OPS-001   | Met     | `__tests__/fleet-metrics.test.js`; `docs/metrics.md` "Fleet Sharing Metrics"                                                                                         |
| FLEET-OPS-002   | Partial | `active`, `declined`, `disabled` tested via metrics. `not-offered` is not tested. The web UI dashboard does not display `fleet.state`; it is in `GET /metrics` only. |
| FLEET-TEST-001  | Partial | In-process hub + 3 clients pass. Not run against real UDP sockets or a real signalk-server.                                                                          |
| FLEET-DOC-001   | Met     | README, configuration reference, metrics, security, troubleshooting, web UI, protocol spec                                                                           |

## Behavior Added Beyond the Proposal

- Client drops fleet values older than one already applied for the same `(context, $source, path)` (`fleet.staleValues`). Found while testing retransmission: a retransmitted older packet otherwise overwrote a newer value.

## Known Limitations and Follow-Up

- Bonded clients cannot use fleet sharing (FLEET-FUT-001).
- Metadata and `/sources` are not shared (FLEET-FUT-002).
- No adaptive congestion control on the fleet direction (FLEET-FUT-003).
- Follow-up tests: inbound rate cap, `not-offered` transition, replayed FLEET_DATA end to end, a real-socket run between two signalk-server instances.
- Web UI: show `fleet.state` and member count on the connection card.

## Rollback

Set `fleetSharing.enabled: false` (or remove the block) on either end. The server then sends no fleet packets and the client sends no fleet capability, so HELLO and the uplink return to their pre-feature bytes. Reverting the commits removes the feature; peers on older versions are unaffected because they never receive fleet packet types.
