import React, { useEffect, useState, useRef } from "react";
import { MetricsData } from "../types";
import { MetricsCard } from "./cards/MetricsCard";
import { NetworkQualityCard } from "./cards/NetworkQualityCard";
import { BandwidthCard } from "./cards/BandwidthCard";
import { PathAnalyticsCard } from "./cards/PathAnalyticsCard";
import { MonitoringAlertsCard } from "./cards/MonitoringAlertsCard";
import { ConfigFileEditorCard } from "./cards/ConfigFileEditorCard";
import { MonitoringData } from "../types";
import { getTokenHelpText } from "../utils/apiFetch";
import { useApi } from "../hooks/useApi";
import { monitoringPath } from "../utils";

interface Props {
  connId: string;
  metrics: MetricsData | null;
  pluginConfig: Record<string, unknown> | null;
  pluginSchema: Record<string, unknown> | null;
  activeConnectionIndex: number;
  onNotify: (msg: string, type: string) => void;
  onPluginConfigSaved: (cfg: Record<string, unknown>) => void;
  /** Increments on each metrics poll; re-fetches the v3 monitoring surfaces. */
  refreshTick?: number;
}

export function ServerDashboard({
  connId,
  metrics,
  pluginConfig,
  pluginSchema,
  activeConnectionIndex,
  onNotify,
  onPluginConfigSaved,
  refreshTick = 0
}: Props) {
  const hasV3Data = (metrics?.protocolVersion ?? 1) >= 2;
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null);
  const { request } = useApi();
  const epochRef = useRef(0);

  // Server connections previously received a hardcoded `monitoring={null}`, so
  // the alerts card below could never render and no packet-loss or
  // retransmission data was ever fetched for a server — even though the routes
  // exist and the card is wired up.
  useEffect(() => {
    if (!hasV3Data) return;
    const epoch = ++epochRef.current;
    const load = async () => {
      const guard = (p: Promise<Response>) => p.catch(() => null);
      const [alertsRes, plRes, rtxRes] = await Promise.all([
        guard(request(monitoringPath(connId, "alerts"))),
        guard(request(monitoringPath(connId, "packet-loss"))),
        guard(request(monitoringPath(connId, "retransmissions")))
      ]);
      if (epoch !== epochRef.current) return;
      const mon: MonitoringData = {};
      if (alertsRes?.ok) mon.alerts = await alertsRes.json();
      if (plRes?.ok) mon.packetLoss = await plRes.json();
      if (rtxRes?.ok) mon.retransmissions = await rtxRes.json();
      if (epoch !== epochRef.current) return;
      setMonitoring(mon);
    };
    load().catch(() => {
      // Transient monitoring failures leave the cards empty; metrics polling
      // already surfaces auth/connectivity problems to the operator.
    });
  }, [connId, hasV3Data, refreshTick, request]);

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
