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
| `testAddress is only supported on v1 clients` | v1-only fields in v2/v3 config          | Remove `testAddress`, `testPort`, `pingIntervalTime` |
| `Invalid magic bytes`                         | Basic client sending to Advanced server | Set same protocol mode on both ends                  |
| Protocol version mismatch warning             | Mismatched `protocolVersion`            | Set same version on both ends and restart            |

---

## No Data Flowing

```bash
# Client: is it sending anything?
curl http://vessel:3000/plugins/signalk-edge-link/metrics | jq '{sent:.stats.deltasSent,err:.stats.encryptionErrors,ready:.status.readyToSend}'

# Server: is it receiving anything?
curl http://shore:3000/plugins/signalk-edge-link/metrics | jq '{rcvd:.stats.deltasReceived,err:.stats.encryptionErrors}'
```

If `readyToSend` is `false`, check `GET /status` for error details. If `deltasSent` is increasing but `deltasReceived` stays 0, the problem is between the two endpoints (firewall, routing, or key mismatch).

---

## Bonding Not Failing Over

| Symptom                     | Check                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------ |
| Failover not triggering     | Verify `bonding.enabled: true`; check backup is not `"down"` in `GET /bonding`                         |
| Backup shows `"down"`       | Ensure UDP is allowed bidirectionally; server must echo HEARTBEAT probes                               |
| Frequent failover/failback  | Increase `failbackDelay` (try 60 s); increase `rttThreshold`                                           |
| `POST /bonding` returns 400 | Check field names and ranges against [configuration-reference.md §bonding](configuration-reference.md) |

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
