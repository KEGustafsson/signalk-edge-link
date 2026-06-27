import React from "react";
import { MetricsData } from "../types";
import { MetricsCard } from "./cards/MetricsCard";
import { NetworkQualityCard } from "./cards/NetworkQualityCard";
import { BandwidthCard } from "./cards/BandwidthCard";
import { PathAnalyticsCard } from "./cards/PathAnalyticsCard";
import { MonitoringAlertsCard } from "./cards/MonitoringAlertsCard";
import { ConfigFileEditorCard } from "./cards/ConfigFileEditorCard";
import { MonitoringData } from "../types";
import { getTokenHelpText } from "../utils/apiFetch";

interface Props {
  connId: string;
  metrics: MetricsData | null;
  monitoring: MonitoringData | null;
  pluginConfig: Record<string, unknown> | null;
  pluginSchema: Record<string, unknown> | null;
  activeConnectionIndex: number;
  onNotify: (msg: string, type: string) => void;
  onPluginConfigSaved: (cfg: Record<string, unknown>) => void;
}

export function ServerDashboard({
  metrics,
  monitoring,
  pluginConfig,
  pluginSchema,
  activeConnectionIndex,
  onNotify,
  onPluginConfigSaved
}: Props) {
  const hasV3Data = (metrics?.protocolVersion ?? 1) >= 2;

  return (
    <>
      <section className="page-group" id="operationsGroup">
        <div className="page-group-header">
          <h2>Operations & Monitoring</h2>
          <p>Track reception quality, throughput, and runtime behavior.</p>
        </div>
        <div className="page-group-content">
          <MetricsCard metrics={metrics} />
          {hasV3Data && (
            <>
              <NetworkQualityCard metrics={metrics} />
              <BandwidthCard metrics={metrics} />
              <PathAnalyticsCard metrics={metrics} />
              {monitoring && <MonitoringAlertsCard data={monitoring} />}
            </>
          )}
        </div>
      </section>

      <section className="page-group" id="advancedGroup">
        <div className="page-group-header">
          <h2>Advanced</h2>
          <p>Full plugin configurator (JSON editor).</p>
        </div>
        <div className="page-group-content">
          <ConfigFileEditorCard
            pluginConfig={pluginConfig}
            pluginSchema={pluginSchema}
            activeConnectionIndex={activeConnectionIndex}
            totalConnections={1}
            tokenHelpText={getTokenHelpText()}
            onNotify={onNotify}
            onConfigSaved={onPluginConfigSaved}
          />
        </div>
      </section>
    </>
  );
}
