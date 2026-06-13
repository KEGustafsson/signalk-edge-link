import React from "react";
import { BondingData } from "../../types";
import { Card, MetricItem, StatItem } from "./shared";

interface Props {
  data: BondingData | null;
  onFailover: () => void;
}

export function BondingCard({ data, onFailover }: Props) {
  if (!data?.enabled) return null;

  const modeLabel = (data.mode || "main-backup").replace(/-/g, " ");
  const activeLink = data.activeLink || "primary";

  return (
    <Card title="Connection Bonding" subtitle="Multi-link bonding status and failover control">
      <div className="v2-dashboard">
        <div className="metrics-grid">
          <MetricItem label="Mode" value={modeLabel} />
          <MetricItem label="Active Link" value={activeLink} />
        </div>

        {data.links && (
          <div className="bonding-links">
            {Object.entries(data.links).map(([name, link]) => {
              const isActive = name === activeLink;
              const status = (link.status || "unknown").toLowerCase();
              const isUp = status !== "down";
              return (
                <div key={name} className={`bonding-link${isActive ? " active" : ""}`}>
                  <div className="link-header">
                    <span className="link-name">{name}</span>
                    {isActive && <span className="link-badge active-badge">ACTIVE</span>}
                    <span className={`link-badge ${isUp ? "success" : "error"}`}>
                      {status.toUpperCase()}
                    </span>
                  </div>
                  <div className="link-stats">
                    <StatItem label="RTT" value={`${link.rtt ?? 0} ms`} />
                    <StatItem
                      label="Packet Loss"
                      value={`${((link.loss ?? 0) * 100).toFixed(1)}%`}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div style={{ marginTop: "1rem" }}>
          <button className="btn btn-secondary" onClick={onFailover}>
            Force Failover
          </button>
        </div>
      </div>
    </Card>
  );
}
