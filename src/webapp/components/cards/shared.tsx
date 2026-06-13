import React from "react";

export function Card({
  title,
  subtitle,
  children
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="config-section">
      <div className="card">
        <div className="card-header">
          <h2>{title}</h2>
          {subtitle && <p className="subtitle">{subtitle}</p>}
        </div>
        <div className="card-content">{children}</div>
      </div>
    </div>
  );
}

export function MetricItem({
  label,
  value,
  statusClass
}: {
  label: string;
  value: React.ReactNode;
  statusClass?: string;
}) {
  return (
    <div className={`metric-item${statusClass ? ` ${statusClass}` : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}

export function StatItem({
  label,
  value,
  hasError
}: {
  label: string;
  value: React.ReactNode;
  hasError?: boolean;
}) {
  return (
    <div className={`stat-item${hasError ? " error" : ""}`}>
      <span className="stat-label">{label}:</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

export function BwStat({
  label,
  value,
  isHighlight,
  isSuccess
}: {
  label: string;
  value: React.ReactNode;
  isHighlight?: boolean;
  isSuccess?: boolean;
}) {
  return (
    <div className={`bw-stat${isHighlight ? " highlight" : ""}`}>
      <span className="bw-label">{label}:</span>
      <span className={`bw-value${isSuccess ? " success-text" : ""}`}>{value}</span>
    </div>
  );
}
