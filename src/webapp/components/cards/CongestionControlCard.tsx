import React from "react";
import { CongestionData } from "../../types";
import { Card, MetricItem, StatItem } from "./shared";

interface Props {
  data: CongestionData | null;
}

export function CongestionControlCard({ data }: Props) {
  if (!data) return null;

  const stateLabel = data.enabled ? (data.manualMode ? "manual" : "active") : "disabled";
  const stateClass = data.enabled ? (data.manualMode ? "warning" : "success") : "error";

  return (
    <Card
      title="Congestion Control"
      subtitle="AIMD congestion control state and delta timer auto-adjustment"
    >
      <div className="v2-dashboard">
        <div className="metrics-grid">
          <MetricItem
            label="State"
            value={<span className={`congestion-state ${stateClass}`}>{stateLabel}</span>}
          />
          <MetricItem label="Mode" value={data.manualMode ? "Manual Override" : "Automatic"} />
          <MetricItem label="Current Timer" value={`${data.currentDeltaTimer} ms`} />
          <MetricItem label="Nominal Timer" value={`${data.nominalDeltaTimer} ms`} />
        </div>
        <div className="metrics-stats">
          <h5>Congestion Details</h5>
          <div className="stats-grid">
            <StatItem label="Min Delta Timer" value={`${data.minDeltaTimer ?? 0} ms`} />
            <StatItem label="Max Delta Timer" value={`${data.maxDeltaTimer ?? 0} ms`} />
            <StatItem label="Target RTT" value={`${data.targetRTT ?? 0} ms`} />
            <StatItem
              label="Avg RTT"
              value={`${data.avgRTT !== undefined ? Math.round(data.avgRTT) : 0} ms`}
            />
            <StatItem
              label="Avg Packet Loss"
              value={`${data.avgLoss !== undefined ? (data.avgLoss * 100).toFixed(1) : 0}%`}
              hasError={(data.avgLoss ?? 0) > 0.05}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
