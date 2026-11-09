# Signal K Edge Link — Congestion Control

> Automatic adjustment of the client's send interval (`deltaTimer`) from measured RTT and packet loss. Client connections in Advanced (v3) mode only; on Basic (v1) the setting is ignored with the log `Congestion control requires Protocol v2 – ignoring`. Field defaults and ranges are in [configuration-reference.md](configuration-reference.md#congestion-control-client-advancedv3-only).

---

## Algorithm

The controller multiplies the timer by a factor chosen by band, and outside the congested band moves it toward a nominal interval. There is no additive step. Source: `src/transport/congestion.ts`.

Inputs come from each ACK: the current loss ratio, and an RTT sample only when the acknowledged sequence is still in the retransmit queue and was never retransmitted. Other ACKs update loss but not RTT. Both are smoothed as `0.2 × new + 0.8 × previous`; the first sample is taken as is. The controller does nothing until it has a sample.

Every 5000 ms (`adjustInterval`) it compares smoothed RTT and loss with `targetRTT` and picks one of three bands:

| Band      | Condition                                 | Timer change                                                                 |
| --------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| Congested | loss > 5% or RTT > `targetRTT × 1.5`      | × 1.5 (slower sending)                                                       |
| Healthy   | loss < 1% and 0 < RTT < `targetRTT × 0.8` | Toward nominal: × 0.95 if above it, × 1.05 if below it, unchanged at nominal |
| Middle    | anything else                             | Toward nominal: × 0.98 if above it, × 1.02 if below it                       |

Then:

1. One step changes the timer by at most 20% (`maxAdjustment`), so × 1.5 becomes × 1.2.
2. The result is clamped to `minDeltaTimer`–`maxDeltaTimer` and rounded to whole milliseconds. The clamp comes after the 20% cap, so a timer outside the bounds (for example a manual value below `minDeltaTimer`) jumps to the bound in one step.

Nominal is `nominalDeltaTimer`, clamped to `minDeltaTimer`–`maxDeltaTimer`. If it is not set, nominal is the `deltaTimer` the connection started with (from `delta_timer.json`, default 1000 ms). When nominal equals `minDeltaTimer`, a healthy link always steps × 0.95, driving the timer down to the minimum. The steps are multiplicative and rounded, so the timer can alternate within a few percent of nominal instead of landing on it.

The controller's timer starts at 1000 ms. When it changes, it becomes the connection's send interval. Editing `delta_timer.json` while the controller runs changes the send interval until the controller next changes its timer.

### Worked example

`targetRTT` 200 ms (congested above 300 ms, healthy below 160 ms), nominal 1000 ms, RTT and loss already smoothed:

| Step  | RTT    | Loss | Band      | Timer                           |
| ----- | ------ | ---- | --------- | ------------------------------- |
| t=0   | 45 ms  | 0%   | Healthy   | 1000 ms (at nominal, unchanged) |
| t=5s  | 320 ms | 0%   | Congested | 1200 ms (× 1.5 capped at × 1.2) |
| t=10s | 320 ms | 0%   | Congested | 1440 ms                         |
| t=15s | 180 ms | 0%   | Middle    | 1411 ms (× 0.98)                |
| t=20s | 90 ms  | 0%   | Healthy   | 1340 ms (× 0.95)                |

---

## Configuration

```json
{
  "congestionControl": {
    "enabled": true,
    "targetRTT": 200,
    "nominalDeltaTimer": 1000,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 5000
  }
}
```

Set `targetRTT` to the link's normal RTT. `minDeltaTimer` must not exceed `maxDeltaTimer`.

---

## Checking State at Runtime

`GET /congestion` returns the state of the first client connection (404 on a server-only node; token required when one is set):

```bash
curl -s -H "X-Edge-Link-Token: $TOKEN" http://localhost:3000/plugins/signalk-edge-link/congestion | jq .
```

```json
{
  "enabled": true,
  "manualMode": false,
  "currentDeltaTimer": 850,
  "nominalDeltaTimer": 1000,
  "avgRTT": 45.32,
  "avgLoss": 0.002,
  "targetRTT": 200,
  "minDeltaTimer": 100,
  "maxDeltaTimer": 5000,
  "adjustInterval": 5000,
  "maxAdjustment": 0.2
}
```

`avgRTT` and `avgLoss` are the smoothed inputs.

---

## Manual Override

`POST /delta-timer` with `value` (100–10000 ms) sets the send interval and puts the controller in manual mode, where it stops adjusting. `{"mode": "auto"}` resumes automatic mode. Manual mode is held in memory only.

```bash
# Lock the timer to 500 ms → {"deltaTimer": 500, "mode": "manual"}
curl -s -X POST -H "Content-Type: application/json" -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"value": 500}' http://localhost:3000/plugins/signalk-edge-link/delta-timer

# Back to automatic → {"deltaTimer": <current>, "mode": "auto"}
curl -s -X POST -H "Content-Type: application/json" -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"mode": "auto"}' http://localhost:3000/plugins/signalk-edge-link/delta-timer
```

---

## Tuning Guide

| Symptom                         | Cause                                  | Fix                                                                                                                                                        |
| ------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Timer always at `maxDeltaTimer` | `targetRTT` below the link's real RTT  | Raise `targetRTT` to match `avgRTT`                                                                                                                        |
| Timer oscillates                | RTT hovering near the threshold        | Raise `targetRTT` 20–30% above typical RTT                                                                                                                 |
| Timer will not go below a value | `minDeltaTimer` or nominal too high    | Lower `minDeltaTimer` or `nominalDeltaTimer` (watch CPU)                                                                                                   |
| Controller not adapting         | `enabled: false` or `manualMode: true` | Check `GET /congestion`. If `enabled` is `false`, set `congestionControl.enabled` in the client config; if `manualMode` is `true`, send `{"mode": "auto"}` |
