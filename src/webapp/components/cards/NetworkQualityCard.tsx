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
  // Loss is a ratio over observed traffic: with nothing sent or received it is
  // 0/0, and the seeded 0 would render as a confident "0.0%". Fresh client
  // telemetry counts on its own — the remote peer did the observing.
  const hasLossBasis =
    nq.dataSource === "remote-client" ||
    (metrics?.bandwidth?.packetsIn ?? 0) > 0 ||
    (metrics?.bandwidth?.packetsOut ?? 0) > 0;
  // Normalize then clamp to [0,100]: `?? 0` only covers null/undefined, so guard
  // NaN/Infinity (which would propagate through round/clamp) with Number.isFinite.
  // An out-of-range value would otherwise push gaugeAngle past 180°, flipping
  // largeArc and rendering a malformed SVG arc.
  const rawQuality = Number.isFinite(nq.linkQuality) ? (nq.linkQuality as number) : 0;
  const qualityPct = Math.max(0, Math.min(100, Math.round(rawQuality)));

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
                {nq.linkQuality !== undefined ? qualityPct : "—"}
              </text>
              <text x={cx} y={cy + 8} textAnchor="middle" fontSize="7" fill="#666">
                {qualityLabel}
              </text>
            </svg>
            <div className="nq-gauge-label">Link Quality</div>
            {nq.linkQuality === undefined && (
              // "N/A" alone reads as a broken panel. Say which of the two
              // reasons applies: a server has no latency of its own and is
              // waiting on client telemetry, while a client has not yet had an
              // ACK to time — which, alongside a rising queue depth, is the
              // signature of traffic leaving and nothing coming back.
              <div className="nq-gauge-reason">
                {isClient ? "No round trip measured yet" : "Awaiting client telemetry"}
              </div>
            )}
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
            {/*
              Packet loss needs its own basis, not linkQuality's. A server
              derives it from sequence gaps in traffic it has actually
              received, so it can be real while RTT is still unknown — but
              with nothing received yet the seeded 0 renders as a confident
              "0.0%" beside three N/As, which reads as a healthy link on a
              link that has told us nothing. That is what a proxy's
              downstream-facing instance shows before its client connects.
            */}
            <MetricItem
              label="Packet Loss"
              value={
                hasLossBasis && nq.packetLoss !== undefined
                  ? formatRatioPercent(nq.packetLoss)
                  : "N/A"
              }
              statusClass={
                !hasLossBasis || nq.packetLoss === undefined
                  ? ""
                  : nq.packetLoss > 0.1
                    ? "error"
                    : nq.packetLoss > 0.03
                      ? "warning"
                      : ""
              }
            />
          </div>
        </div>

        <div className="nq-details">
          <h5>Reliability Statistics</h5>
          <div className="stats-grid">
            <StatItem label="Data Source" value={nq.dataSource || "local"} />
            {nq.activeLink && <StatItem label="Active Link" value={nq.activeLink} />}
            {/*
              `?? 0` at the display layer would undo the fix behind these
              fields. The API now reports "the peer never sent this" as
              undefined instead of substituting 0, precisely so a silent field
              stops reading as a measured zero; defaulting here would put the
              same invented number back on screen, one layer down.
            */}
            <StatItem
              label="Retransmit Rate"
              value={
                nq.retransmitRate !== undefined ? formatRatioPercent(nq.retransmitRate) : "N/A"
              }
              hasError={nq.retransmitRate !== undefined && nq.retransmitRate > 0.1}
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
                  value={
                    nq.retransmissions !== undefined ? nq.retransmissions.toLocaleString() : "N/A"
                  }
                  hasError={nq.retransmissions !== undefined && nq.retransmissions > 0}
                />
                <StatItem
                  label="Queue Depth"
                  value={nq.queueDepth !== undefined ? nq.queueDepth.toLocaleString() : "N/A"}
                  hasError={nq.queueDepth !== undefined && nq.queueDepth > 100}
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
