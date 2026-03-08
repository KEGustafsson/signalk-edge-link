# Bonding guide

Bonding provides resilience by switching between multiple network paths when link quality degrades.

## Concepts

- **Primary link:** Preferred path during healthy conditions.
- **Backup link(s):** Alternate paths used during failover.
- **Failover threshold:** Quality limit where active path is switched.
- **Failback behavior:** Return to primary once it is stable again.

## API endpoints

- `GET /bonding`
  - Returns aggregate bonding state across instances.
  - Includes active link, enabled state, and threshold-related information where available.

- `POST /bonding`
  - Accepts validated bonding updates (currently threshold-oriented settings).
  - Applies changes across bonding-enabled instances.
  - Rejects unsupported keys/invalid values with `400`.

## Operational notes

- Apply conservative thresholds first, then adjust based on observed RTT/jitter/loss.
- Avoid aggressive flapping by setting thresholds with hysteresis in mind.
- Monitor link-switch frequency to detect unstable policy settings.

## Troubleshooting

- No instances in response: verify connections are configured and running.
- Update rejected: check payload keys and numeric ranges.
- Frequent path switching: increase failover threshold or revisit network path health.

## Related docs

- `docs/protocol-v2.md`
- `docs/congestion-control.md`
- `docs/api-reference.md`
