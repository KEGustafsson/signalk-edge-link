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
  const packetLossSummary = data.packetLoss?.summary;
  const totalLost = numberOrZero(packetLossSummary?.totalLost);
  const totalExpected = numberOrZero(packetLossSummary?.totalExpected);
  const lossRate = numberOrZero(packetLossSummary?.lossRate);
  const totalRetransmissions = numberOrZero(data.retransmissions?.totalRetransmissions);
  const retransmitRate = numberOrZero(data.retransmissions?.retransmitRate);

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
                label="Loss Rate"
                value={`${(lossRate * 100).toFixed(1)}%`}
                hasError={lossRate > 0.05}
              />
            </div>
          </div>
        )}

        {data.retransmissions && (
          <div className="monitoring-subsection">
            <h5>Retransmissions</h5>
            <div className="stats-grid">
              <StatItem
                label="Total Retransmissions"
                value={totalRetransmissions.toLocaleString()}
                hasError={totalRetransmissions > 0}
              />
              <StatItem
                label="Retransmit Rate"
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
