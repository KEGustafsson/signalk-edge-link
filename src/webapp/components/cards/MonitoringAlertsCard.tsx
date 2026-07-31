import React from "react";
import { MonitoringData } from "../../types";
import { Card, StatItem } from "./shared";

interface Props {
  data: MonitoringData | null;
}

function normaliseLevel(raw: unknown): string {
  let level = "warning";
  if (typeof raw === "string") level = raw.toLowerCase();
  else if (raw && typeof raw === "object" && "level" in (raw as object))
    level = String((raw as { level: unknown }).level).toLowerCase();
  if (level === "warn") level = "warning";
  if (level === "alert") level = "critical";
  if (level !== "warning" && level !== "critical") level = "warning";
  return level;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function MonitoringAlertsCard({ data }: Props) {
  if (!data) return null;
  const hasData = data.alerts || data.packetLoss || data.retransmissions;
  if (!hasData) return null;
  // Every field below is read from the tracker's `summary` object and must
  // match the name getSummary() emits. A mismatch resolves to undefined, which
  // numberOrZero renders as 0 — a stalled panel rather than a visibly broken
  // one, and TypeScript cannot catch it because the fields are optional.
  const packetLossSummary = data.packetLoss?.summary;
  const retransmitSummary = data.retransmissions?.summary;
  const totalLost = numberOrZero(packetLossSummary?.totalLost);
  const totalExpected = numberOrZero(packetLossSummary?.totalExpected);
  const lossRate = numberOrZero(packetLossSummary?.overallLossRate);
  const totalRetransmissions = numberOrZero(retransmitSummary?.totalRetransmissions);
  // `currentRate` is the latest sampling period. The Network Quality card shows
  // a lifetime retransmissions/packetsOut ratio under the same words, so label
  // this one for the window it actually covers.
  const retransmitRate = numberOrZero(retransmitSummary?.currentRate);

  return (
    <Card
      title="Monitoring & Alerts"
      subtitle="Packet loss, retransmission tracking, and alert thresholds"
    >
      <div className="v2-dashboard">
        {data.alerts && (
          <div className="monitoring-subsection">
            <h5>Active Alerts</h5>
            {(() => {
              const entries = Object.entries(data.alerts.activeAlerts || {});
              if (entries.length === 0) {
                return (
                  <div className="metrics-success">
                    <div className="success-message">No active alerts</div>
                  </div>
                );
              }
              return (
                <div className="stats-grid">
                  {entries.map(([metric, raw]) => {
                    const level = normaliseLevel(raw);
                    const val =
                      raw && typeof raw === "object" && "value" in (raw as object)
                        ? ` (${String((raw as { value: unknown }).value)})`
                        : "";
                    return (
                      <StatItem
                        key={metric}
                        label={metric}
                        value={
                          <span className={`alert-level alert-${level}`}>
                            {level.toUpperCase()}
                            {val}
                          </span>
                        }
                        hasError={level === "critical"}
                      />
                    );
                  })}
                </div>
              );
            })()}
          </div>
        )}

        {packetLossSummary && (
          <div className="monitoring-subsection">
            <h5>Packet Loss</h5>
            <div className="stats-grid">
              <StatItem
                label="Total Lost"
                value={totalLost.toLocaleString()}
                hasError={totalLost > 0}
              />
              <StatItem label="Total Expected" value={totalExpected.toLocaleString()} />
              <StatItem
                label="Loss Rate (all buckets)"
                value={`${(lossRate * 100).toFixed(1)}%`}
                hasError={lossRate > 0.05}
              />
            </div>
          </div>
        )}

        {retransmitSummary && (
          <div className="monitoring-subsection">
            <h5>Retransmissions</h5>
            <div className="stats-grid">
              <StatItem
                label="Total Retransmissions"
                value={totalRetransmissions.toLocaleString()}
                hasError={totalRetransmissions > 0}
              />
              <StatItem
                label="Retransmit Rate (current period)"
                value={`${(retransmitRate * 100).toFixed(1)}%`}
                hasError={retransmitRate > 0.05}
              />
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
