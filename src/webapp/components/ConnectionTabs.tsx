import React from "react";
import { ConnectionInfo } from "../types";

interface Props {
  connections: ConnectionInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
}

export function ConnectionTabs({ connections, activeId, onSelect }: Props) {
  if (connections.length <= 1) return null;

  return (
    <div className="connection-tabs">
      <div className="tabs-container">
        {connections.map((c) => {
          const dotClass =
            c.healthy === false ? "error" : c.readyToSend || c.type === "server" ? "ok" : "warning";
          return (
            <button
              key={c.id}
              className={`connection-tab${c.id === activeId ? " active" : ""}`}
              onClick={() => onSelect(c.id)}
            >
              <span className={`tab-status-dot ${dotClass}`} />
              <span className="tab-icon">{c.type === "server" ? "🖥" : "📱"}</span>
              <span className="tab-name">{c.name || c.id}</span>
              <span className="tab-type">{c.type}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
