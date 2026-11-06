import React from "react";
import { FleetMetricsData } from "../../types";
import { Card, MetricItem, StatItem } from "./shared";

interface Props {
  fleet: FleetMetricsData | null | undefined;
  mode: "client" | "server";
}

/**
 * What a client's fleet state means and what to do about it. Mirrors the
 * "Fleet Sharing" table in docs/troubleshooting.md so the card answers the
 * question an operator has when the state is not `active`.
 */
const CLIENT_STATE_HINTS: Record<string, { cls: string; hint: string }> = {
  active: {
    cls: "success",
    hint: "Receiving other vessels from the server. A vessel appears once it is a member and sends data."
  },
  offered: {
    cls: "warning",
    hint:
      "Waiting for the server's answer, as at start-up or after a minute without fleet data. " +
      "If this persists, check that this vessel has an MMSI, UUID or Signal K self set."
  },
  declined: {
    cls: "error",
    hint: "The server has fleet sharing turned off. Enable fleetSharing on the server connection."
  },
  "not-offered": {
    cls: "error",
    hint:
      "The server has not answered the fleet request. Either it was unreachable (this client asks again " +
      "every minute) or it runs a version before 4.4.0 and needs an upgrade. The uplink still works."
  },
  disabled: { cls: "", hint: "Fleet sharing is off for this connection." }
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ClientView({ fleet }: { fleet: FleetMetricsData }) {
  const info = CLIENT_STATE_HINTS[fleet.state] ?? CLIENT_STATE_HINTS.disabled;
  return (
    <>
      <div className="metrics-grid">
        <MetricItem
          label="State"
          value={<span className={`congestion-state ${info.cls}`}>{fleet.state}</span>}
          statusClass={info.cls || undefined}
        />
        <MetricItem label="Vessels known" value={fleet.contextsKnown} />
        <MetricItem label="Values received" value={fleet.valuesReceived} />
        <MetricItem label="Metadata received" value={fleet.metaReceived ?? 0} />
      </div>
      <p className="subtitle" data-testid="fleet-hint">
        {info.hint}
      </p>
      <div className="metrics-stats">
        <h5>Fleet Channel</h5>
        <div className="stats-grid">
          <StatItem label="Packets received" value={fleet.packetsReceived} />
          <StatItem label="Echo suppressed" value={fleet.loopDrops} />
          <StatItem label="Duplicates" value={fleet.duplicatePackets} />
          <StatItem label="Older values ignored" value={fleet.staleValues ?? 0} />
          <StatItem
            label="Rejected"
            value={fleet.rejectedPackets}
            hasError={fleet.rejectedPackets > 0}
          />
          <StatItem label="ACK / NAK sent" value={`${fleet.acksSent} / ${fleet.naksSent}`} />
        </div>
      </div>
    </>
  );
}

function ServerView({ fleet }: { fleet: FleetMetricsData }) {
  const pacing = Math.round((fleet.minRateFactor ?? 1) * 100);
  return (
    <>
      <div className="metrics-grid">
        <MetricItem
          label="State"
          value={fleet.state}
          statusClass={fleet.state === "active" ? "success" : undefined}
        />
        <MetricItem label="Members" value={fleet.members} />
        <MetricItem label="Values sent" value={fleet.valuesSent} />
        <MetricItem label="Data sent" value={formatBytes(fleet.bytesSent)} />
        <MetricItem
          label="Slowest member pacing"
          value={`${pacing}%`}
          statusClass={pacing < 100 ? "warning" : undefined}
        />
      </div>
      {pacing < 100 && (
        <p className="subtitle" data-testid="fleet-hint">
          Loss on at least one member&apos;s downlink: its fleet rate is cut to {pacing}% and
          recovers automatically once the loss stops.
        </p>
      )}
      <div className="metrics-stats">
        <h5>Fleet Channel</h5>
        <div className="stats-grid">
          <StatItem label="Packets sent" value={fleet.packetsSent} />
          <StatItem label="Retransmits" value={fleet.retransmits} />
          <StatItem label="Rate cuts on loss" value={fleet.rateBackoffs ?? 0} />
          <StatItem label="Deferred by budget" value={fleet.rateLimitedFlushes} />
          <StatItem label="Relayed copies dropped" value={fleet.originDrops} />
          {/* A vessel reconnecting from a new port moves its claim too, so a
              conflict alone is not an error. */}
          <StatItem label="Identity conflicts" value={fleet.identityConflicts} />
          <StatItem
            label="Replayed HELLOs ignored"
            value={fleet.replayedHellos ?? 0}
            hasError={(fleet.replayedHellos ?? 0) > 0}
          />
          <StatItem
            label="Refused identities"
            value={fleet.identityRejected}
            hasError={fleet.identityRejected > 0}
          />
          <StatItem
            label="Abandoned"
            value={fleet.packetsAbandoned}
            hasError={fleet.packetsAbandoned > 0}
          />
        </div>
      </div>
    </>
  );
}

/** Fleet sharing status (protocol-v3-spec §15). Hidden when not running. */
export function FleetCard({ fleet, mode }: Props) {
  if (!fleet) return null;
  return (
    <Card
      title="Fleet Sharing"
      subtitle={
        mode === "server"
          ? "Other vessels' data sent to each member over its own link"
          : "Other vessels' data received over this link"
      }
    >
      <div className="v2-dashboard">
        {mode === "server" ? <ServerView fleet={fleet} /> : <ClientView fleet={fleet} />}
      </div>
    </Card>
  );
}
