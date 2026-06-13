import React from "react";
import { MetricsData } from "../../types";
import { formatRatioPercent, formatTimestampAge } from "../../utils";
import { Card, StatItem, MetricItem } from "./shared";

interface Props {
  metrics: MetricsData | null;
}

export function NetworkQualityCard({ metrics }: Props) {
  const nq = metrics?.networkQuality;
  if (!nq) return null;

  const isClient = metrics?.mode === "client";
  const qualityPct = nq.linkQuality ?? 0;

  let qualityLabel = "N/A";
  let qualityColor = "#9E9E9E";
  if (nq.linkQuality !== undefined) {
    if (nq.linkQuality >= 90) {
      qualityLabel = "Excellent";
      qualityColor = "#4CAF50";
    } else if (nq.linkQuality >= 70) {
      qualityLabel = "Good";
      qualityColor = "#FFC107";
    } else if (nq.linkQuality >= 50) {
      qualityLabel = "Fair";
      qualityColor = "#FF9800";
    } else {
      qualityLabel = "Poor";
      qualityColor = "#F44336";
    }
  }

  const gaugeAngle = (qualityPct / 100) * 180;
  const radStart = Math.PI;
  const radEnd = radStart + (gaugeAngle * Math.PI) / 180;
  const cx = 50,
    cy = 50,
    r = 40;
  const x1 = cx + r * Math.cos(radStart);
  const y1 = cy + r * Math.sin(radStart);
  const x2 = cx + r * Math.cos(radEnd);
  const y2 = cy + r * Math.sin(radEnd);
  const largeArc = gaugeAngle > 180 ? 1 : 0;

  return (
    <Card title="Network Quality" subtitle="Link quality score and network health indicators">
      <div className="network-quality-dashboard">
        <div className="nq-hero">
          <div className="nq-gauge-container">
            <svg viewBox="0 0 100 55" className="quality-gauge" preserveAspectRatio="xMidYMid meet">
              <path
                d={`M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`}
                fill="none"
                stroke="#E0E0E0"
                strokeWidth="8"
                strokeLinecap="round"
              />
              {qualityPct > 0 && (
                <path
                  d={`M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}`}
                  fill="none"
                  stroke={qualityColor}
                  strokeWidth="8"
                  strokeLinecap="round"
                />
              )}
              <text
                x={cx}
                y={cy - 5}
                textAnchor="middle"
                fontSize="16"
                fontWeight="bold"
                fill={qualityColor}
              >
                {qualityPct}
              </text>
              <text x={cx} y={cy + 8} textAnchor="middle" fontSize="7" fill="#666">
                {qualityLabel}
              </text>
            </svg>
            <div className="nq-gauge-label">Link Quality</div>
          </div>
          <div className="nq-key-metrics">
            <MetricItem
              label="RTT"
              value={nq.rtt !== undefined ? `${nq.rtt} ms` : "N/A"}
              statusClass={
                nq.rtt !== undefined ? (nq.rtt > 500 ? "error" : nq.rtt > 200 ? "warning" : "") : ""
              }
            />
            <MetricItem
              label="Jitter"
              value={nq.jitter !== undefined ? `${nq.jitter} ms` : "N/A"}
              statusClass={
                nq.jitter !== undefined
                  ? nq.jitter > 100
                    ? "error"
                    : nq.jitter > 50
                      ? "warning"
                      : ""
                  : ""
              }
            />
            <MetricItem
              label="Packet Loss"
              value={formatRatioPercent(nq.packetLoss ?? 0)}
              statusClass={
                (nq.packetLoss ?? 0) > 0.1 ? "error" : (nq.packetLoss ?? 0) > 0.03 ? "warning" : ""
              }
            />
          </div>
        </div>

        <div className="nq-details">
          <h5>Reliability Statistics</h5>
          <div className="stats-grid">
            <StatItem label="Data Source" value={nq.dataSource || "local"} />
            {nq.activeLink && <StatItem label="Active Link" value={nq.activeLink} />}
            <StatItem
              label="Retransmit Rate"
              value={formatRatioPercent(nq.retransmitRate ?? 0)}
              hasError={(nq.retransmitRate ?? 0) > 0.1}
            />
            {nq.lastRemoteUpdate && (
              <StatItem
                label="Last Remote Update"
                value={formatTimestampAge(nq.lastRemoteUpdate)}
              />
            )}
            {isClient ? (
              <>
                <StatItem
                  label="Retransmissions"
                  value={(nq.retransmissions ?? 0).toLocaleString()}
                  hasError={(nq.retransmissions ?? 0) > 0}
                />
                <StatItem
                  label="Queue Depth"
                  value={(nq.queueDepth ?? 0).toLocaleString()}
                  hasError={(nq.queueDepth ?? 0) > 100}
                />
              </>
            ) : (
              <>
                <StatItem label="ACKs Sent" value={(nq.acksSent ?? 0).toLocaleString()} />
                <StatItem
                  label="NAKs Sent"
                  value={(nq.naksSent ?? 0).toLocaleString()}
                  hasError={(nq.naksSent ?? 0) > 0}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
