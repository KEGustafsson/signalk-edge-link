import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  MetricsData,
  MonitoringData,
  CongestionData,
  BondingData,
  DeltaTimerConfig,
  SubscriptionConfig,
  SentenceFilterConfig
} from "../types";
import {
  configPath,
  monitoringPath,
  congestionPath,
  bondingPath,
  bondingFailoverPath
} from "../utils";
import { useApi, ApiError } from "../hooks/useApi";
import { getTokenHelpText } from "../utils/apiFetch";
import { MetricsCard } from "./cards/MetricsCard";
import { NetworkQualityCard } from "./cards/NetworkQualityCard";
import { BandwidthCard } from "./cards/BandwidthCard";
import { PathAnalyticsCard } from "./cards/PathAnalyticsCard";
import { CongestionControlCard } from "./cards/CongestionControlCard";
import { BondingCard } from "./cards/BondingCard";
import { MonitoringAlertsCard } from "./cards/MonitoringAlertsCard";
import { StatusCard } from "./cards/StatusCard";
import { DeltaTimerCard } from "./cards/DeltaTimerCard";
import { SubscriptionCard } from "./cards/SubscriptionCard";
import { SentenceFilterCard } from "./cards/SentenceFilterCard";
import { ConfigFileEditorCard } from "./cards/ConfigFileEditorCard";

interface Props {
  connId: string;
  metrics: MetricsData | null;
  pluginConfig: Record<string, unknown> | null;
  pluginSchema: Record<string, unknown> | null;
  activeConnectionIndex: number;
  onNotify: (msg: string, type: string) => void;
  onPluginConfigSaved: (cfg: Record<string, unknown>) => void;
}

export function ClientDashboard({
  connId,
  metrics,
  pluginConfig,
  pluginSchema,
  activeConnectionIndex,
  onNotify,
  onPluginConfigSaved
}: Props) {
  const [deltaTimer, setDeltaTimer] = useState<DeltaTimerConfig | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionConfig | null>(null);
  const [sentenceFilter, setSentenceFilter] = useState<SentenceFilterConfig | null>(null);
  const [monitoring, setMonitoring] = useState<MonitoringData | null>(null);
  const [congestion, setCongestion] = useState<CongestionData | null>(null);
  const [bonding, setBonding] = useState<BondingData | null>(null);
  const { request, authMessage } = useApi();
  const loadEpochRef = useRef(0);
  const v3EpochRef = useRef(0);

  const loadConfigs = useCallback(async () => {
    const epoch = ++loadEpochRef.current;
    try {
      const [dtRes, subRes, sfRes] = await Promise.all([
        request(configPath(connId, "delta_timer.json")),
        request(configPath(connId, "subscription.json")),
        request(configPath(connId, "sentence_filter.json"))
      ]);
      if (epoch !== loadEpochRef.current) return;
      setDeltaTimer(dtRes.ok ? await dtRes.json() : null);
      setSubscription(subRes.ok ? await subRes.json() : null);
      setSentenceFilter(sfRes.ok ? await sfRes.json() : null);
    } catch (err: unknown) {
      if (epoch !== loadEpochRef.current) return;
      const e = err as ApiError;
      onNotify(
        e.isUnauthorized
          ? authMessage("loading connection configuration")
          : `Error loading configurations: ${e.message}`,
        "error"
      );
    }
  }, [connId, request, authMessage, onNotify]);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  useEffect(() => {
    if ((metrics?.protocolVersion ?? 1) < 2) return;

    const epoch = ++v3EpochRef.current;
    const loadV3 = async () => {
      try {
        const [alertsRes, plRes, rtxRes, congRes, bondRes] = await Promise.all([
          request(monitoringPath(connId, "alerts")).catch(() => null),
          request(monitoringPath(connId, "packet-loss")).catch(() => null),
          request(monitoringPath(connId, "retransmissions")).catch(() => null),
          request(congestionPath(connId)).catch(() => null),
          request(bondingPath(connId)).catch(() => null)
        ]);

        if (epoch !== v3EpochRef.current) return;

        const mon: MonitoringData = {};
        if (alertsRes?.ok) mon.alerts = await alertsRes.json();
        if (plRes?.ok) mon.packetLoss = await plRes.json();
        if (rtxRes?.ok) mon.retransmissions = await rtxRes.json();
        setMonitoring(mon);

        setCongestion(congRes?.ok ? await congRes.json() : null);
        setBonding(bondRes?.ok ? await bondRes.json() : null);
      } catch {
        // ignore
      }
    };

    loadV3();
  }, [connId, metrics?.protocolVersion, request]);

  const handleFailover = async () => {
    try {
      const res = await request(bondingFailoverPath(connId), { method: "POST" });
      if (res.ok) {
        const result = await res.json();
        onNotify(`Failover complete. Active link: ${result.activeLink}`, "success");
      } else {
        const err = await res.json();
        onNotify(
          res.status === 401
            ? authMessage("triggering failover")
            : `Failover failed: ${err.error || "Unknown error"}`,
          "error"
        );
      }
    } catch (err: unknown) {
      const e = err as ApiError;
      onNotify(
        e.isUnauthorized ? authMessage("triggering failover") : `Failover failed: ${e.message}`,
        "error"
      );
    }
  };

  const isV3 = (metrics?.protocolVersion ?? 1) >= 2;

  return (
    <>
      <section className="page-group" id="configurationGroup">
        <div className="page-group-header">
          <h2>Configuration</h2>
          <p>Set up transmission behavior and plugin-level parameters.</p>
        </div>
        <div className="page-group-content">
          <DeltaTimerCard
            connId={connId}
            config={deltaTimer}
            onNotify={onNotify}
            onSaved={setDeltaTimer}
          />
          <SubscriptionCard
            connId={connId}
            config={subscription}
            onNotify={onNotify}
            onSaved={setSubscription}
          />
          <SentenceFilterCard
            connId={connId}
            config={sentenceFilter}
            onNotify={onNotify}
            onSaved={setSentenceFilter}
          />
        </div>
      </section>

      <section className="page-group" id="operationsGroup">
        <div className="page-group-header">
          <h2>Operations & Monitoring</h2>
          <p>Track transmission quality, reliability, and runtime performance.</p>
        </div>
        <div className="page-group-content">
          <MetricsCard metrics={metrics} />
          {isV3 && (
            <>
              <NetworkQualityCard metrics={metrics} />
              <BandwidthCard metrics={metrics} />
              <PathAnalyticsCard metrics={metrics} />
              <CongestionControlCard data={congestion} />
              <BondingCard data={bonding} onFailover={handleFailover} />
              <MonitoringAlertsCard data={monitoring} />
            </>
          )}
          <StatusCard
            deltaTimer={deltaTimer}
            subscription={subscription}
            sentenceFilter={sentenceFilter}
          />
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
