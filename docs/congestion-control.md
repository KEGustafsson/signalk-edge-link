# Congestion control guide

Congestion control in Edge Link v2 adapts the sender's data rate to current network quality, keeping data flowing under constrained links without saturating the channel.

## Why it matters

UDP has no built-in congestion feedback. On lossy or high-latency links, a fixed send rate causes:

- packet bursts that overwhelm the channel
- retransmit storms that amplify congestion
- increased end-to-end latency
- dropped navigation updates

v2 congestion control avoids this by continuously adjusting the `deltaTimer` — the interval between data batches — based on live link metrics.

## The AIMD algorithm

Edge Link uses **Additive Increase, Multiplicative Decrease (AIMD)**, the same class of algorithm used by TCP congestion control:

| Condition           | Trigger                                   | Action                            | Effect                     |
| ------------------- | ----------------------------------------- | --------------------------------- | -------------------------- |
| Network healthy     | loss < 1% **and** RTT < `targetRTT`       | `deltaTimer × 0.95`               | Sends 5% faster            |
| Network congested   | loss > 5% **or** RTT > `targetRTT × 1.5` | `deltaTimer × 1.5`                | Sends 50% slower           |
| Neither condition   | loss 1–5% or RTT between target and 1.5× | No change                         | Holds current rate         |

**Cadence:** The controller evaluates and adjusts every 5 seconds.

**Step cap:** Each adjustment is capped at 20% of the current timer value to prevent large swings.

**EMA smoothing:** RTT and loss inputs are smoothed using an exponential moving average (alpha = 0.2) to prevent reacting to transient single-packet spikes.

**Bounds:** The timer stays within `minDeltaTimer` (default 100 ms) and `maxDeltaTimer` (default 5000 ms).

### Example sequence

Starting at `deltaTimer = 1000 ms`, `targetRTT = 200 ms`:

1. RTT = 45 ms, loss = 0% → healthy → timer = 950 ms
2. RTT = 55 ms, loss = 0% → healthy → timer = 903 ms
3. RTT = 320 ms (spike) → RTT > 200 × 1.5 = 300 ms → congested → timer = 1354 ms
4. RTT = 280 ms → neither zone → timer holds at 1354 ms
5. RTT = 90 ms, loss = 0% → healthy → timer = 1287 ms

## Inputs used for adaptation

- **Packet loss / retransmissions** — measured from ACK/NAK sequence tracking
- **Round-trip time (RTT)** — measured from heartbeat probe echoes
- **Jitter** — monitored but does not directly trigger adjustments (visible in `/network-metrics`)
- **Queue depth** — signals send backlog buildup; high depth is treated as a congestion indicator

## Configuration

Congestion control is configured per client connection under the `congestionControl` key:

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

| Key              | Default | Range            | Description                                               |
| ---------------- | ------- | ---------------- | --------------------------------------------------------- |
| `enabled`        | `false` | —                | Enables AIMD automatic adjustment                        |
| `targetRTT`      | `200`   | 50–2000 ms       | RTT above this triggers rate decrease                    |
| `minDeltaTimer`  | `100`   | 50–1000 ms       | Fastest send rate (lower bound)                          |
| `maxDeltaTimer`  | `5000`  | 1000–30000 ms    | Slowest send rate under congestion (upper bound)         |

For full field reference, see `docs/configuration-reference.md` → **Dynamic Congestion Control**.

## Checking state at runtime

```sh
curl -s http://localhost:3000/plugins/signalk-edge-link/congestion | jq .
```

Example response:

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

- `manualMode: false` means the AIMD controller is active.
- `currentDeltaTimer` shows the live send interval in ms.
- `avgRTT` and `avgLoss` are the EMA-smoothed inputs used for decisions.

## Manual override

You can temporarily lock the timer to a fixed value:

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  -d '{"value": 500}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer
```

This sets `manualMode: true` and holds the timer at 500 ms until you re-enable auto mode:

```sh
curl -s -X POST \
  -H "Content-Type: application/json" \
  -H "X-Edge-Link-Token: $EDGE_LINK_TOKEN" \
  -d '{"mode": "auto"}' \
  http://localhost:3000/plugins/signalk-edge-link/delta-timer
```

### When to use manual mode

| Situation                                          | Recommendation                              |
| -------------------------------------------------- | ------------------------------------------- |
| Controlled test or benchmarking                    | Manual mode with fixed value                |
| Link conditions are genuinely stable and predictable | Auto mode with low `targetRTT`            |
| Highly variable link (intermittent cellular)       | Auto mode; increase `maxDeltaTimer`         |
| Congestion control oscillates frequently           | Increase `targetRTT` above your normal RTT  |

## Tuning workflow

1. **Enable with defaults** (`targetRTT: 200`, `minDeltaTimer: 100`, `maxDeltaTimer: 5000`).
2. Observe `GET /congestion` — watch `currentDeltaTimer` and `avgRTT` over a few minutes.
3. If `currentDeltaTimer` is always at `maxDeltaTimer`, your link RTT is consistently above `targetRTT` — increase `targetRTT` to match your normal link RTT.
4. If the timer oscillates rapidly, check `avgLoss` — high sustained loss may require addressing the network path rather than tuning thresholds.
5. Change one parameter at a time and observe for at least 5 minutes before adjusting again.
6. Check `docs/troubleshooting.md` → **Congestion Control Issues** for symptom-based diagnostics.

## Related docs

- `docs/configuration-reference.md` — congestion control field reference
- `docs/protocol-v2.md` — reliability model that congestion control builds on
- `docs/bonding.md` — companion link resilience feature
- `docs/metrics.md` — metrics for monitoring congestion state
- `docs/api-reference.md` — `/congestion` and `/delta-timer` endpoint reference
