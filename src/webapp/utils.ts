export const API_BASE = "/plugins/signalk-edge-link";
export const METRICS_REFRESH_INTERVAL = 15000;
export const DELTA_TIMER_MIN = 100;
export const DELTA_TIMER_MAX = 10000;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

export function formatRatioPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0.0%";
  return (value * 100).toFixed(1) + "%";
}

export function formatTimestampAge(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "N/A";
  const ageMs = Math.max(0, Date.now() - timestamp);
  if (ageMs < 1000) return "just now";
  if (ageMs < 60000) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.floor(ageMs / 60000)}m ago`;
  return `${Math.floor(ageMs / 3600000)}h ago`;
}

export function metricsPath(connId: string): string {
  return connId === "_legacy"
    ? `${API_BASE}/metrics`
    : `${API_BASE}/connections/${encodeURIComponent(connId)}/metrics`;
}

export function configPath(connId: string, filename: string): string {
  const safeFilename = encodeURIComponent(filename);
  return connId === "_legacy"
    ? `${API_BASE}/config/${safeFilename}`
    : `${API_BASE}/connections/${encodeURIComponent(connId)}/config/${safeFilename}`;
}

export function monitoringPath(connId: string, sub: string): string {
  const safeSub = encodeURIComponent(sub);
  return connId === "_legacy"
    ? `${API_BASE}/monitoring/${safeSub}`
    : `${API_BASE}/connections/${encodeURIComponent(connId)}/monitoring/${safeSub}`;
}

export function congestionPath(connId: string): string {
  return connId === "_legacy"
    ? `${API_BASE}/congestion`
    : `${API_BASE}/connections/${encodeURIComponent(connId)}/congestion`;
}

export function bondingPath(connId: string): string {
  return connId === "_legacy"
    ? `${API_BASE}/bonding`
    : `${API_BASE}/connections/${encodeURIComponent(connId)}/bonding`;
}

export function bondingFailoverPath(connId: string): string {
  return connId === "_legacy"
    ? `${API_BASE}/bonding/failover`
    : `${API_BASE}/connections/${encodeURIComponent(connId)}/bonding/failover`;
}
