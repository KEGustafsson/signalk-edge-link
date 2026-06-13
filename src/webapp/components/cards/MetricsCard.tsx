import React from "react";
import { MetricsData } from "../../types";
import { Card, MetricItem, StatItem } from "./shared";

interface Props {
  metrics: MetricsData | null;
}

export function MetricsCard({ metrics }: Props) {
  if (!metrics) {
    return (
      <Card title="Performance Metrics">
        <p>Loading metrics...</p>
      </Card>
    );
  }

  const isClient = metrics.mode === "client";
  const { stats, status, uptime } = metrics;
  const pv = metrics.protocolVersion || 1;
  const pvLabel = pv >= 2 ? `v${pv}` : "v1";
  const cryptoErrors = stats.errorCounts?.crypto ?? 0;
  const malformed = stats.malformedPackets || 0;
  const rateLimited = stats.rateLimitedPackets || 0;
  const droppedBatches = stats.droppedDeltaBatches || 0;
  const droppedCount = stats.droppedDeltaCount || 0;
  const hasErrors =
    stats.udpSendErrors > 0 ||
    stats.compressionErrors > 0 ||
    stats.encryptionErrors > 0 ||
    stats.subscriptionErrors > 0 ||
    cryptoErrors > 0 ||
    malformed > 0 ||
    rateLimited > 0 ||
    droppedBatches > 0 ||
    droppedCount > 0;

  return (
    <Card
      title="Performance Metrics"
      subtitle={
        isClient
          ? "Real-time transmission statistics (auto-refreshes every 15 seconds)"
          : "Real-time reception statistics (auto-refreshes every 15 seconds)"
      }
    >
      <h4>Performance Metrics</h4>
      <div className="metrics-grid">
        <MetricItem label="Uptime" value={uptime.formatted} />
        <MetricItem label="Mode" value={isClient ? "Client" : "Server"} />
        <MetricItem
          label="Protocol"
          value={
            <span className={`protocol-badge protocol-${pvLabel}`}>{pvLabel.toUpperCase()}</span>
          }
        />
        <MetricItem
          label="Status"
          value={status.readyToSend ? "Ready" : "Not Ready"}
          statusClass={status.readyToSend ? "success" : "error"}
        />
        {isClient && <MetricItem label="Buffered Deltas" value={status.deltasBuffered ?? 0} />}
      </div>

      <div className="metrics-stats">
        <h5>Transmission Statistics</h5>
        <div className="stats-grid">
          {isClient ? (
            <StatItem label="Deltas Sent" value={stats.deltasSent.toLocaleString()} />
          ) : (
            <StatItem label="Deltas Received" value={stats.deltasReceived.toLocaleString()} />
          )}
          {!isClient && (
            <StatItem
              label="Data Packets Received"
              value={(stats.dataPacketsReceived ?? 0).toLocaleString()}
            />
          )}
          {isClient && (
            <StatItem
              label="UDP Send Errors"
              value={stats.udpSendErrors}
              hasError={stats.udpSendErrors > 0}
            />
          )}
          {isClient && <StatItem label="UDP Retries" value={stats.udpRetries} />}
          {!isClient && (
            <StatItem
              label="Rate-Limited Packets"
              value={rateLimited.toLocaleString()}
              hasError={rateLimited > 0}
            />
          )}
          {isClient && (
            <StatItem
              label="Dropped Delta Batches"
              value={droppedBatches.toLocaleString()}
              hasError={droppedBatches > 0}
            />
          )}
          {isClient && (
            <StatItem
              label="Dropped Deltas"
              value={droppedCount.toLocaleString()}
              hasError={droppedCount > 0}
            />
          )}
          <StatItem
            label="Compression Errors"
            value={stats.compressionErrors}
            hasError={stats.compressionErrors > 0}
          />
          <StatItem
            label="Encryption Errors"
            value={stats.encryptionErrors}
            hasError={stats.encryptionErrors > 0}
          />
          {isClient && (
            <StatItem
              label="Subscription Errors"
              value={stats.subscriptionErrors}
              hasError={stats.subscriptionErrors > 0}
            />
          )}
          {!isClient && (stats.duplicatePackets ?? 0) > 0 && (
            <StatItem
              label="Duplicate Packets"
              value={(stats.duplicatePackets ?? 0).toLocaleString()}
            />
          )}
          {pv >= 3 && (
            <StatItem label="Auth Failures (V3)" value={cryptoErrors} hasError={cryptoErrors > 0} />
          )}
          <StatItem label="Malformed Packets" value={malformed} hasError={malformed > 0} />
        </div>
      </div>

      {isClient && metrics.smartBatching && (
        <div className="metrics-stats">
          <h5>Smart Batching</h5>
          <div className="stats-grid">
            {(() => {
              const sb = metrics.smartBatching!;
              const total = sb.earlySends + sb.timerSends;
              const earlyPct = total > 0 ? Math.round((sb.earlySends / total) * 100) : 0;
              return (
                <>
                  <StatItem label="Avg Bytes/Delta" value={`${sb.avgBytesPerDelta} bytes`} />
                  <StatItem label="Max Deltas/Batch" value={sb.maxDeltasPerBatch} />
                  <StatItem
                    label="Early Sends"
                    value={`${sb.earlySends.toLocaleString()} (${earlyPct}%)`}
                  />
                  <StatItem label="Timer Sends" value={sb.timerSends.toLocaleString()} />
                  <StatItem
                    label="Oversized Packets"
                    value={sb.oversizedPackets}
                    hasError={sb.oversizedPackets > 0}
                  />
                </>
              );
            })()}
          </div>
        </div>
      )}

      {metrics.recentErrors && metrics.recentErrors.length > 0 ? (
        <div className="metrics-error">
          <h5>Recent Errors ({metrics.recentErrors.length})</h5>
          <div className="recent-errors-list">
            {metrics.recentErrors.map((err, i) => {
              const ago = Date.now() - err.timestamp;
              const t =
                ago < 60000 ? `${Math.floor(ago / 1000)}s ago` : `${Math.floor(ago / 60000)}m ago`;
              return (
                <div key={i} className="recent-error-item">
                  <span className="error-category-badge">{err.category}</span>
                  <span className="recent-error-msg">{err.message}</span>
                  <span className="recent-error-time">{t}</span>
                </div>
              );
            })}
          </div>
        </div>
      ) : metrics.lastError ? (
        <div className="metrics-error">
          <h5>Last Error</h5>
          <div className="error-message">{metrics.lastError.message}</div>
          <div className="error-time">
            Occurred{" "}
            {metrics.lastError.timeAgo < 60000
              ? `${Math.floor(metrics.lastError.timeAgo / 1000)}s ago`
              : `${Math.floor(metrics.lastError.timeAgo / 60000)}m ago`}
          </div>
        </div>
      ) : !hasErrors ? (
        <div className="metrics-success">
          <div className="success-message">No errors detected</div>
        </div>
      ) : null}
    </Card>
  );
}
