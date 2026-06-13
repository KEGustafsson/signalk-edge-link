import React from "react";
import { MetricsData } from "../../types";
import { Card } from "./shared";

interface Props {
  metrics: MetricsData | null;
}

export function PathAnalyticsCard({ metrics }: Props) {
  const paths = metrics?.pathStats;
  if (!paths) return null;

  const isClient = metrics?.mode === "client";

  if (paths.length === 0) {
    return (
      <Card
        title="Path Analytics"
        subtitle={
          isClient ? "Data volume by subscription path" : "Incoming data volume by SignalK path"
        }
      >
        <div className="path-analytics-empty">
          <p>No path data collected yet. Data will appear once deltas are transmitted.</p>
        </div>
      </Card>
    );
  }

  const categoryCount = new Set(paths.map((p) => p.path.split(".")[0])).size;

  return (
    <Card
      title="Path Analytics"
      subtitle={
        isClient ? "Data volume by subscription path" : "Incoming data volume by SignalK path"
      }
    >
      <div className="path-analytics-dashboard">
        <div className="path-summary">
          <div className="summary-stat">
            <span className="summary-value">{paths.length}</span>
            <span className="summary-label">Active Paths</span>
          </div>
          <div className="summary-stat">
            <span className="summary-value">{categoryCount}</span>
            <span className="summary-label">Categories</span>
          </div>
        </div>

        <div className="path-table-container">
          <table className="path-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Updates/min</th>
                <th>Data Volume</th>
                <th>% of Total</th>
              </tr>
            </thead>
            <tbody>
              {paths.slice(0, 15).map((p) => (
                <tr key={p.path}>
                  <td className="path-name" title={p.path}>
                    {p.path}
                  </td>
                  <td className="path-rate">{p.updatesPerMinute}</td>
                  <td className="path-bytes">{p.bytesFormatted}</td>
                  <td className="path-percentage">
                    <div className="percentage-bar-container">
                      <div
                        className="percentage-bar"
                        style={{ width: `${Math.min(100, Math.max(p.percentage, 2))}%` }}
                      />
                      <span className="percentage-text">{p.percentage}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {paths.length > 15 && (
          <div className="path-more">
            <p>Showing top 15 of {paths.length} paths</p>
          </div>
        )}
      </div>
    </Card>
  );
}
