import React from "react";
import { MetricsData } from "../../types";
import { formatBytes } from "../../utils";
import { Card, BwStat } from "./shared";

const INTERVAL_S = 15;

interface Props {
  metrics: MetricsData | null;
}

function SparklineChart({
  history,
  isClient
}: {
  history: Array<{ rateOut: number; rateIn: number }>;
  isClient: boolean;
}) {
  if (history.length < 2) {
    return (
      <div className="bandwidth-chart-placeholder">
        <p>Collecting data for chart… ({history.length}/2 points)</p>
      </div>
    );
  }
  const width = 100;
  const height = 40;
  const maxRate = Math.max(...history.map((h) => (isClient ? h.rateOut : h.rateIn)), 1);
  const points = history
    .map((h, i) => {
      const x = (i / (history.length - 1)) * width;
      const y = height - ((isClient ? h.rateOut : h.rateIn) / maxRate) * height;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <div className="bandwidth-chart">
      <h5>Rate History (Last {history.length * INTERVAL_S}s)</h5>
      <div className="chart-container">
        <svg viewBox={`0 0 ${width} ${height}`} className="sparkline" preserveAspectRatio="none">
          <polyline fill="none" stroke="var(--primary-color)" strokeWidth="1.5" points={points} />
        </svg>
        <div className="chart-labels">
          <span className="chart-max">{formatBytes(maxRate)}/s</span>
          <span className="chart-min">0</span>
        </div>
      </div>
    </div>
  );
}

export function BandwidthCard({ metrics }: Props) {
  const bw = metrics?.bandwidth;
  if (!bw) return null;

  const isClient = metrics?.mode === "client";
  const saved = isClient ? bw.bytesOutRaw - bw.bytesOut : bw.bytesInRaw - bw.bytesIn;
  const savedFmt = formatBytes(saved > 0 ? saved : 0);
  const metaBytesOut = bw.metaBytesOut ?? 0;
  const metaBytesIn = bw.metaBytesIn ?? 0;

  return (
    <Card
      title="Bandwidth Monitor"
      subtitle={
        isClient ? "Real-time data transmission statistics" : "Network reception statistics"
      }
    >
      <div className="bandwidth-dashboard">
        <div className="bandwidth-hero">
          <div className={`hero-stat ${isClient ? "primary" : "secondary"}`}>
            <div className="hero-value">{isClient ? bw.rateOutFormatted : bw.rateInFormatted}</div>
            <div className="hero-label">{isClient ? "Upload Rate" : "Download Rate"}</div>
          </div>
          <div className="hero-stat success">
            <div className="hero-value">{bw.compressionRatio}%</div>
            <div className="hero-label">Compression Ratio</div>
          </div>
          <div className="hero-stat">
            <div className="hero-value">{bw.avgPacketSizeFormatted}</div>
            <div className="hero-label">Avg Packet Size</div>
          </div>
        </div>

        <div className="bandwidth-details">
          <h5>Bandwidth Details</h5>
          <div className="bandwidth-grid">
            {isClient ? (
              <>
                <BwStat label="Total Sent (Compressed)" value={bw.bytesOutFormatted} />
                <BwStat label="Total Raw (Before Compression)" value={bw.bytesOutRawFormatted} />
                <BwStat label="Bandwidth Saved" value={savedFmt} isHighlight isSuccess />
                <BwStat label="Packets Sent" value={bw.packetsOut.toLocaleString()} />
              </>
            ) : (
              <>
                <BwStat label="Total Received (Compressed)" value={bw.bytesInFormatted} />
                <BwStat
                  label="Total Raw (After Decompression)"
                  value={bw.bytesInRawFormatted ?? formatBytes(bw.bytesInRaw ?? 0)}
                />
                <BwStat label="Bandwidth Saved" value={savedFmt} isHighlight isSuccess />
                <BwStat label="Packets Received" value={bw.packetsIn.toLocaleString()} />
              </>
            )}
          </div>
        </div>

        <div className="bandwidth-details metadata-details">
          <h5>Metadata Traffic</h5>
          <div className="bandwidth-grid">
            {isClient ? (
              <>
                <BwStat
                  label="Metadata Sent"
                  value={bw.metaBytesOutFormatted ?? formatBytes(metaBytesOut)}
                />
                <BwStat
                  label="Metadata Packets Sent"
                  value={(bw.metaPacketsOut ?? 0).toLocaleString()}
                />
                <BwStat
                  label="Metadata Snapshots Sent"
                  value={(bw.metaSnapshotsSent ?? 0).toLocaleString()}
                />
                <BwStat
                  label="Metadata Diffs Sent"
                  value={(bw.metaDiffsSent ?? 0).toLocaleString()}
                />
              </>
            ) : (
              <>
                <BwStat
                  label="Metadata Received"
                  value={bw.metaBytesInFormatted ?? formatBytes(metaBytesIn)}
                />
                <BwStat
                  label="Metadata Packets Received"
                  value={(bw.metaPacketsIn ?? 0).toLocaleString()}
                />
                <BwStat
                  label="Metadata Rate-Limited"
                  value={(bw.metaRateLimitedPackets ?? 0).toLocaleString()}
                />
              </>
            )}
          </div>
        </div>

        {bw.history && <SparklineChart history={bw.history} isClient={isClient} />}
      </div>
    </Card>
  );
}
