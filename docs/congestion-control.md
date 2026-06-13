# Signal K Edge Link — Congestion Control

> AIMD automatic send-rate adaptation for variable-latency links.

---

## Why It's Needed

UDP has no built-in congestion feedback. Without adaptation, a fixed send rate on constrained links causes packet bursts, retransmit storms, and elevated latency. Congestion control is only available in Advanced (v3) mode.

---

## The AIMD Algorithm

**Additive Increase, Multiplicative Decrease (AIMD)** — same class as TCP congestion control:

```text
Every 5 seconds, evaluate smoothed RTT and packet loss:

  ┌─────────────────────────────────────────────────────────────┐
  │  loss < 1% AND RTT < targetRTT     → deltaTimer × 0.95     │
  │                                      (5% faster)           │
  │  loss > 5% OR RTT > targetRTT×1.5  → deltaTimer × 1.50     │
  │                                      (50% slower)          │
  │  otherwise (moderate)              → no change             │
  │                                                             │
  │  Cap: max ±20% per step                                     │
  │  Inputs smoothed: value = 0.2 × new + 0.8 × prev (EMA)    │
  │  Bounds: minDeltaTimer ≤ timer ≤ maxDeltaTimer              │
  └─────────────────────────────────────────────────────────────┘
```

---

## Example Timer Behavior

```text
deltaTimer (ms)
 5000 ─────────────────────────────────────────────────── (max)
                                               ╭─ congestion spike ×1.5
 2000 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─╯
                                          ╭──╯
 1000 ──────────────────────────────╮────╯
                            ╭───────╯
  500 ──────────────────────╯  healthy ×0.95/step
  100 ─────────────────────────────────────────────── (min)
       t=0   t=5s  t=10s  t=15s  t=20s  t=25s  t=30s
```

### Worked example (targetRTT = 200 ms)

| Step  | RTT   | Loss | Decision                | Timer  |
| ----- | ----- | ---- | ----------------------- | ------ |
| t=0   | 45ms  | 0%   | Healthy                 | 950ms  |
| t=5s  | 55ms  | 0%   | Healthy                 | 903ms  |
| t=10s | 320ms | 0%   | Congested (RTT > 300ms) | 1354ms |
| t=15s | 280ms | 0%   | Neutral                 | 1354ms |
| t=20s | 90ms  | 0%   | Healthy                 | 1287ms |

---

## Configuration

```json
{
  "congestionControl": {
    "enabled": true,
    "targetRTT": 200,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 5000
  }
}
```

| Field               | Type    | Default | Range         | Description                                                                  |
| ------------------- | ------- | ------- | ------------- | ---------------------------------------------------------------------------- |
| `enabled`           | boolean | `false` | —             | Enable AIMD automatic delta timer adjustment.                                |
| `targetRTT`         | integer | `200`   | 50–2000 ms    | RTT above this level triggers rate reduction. Set to your link's normal RTT. |
| `nominalDeltaTimer` | integer | `1000`  | 100–10000 ms  | Starting send interval when congestion control is first enabled.             |
| `minDeltaTimer`     | integer | `100`   | 50–1000 ms    | Fastest allowed send rate.                                                   |
| `maxDeltaTimer`     | integer | `5000`  | 1000–30000 ms | Slowest allowed send rate under congestion.                                  |

---

## Checking State at Runtime

```bash
curl http://localhost:3000/plugins/signalk-edge-link/congestion | jq .
```

```json
{
  "enabled": true,
  "manualMode": false,
  "currentDeltaTimer": 850,
  "avgRTT": 45.32,
  "avgLoss": 0.002,
  "targetRTT": 200,
  "minDeltaTimer": 100,
  "maxDeltaTimer": 5000,
  "adjustInterval": 5000,
  "maxAdjustment": 0.2
}
```

---

## Manual Override

```bash
# Lock timer to 500 ms
curl -s -X POST -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"value": 500}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer

# Re-enable automatic mode
curl -s -X POST -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $TOKEN" \
  -d '{"mode": "auto"}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer
```

---

## Tuning Guide

| Symptom                         | Cause                                  | Fix                                              |
| ------------------------------- | -------------------------------------- | ------------------------------------------------ |
| Timer always at `maxDeltaTimer` | `targetRTT` below link's actual RTT    | Increase `targetRTT` to match `avgRTT`           |
| Timer oscillates rapidly        | RTT hovering near threshold            | Increase `targetRTT` by 20–30% above typical RTT |
| Timer won't go below a value    | `minDeltaTimer` too high               | Lower `minDeltaTimer` (watch CPU)                |
| Controller not adapting         | `enabled: false` or `manualMode: true` | Check `GET /congestion`                          |
