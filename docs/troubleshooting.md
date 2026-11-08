# Signal K Edge Link — Troubleshooting

> Symptoms, causes and fixes, grouped by area. Settings are defined in [configuration-reference.md](configuration-reference.md); metrics in [metrics.md](metrics.md).

The `curl` examples use these variables. The token header is needed only when `managementApiToken` is set, and then every route requires it ([management-tools.md](management-tools.md#authentication)).

Over plain HTTP the token is readable by anyone on the network path. For the remote hosts below (`vessel`, `shore`, `relay`), use HTTPS or an SSH tunnel such as `ssh -L 3000:localhost:3000 vessel` and query `localhost`.

```bash
H=http://localhost:3000/plugins/signalk-edge-link
T="X-Edge-Link-Token: $SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN"
```

---

## Quick Diagnostic Checklist

1. Compatible plugin versions on both ends (`npm list signalk-edge-link`): the same mode, and 4.0.0+ if `epochBoundAuth` is on, 4.4.0+ for fleet sharing.
2. Same encryption key on both ends: 32 ASCII, 64 hex or 44 base64 characters.
3. UDP port open in the firewall: `ufw status` or `iptables -L`.
4. Plugin enabled in the Signal K Admin UI.
5. Node.js 24 or later: `node --version`.

---

## Connection Errors

| Symptom                                       | Cause                                   | Fix                                                                              |
| --------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| `ECONNREFUSED`                                | Server not listening, or wrong port     | Check the server is running and `udpPort` matches on both ends                   |
| `ENETUNREACH`                                 | No route to host                        | Check network connectivity                                                       |
| `testAddress is only supported on v1 clients` | v1-only fields in a v3 config           | Remove `testAddress`, `testPort` and `pingIntervalTime`                          |
| `Invalid magic bytes`                         | Basic client sending to Advanced server | Set the same protocol on both ends                                               |
| `protocol version mismatch` in the log        | Different `protocolVersion` on the ends | Set the same version on both ends and restart                                    |
| Plugin status `N/M active — <name>: <error>`  | Only the named connection failed        | Fix the reported cause (see below); the retry brings it up without a restart     |
| Plugin status `Startup failed: <error>`       | Every connection failed                 | Fix the reported cause                                                           |
| No data flowing                               | See the commands below                  | `deltasSent` rising and `deltasReceived` at 0: firewall, routing or key mismatch |

A failed connection is retried on its own, with backoff from 30 s to 300 s, while the other connections keep running. The usual causes are a `udpPort` already in use or a network interface that is not up yet.

```bash
# Client: is it sending?
curl -s -H "$T" http://vessel:3000/plugins/signalk-edge-link/metrics \
  | jq '{sent:.stats.deltasSent,err:.stats.encryptionErrors,ready:.status.readyToSend}'

# Server: is it receiving?
curl -s -H "$T" http://shore:3000/plugins/signalk-edge-link/metrics \
  | jq '{rcvd:.stats.deltasReceived,err:.stats.encryptionErrors}'
```

If `readyToSend` is `false`, `GET /status` shows the error.

---

## Encryption / Decryption Errors

| Symptom                                                                       | Cause                                                     | Fix                                                                                |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `Unsupported state or unable to authenticate data`; `encryptionErrors` rising | Key mismatch                                              | Use the identical key, in the same format, with the same `stretchAsciiKey` setting |
| `possible stretchAsciiKey or key-format mismatch between peers`               | Packet failed authentication                              | Same as above                                                                      |
| `Secret key must be exactly 32 bytes`                                         | Wrong key length                                          | Use 32 ASCII, 64 hex or 44 base64 characters                                       |
| `Base64 key decoded to N bytes; expected 32`                                  | Malformed base64 key                                      | Generate a new one with `openssl rand -base64 32`                                  |
| `Secret key has insufficient diversity` or `insufficient entropy`             | Key too simple (repeats, long runs, under 8 unique chars) | Generate one with `openssl rand -hex 32`                                           |
| Errors persist after a key change                                             | One end not restarted                                     | Restart the plugin on both ends                                                    |
| `authenticatedHeaders mismatch`                                               | One end has `authenticatedHeaders` off                    | Set the same `authenticatedHeaders` on both ends                                   |

`encryptionErrors > 0` in `GET /metrics` almost always means the `secretKey` differs between the peers. Key formats and settings are in [security.md](security.md#key-formats).

---

## Advanced (v3)

### Network quality shows `N/A`

`N/A` means not measured. It is not shown as `0` because an unmeasured link would score 100 ("Excellent"): zero RTT, jitter and loss look ideal to the scoring function. A `0` on the card is a measured zero.

| Symptom                                              | Cause                                                     | Fix                                                                                                            |
| ---------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Client: `RTT` / `Jitter` `N/A`, `Queue Depth` rising | No ACK has been timed: traffic leaves, nothing comes back | Check `stats.rejectedControlPackets` (below) and the firewall return path                                      |
| Server: every field `N/A`                            | No client telemetry has arrived yet                       | Confirm the client runs 4.0.0+ and its link to this server is up                                               |
| One field `N/A`, its neighbours populated            | The peer did not report that field                        | Usually an older peer build; upgrade it                                                                        |
| `Link Quality` `N/A` while RTT and jitter show       | One of the four scoring inputs is missing                 | RTT, jitter, packet loss and retransmit rate must all be present                                               |
| Server jitter exactly `0 ms`                         | Peer before 4.0.0 sampled RTT in whole milliseconds       | Upgrade both peers to 4.0.0+; a receiver reports what the client sends and never computes RTT or jitter itself |

### Rejected control packets

`stats.rejectedControlPackets` on a client should be `0`. The counter is cumulative, so a single old rejection leaves it non-zero. A rising value means control packets from a source other than `udpAddress` are being dropped. Those can be the server's ACKs and NAKs, but need not be; check whether the cumulative ACK still advances and `queueDepth` stays low before treating the link as stalled. If replies are being dropped, make `udpAddress` match the address the server replies from.

```bash
curl -s -H "$T" $H/metrics \
  | jq '{rejected:.stats.rejectedControlPackets, rtt:.networkQuality.rtt, queue:.networkQuality.queueDepth}'
```

Control packets are accepted only from the configured peer address. The usual cause is a `udpAddress` that does not name the host the server replies from: a hostname that resolves to a different address, or a NAT that rewrites it.

### Epoch-bound authentication (`epochBoundAuth`)

| Log message                                                       | Meaning                                               | Fix                                                                  |
| ----------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `epoch-bound authentication mismatch: this receiver requires ...` | Configuration mismatch: the sender is not binding     | Set the same `epochBoundAuth` on both ends of the hop                |
| `no established epoch for this peer yet` (debug)                  | The sender binds, but its HELLO has not completed yet | None if brief; clears itself. Persisting means HELLO is not arriving |
| `packet tampered or wrong key` on a link with `epochBoundAuth`    | A peer before 4.0.0 reports both conditions this way  | Upgrade both peers before chasing a key problem                      |

`stats.epochAuthMismatches` counts the first message, `stats.epochAuthPending` the second. A short burst of the second at startup is normal: a client's first DATA can overtake its own HELLO.

Enforcement is in the receiver:

| Sender | Receiver | Result                                                               |
| ------ | -------- | -------------------------------------------------------------------- |
| off    | off      | Works, no epoch binding                                              |
| on     | on       | Works, protected                                                     |
| on     | off      | Works, but unprotected: enabling it on the sender alone does nothing |
| off    | on       | Link carries nothing                                                 |

In a relay chain each hop must agree on its own; the two hops need not match each other.

### Congestion control not adapting

| Symptom                                                  | Cause                                 | Fix                                                                                  |
| -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------ |
| Log `Congestion control requires Protocol v2 – ignoring` | Connection is Basic (v1)              | Set `protocolVersion: 3` on both ends                                                |
| Timer stays at `maxDeltaTimer`                           | `targetRTT` below the link's real RTT | Raise `targetRTT` to the `avgRTT` shown by `GET /congestion`                         |
| Timer not moving                                         | Disabled, or in manual mode           | Check `congestionControl.enabled: true` and `manualMode: false` in `GET /congestion` |
| Timer oscillates                                         | RTT hovers near the threshold         | Raise `targetRTT` 20–30% above typical RTT                                           |

See [congestion-control.md](congestion-control.md#tuning-guide) for the full tuning table.

---

## Bonding Not Failing Over

| Symptom                                                  | Check                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Log `Connection bonding requires Protocol v2 – ignoring` | The connection is Basic (v1); set `protocolVersion: 3`                                                                                                                                                 |
| Failover not triggering                                  | `bonding.enabled: true`; the backup is not `"down"` in `GET /bonding` (no failover to a down backup)                                                                                                   |
| Degraded primary does not fail over at once              | Expected: high RTT or loss fails over only once the primary has been active for 5 s; a down primary fails over at once                                                                                 |
| Backup shows `"down"`                                    | UDP must pass in both directions. The server connection on that port echoes heartbeat probes only if it has the client's `secretKey` (unverified probes are dropped and counted in `malformedPackets`) |
| Frequent failover/failback                               | Raise `failbackDelay` (try 60 s) and `rttThreshold`                                                                                                                                                    |
| `POST /bonding` returns 400                              | The body is empty or has a key or value outside the [`POST /bonding`](api-reference.md#bonding-endpoints) field list; the response `error` says which                                                  |
| `fleetSharing is not supported together with bonding`    | Fleet sharing and bonding cannot be enabled on the same client connection                                                                                                                              |

See [bonding.md](bonding.md).

---

## Fleet Sharing

`GET /connections/<id>/metrics` → `fleet.state` on a client tells you which end to look at. The fields are defined in [Fleet Sharing Metrics](metrics.md#fleet-sharing-metrics).

| `fleet.state` | Meaning                                                                                                      | Fix                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `offered`     | Fleet sharing is pending; the server has not answered yet                                                    | Normal for a few seconds after start, and after a minute without fleet data while the client asks again. Persisting: the client sends no fleet request until it knows its own vessel ID; check that `mmsi`, `uuid` or the Signal K `self` alias is set |
| `declined`    | The server has `fleetSharing.enabled` off, or refused this vessel's ID because it is the server's own vessel | Enable it on the server connection. If it is enabled, check that this vessel's MMSI or UUID differs from the server's (`fleet.identityRejected` rises on the server)                                                                                   |
| `not-offered` | Three HELLOs got no answer                                                                                   | See below. The uplink keeps working either way                                                                                                                                                                                                         |
| `active`      | The server accepted fleet sharing and the client uses its fleet stream                                       | Other vessels appear once they are members and uplink data; see the symptoms below                                                                                                                                                                     |

`not-offered` has three causes:

- Uplink also shows no traffic: nothing reaches the server. Check the server address and port, firewalls on the path, and that the server is running. The client keeps sending a HELLO every 60 s, so a server unreachable at start-up is picked up once it answers.
- Uplink works: the server runs a version without fleet sharing. Upgrade it to 4.4.0 or later.
- The hub cannot yet resolve its own vessel ID (no `mmsi` or `uuid`) and `includeServerVessel` is off: it leaves fleet requests unanswered until it can. Its `fleet.helloDeferred` rises and it logs a warning naming the cause.

| Symptom                                                             | Check                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active` but no other vessels appear                                | Server `fleet.members` ≥ 2, or ≥ 1 when `includeServerVessel: true` and you expect only the hub's own vessel? A vessel appears only once it is a member and uplinks data. With scope `fleet`, AIS targets are not shared                                                                                                                                                                                                                     |
| Some paths missing                                                  | Client and server `fleetSharing.pathFilter` both apply; `networking.edgeLink.*` is never shared                                                                                                                                                                                                                                                                                                                                              |
| Values update slowly, `fleet.minRateFactor` < 1                     | A member's downlink is losing packets and its rate is cut; it recovers by itself once loss stops                                                                                                                                                                                                                                                                                                                                             |
| Values update slowly, `fleet.rateLimitedFlushes` rising at factor 1 | Raise `maxBytesPerSec` on the server, and the client's requested value if set. Every FLEET_DATA packet uses the byte budget for its full length, so a packet longer than the 1400-byte target delays the values queued after it by about its length divided by the session rate                                                                                                                                                              |
| `fleet.packetsAbandoned` rising on the server                       | FLEET_DATA was given up because its retransmits ran out (sustained loss on that member's downlink), it was evicted from a full retransmit queue, or the packet for a single value, fully encoded, would exceed the 65,507-byte UDP limit and can never be sent. For the last case, find the path whose value produces that packet and leave it out with `fleetSharing.pathFilter`                                                            |
| Data stops after a while, resumes within a minute                   | The vessel's NAT mapping expired. The client's outbound packets, including its heartbeats, keep the mapping open, and fleet data reaches the vessel only while it is open. Lower `heartbeatInterval` (default 25000 ms) below the NAT's UDP timeout. If the mapping moved to a new port (common on mobile networks), the uplink and fleet data both resume when the client re-runs HELLO, after 30 s without ACKs or 60 s without fleet data |
| `fleet.originDrops` rising on the server                            | A client relays another member's vessel (for example an AIS copy). Expected and harmless: the member's own data wins                                                                                                                                                                                                                                                                                                                         |
| `fleet.identityConflicts` rising                                    | Two sessions claim the same vessel: duplicate `mmsi` across vessels, or one vessel with two client connections to this server                                                                                                                                                                                                                                                                                                                |
| `fleetSharing` gone after saving; no Fleet card                     | That node runs a version before 4.4.0, which does not know the setting and drops it on save. Upgrade every node, relays included, to 4.4.0 or later                                                                                                                                                                                                                                                                                          |
| Vessels behind a relay missing at other vessels                     | Upstream they are the relay's uplink data, not members. Set the upstream server's scope to `all`, or connect those vessels to the upstream server directly. See [Relays](configuration-reference.md#fleet-sharing-advancedv3-only)                                                                                                                                                                                                           |
| Relay's local vessels do not get upstream vessels                   | The relay's server connection shares only its own members with scope `fleet`. Set it to `all`, and enable fleet sharing on the relay's client connection so the upstream fleet reaches the relay                                                                                                                                                                                                                                             |

---

## Relay / Proxy Chains

A relay is two independent connections in one instance. `vessel → relay → shore` is two links that share only the Signal K tree: separate keys, handshakes and epochs, reliability settings and `epochBoundAuth` values. Diagnose one hop at a time.

| Symptom                                                    | Hop                | Fix                                                                                                                                                                           |
| ---------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Relay's **server** tab all `N/A`, **client** tab populated | Hop 1 (upstream)   | The vessel is not reporting: check the vessel's client, not the relay                                                                                                         |
| Relay's **client** tab all `N/A`, **server** tab populated | Hop 2 (downstream) | The relay's own link to shore has not measured yet: check that hop                                                                                                            |
| Shore receives nothing, relay's server tab looks healthy   | Hop 2              | Data arrives at the relay but does not leave it: check the relay client                                                                                                       |
| Data arrives at the relay but never reaches shore          | Hop 2              | Check the relay client's key, address and port against the shore server                                                                                                       |
| A hop's server side `N/A`, its client side populated       | That hop           | The client measures RTT locally from timed ACKs; the server shows only what the client reports. Check that both ends run 4.0.0+ and the client's telemetry reaches the server |

```bash
# Each connection on the relay has its own metrics.
curl -s -H "$T" http://relay:3000/plugins/signalk-edge-link/connections | jq '.[].id'
id="relay-client"   # one of the IDs listed above
curl -s -H "$T" "http://relay:3000/plugins/signalk-edge-link/connections/$id/metrics" \
  | jq '{rtt:.networkQuality.rtt, src:.networkQuality.dataSource, rcvd:.stats.deltasReceived, sent:.stats.deltasSent}'
```

`dataSource` says where a figure came from: `remote-client` means peer telemetry (the relay's server tab), `local` means measured by this node (the relay's client tab).

---

## Management API

| Symptom                                                                                  | Cause                                                     | Fix                                                                                     |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `401` on every route, Prometheus scrape failing                                          | A `managementApiToken` is set, so every route requires it | Send the token in `X-Edge-Link-Token` or `Authorization: Bearer`; update scrape configs |
| `403` on every route                                                                     | `requireManagementApiToken: true` and no token configured | Configure a token                                                                       |
| `429`                                                                                    | More than 120 requests per minute from one IP             | Poll less often                                                                         |
| `503 Plugin not started`                                                                 | The plugin is stopped or still starting                   | Enable or restart the plugin                                                            |
| `404 Not available in server mode` on `/congestion`, `/delta-timer`, `/bonding/failover` | Those routes need a client connection                     | Call them on the client node                                                            |

Details: [management-tools.md](management-tools.md), [api-reference.md](api-reference.md).

### Debug commands

```bash
curl -s -H "$T" $H/metrics | jq .
curl -s -H "$T" $H/network-metrics | jq .
curl -s -H "$T" $H/congestion | jq .
curl -s -H "$T" $H/bonding | jq .
curl -s -H "$T" $H/monitoring/alerts | jq .
curl -s -H "$T" $H/prometheus
curl -s -X POST -H "$T" $H/capture/start
curl -s -H "$T" -o capture.pcap $H/capture/export
```

Captures contain sensitive data; see [security.md](security.md#packet-capture-is-sensitive-data).

---

## Poor Compression Ratio

- Raise `deltaTimer` so each packet carries more deltas: 50 deltas compress about 21×, a single delta about 1× ([performance-tuning.md](performance-tuning.md#compression-and-batching)).
- Enable `useMsgpack: true` and `usePathDictionary: true` on both ends.
- Exclude high-rate NMEA sentences (`GSV`, `GSA`, `VTG`) in `sentence_filter.json`.
- Check that `oversizedPackets` stays 0.

---

## Installation Issues

| Symptom            | Fix                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------- |
| Plugin not loading | Run `npm install && npm run build` in the plugin directory; check the Node.js version |
| Web UI blank       | Run `npm run build`; check that `public/` exists; clear the browser cache             |

---

## Getting Help

1. Enable debug logging in the Signal K plugin settings.
2. Collect `GET /metrics` and `GET /network-metrics` output.
3. Include your configuration with `secretKey` and tokens removed.
4. Open an issue at https://github.com/KEGustafsson/signalk-edge-link/issues.
