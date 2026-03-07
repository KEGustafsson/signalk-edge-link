# Congestion control guide

Congestion control in Edge Link v2 adapts sender behavior to current network quality to keep data flowing under constrained links.

## Why it matters

UDP has no built-in congestion feedback. On lossy or high-latency links, fixed-rate sending can cause:

- packet bursts,
- retransmit storms,
- increased latency,
- dropped updates.

v2 congestion control mitigates this by reacting to live metrics.

## Inputs used for adaptation

Typical signals include:

- packet loss / retransmissions,
- round-trip time (RTT),
- jitter,
- queue depth / send backlog.

## Practical behavior

Depending on observed conditions, sender-side behavior can adjust to:

- reduce effective send pressure,
- limit batch/window aggressiveness,
- stabilize packet delivery before scaling up again.

## Tuning workflow

1. Start with defaults.
2. Observe metrics over real link conditions.
3. Adjust thresholds conservatively.
4. Re-check retransmission and latency trends before further tuning.

## Related docs

- `docs/protocol-v2.md`
- `docs/bonding.md`
- `docs/architecture-overview.md`
