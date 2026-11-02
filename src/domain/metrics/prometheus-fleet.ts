"use strict";

/** Prometheus output for fleet sharing counters (protocol-v3-spec §15). */

import type { Metrics } from "../../foundation/types";

/** The emitter surface this module needs from prometheus.ts. */
export interface FleetMetricSink {
  gauge(name: string, help: string, value: number): void;
  counter(name: string, help: string, value: number): void;
}

/**
 * Fleet sharing (protocol-v3-spec §15). Emitted only while fleet sharing runs
 * on this instance. No vessel or path labels: identities stay out of scrapes
 * and series count stays fixed.
 */
export function emitFleet(e: FleetMetricSink, metrics: Metrics): void {
  const fleet = metrics.fleet;
  if (!fleet) {
    return;
  }
  e.gauge("fleet_members", "Sessions currently accepted into the fleet", fleet.members);
  e.gauge(
    "fleet_active",
    "1 when this client's fleet stream is active",
    fleet.state === "active" ? 1 : 0
  );
  e.gauge("fleet_contexts_known", "Fleet vessels this client has received", fleet.contextsKnown);
  e.gauge(
    "fleet_min_rate_factor",
    "Lowest loss-adaptive rate factor among members (1 = configured rate)",
    fleet.minRateFactor
  );
  const counters: Array<[string, string, number]> = [
    ["fleet_packets_sent_total", "FLEET_DATA packets sent", fleet.packetsSent],
    ["fleet_bytes_sent_total", "FLEET_DATA bytes sent", fleet.bytesSent],
    ["fleet_values_sent_total", "Values sent over the fleet channel", fleet.valuesSent],
    ["fleet_retransmits_total", "FLEET_DATA retransmissions", fleet.retransmits],
    ["fleet_rate_backoffs_total", "Loss-driven fleet rate cuts", fleet.rateBackoffs],
    [
      "fleet_rate_limited_flushes_total",
      "Fleet flushes deferred by the byte budget",
      fleet.rateLimitedFlushes
    ],
    [
      "fleet_origin_drops_total",
      "Uplink deltas dropped: context owned by another member",
      fleet.originDrops
    ],
    [
      "fleet_identity_conflicts_total",
      "Vessel claims moved to a newer session",
      fleet.identityConflicts
    ],
    [
      "fleet_identity_rejected_total",
      "Fleet HELLOs with an unreadable identity",
      fleet.identityRejected
    ],
    ["fleet_keepalives_sent_total", "HELLO_ACK keepalives sent", fleet.keepalivesSent],
    ["fleet_snapshots_sent_total", "Fleet join snapshots queued", fleet.snapshotsSent],
    [
      "fleet_packets_abandoned_total",
      "FLEET_DATA dropped after exhausting retransmits",
      fleet.packetsAbandoned
    ],
    ["fleet_packets_received_total", "FLEET_DATA packets accepted", fleet.packetsReceived],
    ["fleet_values_received_total", "Values received over the fleet channel", fleet.valuesReceived],
    [
      "fleet_meta_received_total",
      "Metadata entries received over the fleet channel",
      fleet.metaReceived
    ],
    [
      "fleet_loop_drops_total",
      "Uplink deltas dropped: context learned from the fleet",
      fleet.loopDrops
    ],
    ["fleet_duplicate_packets_total", "Duplicate or late FLEET_DATA", fleet.duplicatePackets],
    ["fleet_stale_values_total", "Fleet values older than one already applied", fleet.staleValues],
    ["fleet_rejected_packets_total", "FLEET_DATA or HELLO_ACK rejected", fleet.rejectedPackets]
  ];
  for (const [name, help, value] of counters) {
    e.counter(name, help, value || 0);
  }
}
