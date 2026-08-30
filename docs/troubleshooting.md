# Signal K Edge Link — Troubleshooting

> Issue-oriented diagnostics and common fixes.

---

## Quick Diagnostic Checklist

1. Both ends running same plugin version? (`npm list signalk-edge-link`)
2. Encryption keys identical on both sides? (32 ASCII, 64 hex, or 44 base64)
3. UDP port open in firewall? (`ufw status` or `iptables -L`)
4. Plugin enabled in Signal K Admin UI?
5. Node.js ≥ 20.9.0? (`node --version`)

---

## Encryption / Decryption Errors

| Symptom                                            | Cause                 | Fix                                                                    |
| -------------------------------------------------- | --------------------- | ---------------------------------------------------------------------- |
| `Unsupported state or unable to authenticate data` | Key mismatch          | Verify keys are identical, same format, same `stretchAsciiKey` setting |
| `Secret key must be exactly 32 characters`         | Wrong key length      | Use 32 ASCII chars, 64 hex chars, or 44 base64 chars                   |
| `Key lacks sufficient diversity`                   | Key too simple        | Use `openssl rand -hex 32`                                             |
| Persistent errors after key change                 | One end not restarted | Restart plugin on both ends                                            |

`encryptionErrors > 0` in `GET /metrics` almost always means the `secretKey` does not match between peers.

---

## Connection Errors

| Symptom                                       | Cause                                   | Fix                                                  |
| --------------------------------------------- | --------------------------------------- | ---------------------------------------------------- |
| `ECONNREFUSED`                                | Server not listening or wrong port      | Verify server running; check `udpPort` matches       |
| `ENETUNREACH`                                 | No route to host                        | Check network connectivity                           |
| `testAddress is only supported on v1 clients` | v1-only fields in a v3 config           | Remove `testAddress`, `testPort`, `pingIntervalTime` |
| `Invalid magic bytes`                         | Basic client sending to Advanced server | Set same protocol mode on both ends                  |
| Protocol version mismatch warning             | Mismatched `protocolVersion`            | Set same version on both ends and restart            |

A plugin status of `N/M active — <name>: <error>` means some connections started
and some did not. Only the named connection is down; it is retried on its own
with 30 s → 300 s backoff while the rest keep running. Fix the reported cause —
usually a `udpPort` already in use or an interface that is not up yet — and the
retry brings it up without a plugin restart. `Startup failed: <error>` means
every connection failed.

---

## No Data Flowing

```bash
# Client: is it sending anything?
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq '{sent:.stats.deltasSent,err:.stats.encryptionErrors,ready:.status.readyToSend}'

# Server: is it receiving anything?
curl http://shore:3000/plugins/signalk-edge-link/metrics | jq '{rcvd:.stats.deltasReceived,err:.stats.encryptionErrors}'
```

If `readyToSend` is `false`, check `GET /status` for error details (include `-H "X-Edge-Link-Token: $TOKEN"` if management auth is enabled). If `deltasSent` is increasing but `deltasReceived` stays 0, the problem is between the two endpoints (firewall, routing, or key mismatch).

---

## Network Quality Shows `N/A`

`N/A` means **not measured**. It is deliberately not shown as `0`, because the
two are different states and reporting them the same way hid real faults: an
unmeasured link scores a perfect 100 ("Excellent"), since zero RTT, zero jitter
and zero loss look ideal to the scoring function.

| Symptom                                              | Cause                                                      | Fix                                                                   |
| ---------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Client: `RTT` / `Jitter` `N/A`, `Queue Depth` rising | No ACK has been timed — traffic leaves, nothing comes back | Check `stats.rejectedControlPackets` (below) and firewall return path |
| Server: every field `N/A`                            | No client telemetry has arrived yet                        | Confirm the client is on 4.0.0+ and its link to this server is up     |
| One field `N/A`, its neighbours populated            | The peer did not report that field                         | Usually an older peer build; upgrade it                               |
| `Link Quality` `N/A` while RTT and jitter show       | One of the four scoring inputs is missing                  | All of RTT, jitter, packet loss and retransmit rate must be present   |

A `0` on this card is a measured zero and can be trusted as one.

**Jitter reading exactly `0 ms` on a server** was a defect before 4.0.0: RTT was
sampled with whole-millisecond resolution, so on a stable link every sample was
the same integer and the variance was exactly zero. Both peers must run 4.0.0+
— a receiver never computes RTT or jitter itself, it reports what the client
sends it.

---

## Rejected Control Packets

`stats.rejectedControlPackets` on a **client** should read `0`. A non-zero value
means ACKs and NAKs are being discarded before they are processed, so no RTT can
be timed, the cumulative ACK freezes and the retransmit queue grows without
bound. The link looks alive from the sending side and delivers nothing reliably.

```bash
curl http://vessel:3000/plugins/signalk-edge-link/metrics \
  | jq '{rejected:.stats.rejectedControlPackets, rtt:.networkQuality.rtt, queue:.networkQuality.queueDepth}'
```

Control packets are only accepted from a configured peer address. The usual
cause is that `udpAddress` does not name the host the server actually replies
from — check especially where a hostname resolves to a different address than
the one the server sends from, or where a NAT rewrites it.

---

## Relay / Proxy Chains

A relay is **two independent connections in one instance**, so diagnose it one
hop at a time. `vessel → relay → shore` is two links that share nothing but the
Signal K tree between them: separate keys, separate handshakes and epochs,
separate reliability settings, and separate `epochBoundAuth` values.

| Symptom                                                    | Which hop          | Fix                                                                       |
| ---------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------- |
| Relay's **server** tab all `N/A`, **client** tab populated | Hop 1 (upstream)   | The vessel is not reporting — check the vessel's client, not the relay    |
| Relay's **client** tab all `N/A`, **server** tab populated | Hop 2 (downstream) | The relay's own link to shore has not measured yet — check that hop       |
| Shore receives nothing, relay's server tab looks healthy   | Hop 2              | Data is arriving at the relay but not leaving it — check the relay client |
| Data arrives at the relay but never reaches shore          | Hop 2              | Check the relay client's key, address and port against the shore server   |

```bash
# Both connections on the relay, in one call — each has its own metrics.
curl http://relay:3000/plugins/signalk-edge-link/connections | jq '.[].id'
curl http://relay:3000/plugins/signalk-edge-link/connections/<id>/metrics \
  | jq '{rtt:.networkQuality.rtt, src:.networkQuality.dataSource, rcvd:.stats.deltasReceived, sent:.stats.deltasSent}'
```

Both routes are auth-gated — include `-H "X-Edge-Link-Token: $TOKEN"` if
management auth is enabled.

`dataSource` tells you which side a figure came from: `remote-client` means it
arrived as peer telemetry (the relay's server tab), `local` means the node
measured it itself (the relay's client tab).

**Both ends of each hop must run 4.0.0+** before that hop reports RTT and
jitter — a receiver never computes them, it reports what its peer sends. A
partially upgraded chain shows figures on the upgraded hops and `N/A` on the
rest.

---

## Epoch-Bound Authentication (`epochBoundAuth`)

| Log message                                                       | Meaning                                                       | Fix                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------- |
| `epoch-bound authentication mismatch: this receiver requires ...` | Real configuration mismatch — the sender is not binding       | Set the same `epochBoundAuth` on **both ends of the hop** |
| `no established epoch for this peer yet` (debug)                  | Sender IS binding; its HELLO has not completed. Clears itself | None if brief. Persisting means HELLO is not arriving     |

`stats.epochAuthMismatches` counts the first; `stats.epochAuthPending` counts
the second. A brief burst of the second at startup is normal — a client whose
first DATA overtakes its own HELLO produces exactly that.

**The setting is asymmetric.** Enforcement lives in the receiver:

| Sender | Receiver | Result                                                                    |
| ------ | -------- | ------------------------------------------------------------------------- |
| off    | off      | Works, no epoch binding                                                   |
| on     | on       | Works, fully protected                                                    |
| on     | off      | Works, but **unprotected** — enabling it on the sender alone buys nothing |
| off    | on       | **Link carries nothing**                                                  |

In a chain each hop is independent: boat→proxy and proxy→cloud must each agree,
but the two hops need not match each other.

> Before 4.0.0 both of these conditions were reported as
> `packet tampered or wrong key` or as a possible `stretchAsciiKey` /
> key-format mismatch. If you are chasing a key problem that does not exist on
> a link where `epochBoundAuth` is enabled anywhere, upgrade first.

---

## Bonding Not Failing Over

| Symptom                     | Check                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Failover not triggering     | Verify `bonding.enabled: true`; check backup is not `"down"` in `GET /bonding`                                                                   |
| Backup shows `"down"`       | Ensure UDP is allowed bidirectionally; server must echo HEARTBEAT probes                                                                         |
| Frequent failover/failback  | Increase `failbackDelay` (try 60 s); increase `rttThreshold`                                                                                     |
| `POST /bonding` returns 400 | Check field names and ranges against [configuration-reference.md §bonding](configuration-reference.md#connection-bonding-client-advancedv3-only) |

---

## Congestion Control Not Adapting

| Symptom                        | Check                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| Timer stays at `maxDeltaTimer` | `targetRTT` is below link's actual RTT — increase it                                      |
| Timer not moving at all        | Verify `congestionControl.enabled: true`; check `GET /congestion` for `manualMode: false` |
| Timer oscillates rapidly       | RTT hovering near `targetRTT` — increase `targetRTT` by 20–30%                            |

---

## Poor Compression Ratio

- Increase `deltaTimer` (more deltas per batch = better ratio; 50 deltas achieves ~21× vs ~1× for single deltas)
- Enable `useMsgpack: true` and `usePathDictionary: true`
- Add `sentence_filter.json` to exclude high-frequency NMEA sentences (`GSV`, `GSA`, `VTG`)
- Verify `oversizedPackets` counter stays 0

---

## Installation Issues

- Plugin not loading: run `npm install && npm run build` in the plugin directory; check Node.js version
- Web UI blank: run `npm run build`; verify `public/` directory exists; clear browser cache

---

## Debug Commands

```bash
H=http://localhost:3000/plugins/signalk-edge-link
TOKEN="your-token"

curl -s -H "X-Edge-Link-Token: $TOKEN" $H/metrics | jq .
curl -s -H "X-Edge-Link-Token: $TOKEN" $H/network-metrics | jq .
curl -s $H/congestion | jq .
curl -s -H "X-Edge-Link-Token: $TOKEN" $H/bonding | jq .
curl -s -H "X-Edge-Link-Token: $TOKEN" $H/monitoring/alerts | jq .
curl -s $H/prometheus
curl -s -X POST -H "X-Edge-Link-Token: $TOKEN" $H/capture/start
curl -o capture.pcap $H/capture/export
```

---

## Getting Help

1. Enable debug logging in Signal K plugin settings
2. Collect `GET /metrics` and `GET /network-metrics` output
3. Include your configuration (redact the `secretKey`)
4. Open an issue at https://github.com/KEGustafsson/signalk-edge-link/issues
