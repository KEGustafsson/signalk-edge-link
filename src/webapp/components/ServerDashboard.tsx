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
import { useApi, ApiError } from "../hooks/useApi";
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
  const { request, authMessage } = useApi();
  const epochRef = useRef(0);

  // A server's monitoring surfaces are fetched here rather than passed down,
  // because only this component knows whether the connection speaks v3 and
  // needs them at all. Re-runs on `refreshTick` so the cards track the same
  // cadence as the metrics card.
  useEffect(() => {
    if (!hasV3Data) return;
    const epoch = ++epochRef.current;
    const load = async () => {
      // Transient failures leave a card empty and are not worth a toast, but an
      // authorization failure must not look like "no monitoring data" — a bad
      // token would otherwise render three permanently blank cards with no
      // explanation. Mirrors ClientDashboard.
      let authFailed = false;
      const guard = (p: Promise<Response>) =>
        p.catch((err: unknown) => {
          if ((err as ApiError)?.isUnauthorized) authFailed = true;
          return null;
        });
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
      if (authFailed) {
        onNotify(authMessage("loading server monitoring"), "error");
      }
    };
    load().catch(() => {
      // Non-auth transient errors: the cards simply stay empty.
    });
  }, [connId, hasV3Data, refreshTick, request, authMessage, onNotify]);

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
