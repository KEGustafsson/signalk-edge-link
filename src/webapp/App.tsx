import React, { useState, useEffect, useCallback } from "react";
import { ConnectionInfo, MetricsData } from "./types";
import { API_BASE } from "./utils";
import { useConnections } from "./hooks/useConnections";
import { useMetricsPolling } from "./hooks/useMetricsPolling";
import { useApi, ApiError } from "./hooks/useApi";
import { ConnectionTabs } from "./components/ConnectionTabs";
import { ServerDashboard } from "./components/ServerDashboard";
import { ClientDashboard } from "./components/ClientDashboard";
import { Notification } from "./components/Notification";

interface NotificationState {
  message: string;
  type: string;
}

export function App() {
  const { connections, refetch: refetchConnections } = useConnections();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<MetricsData | null>(null);
  const [pluginConfig, setPluginConfig] = useState<Record<string, unknown> | null>(null);
  const [pluginSchema, setPluginSchema] = useState<Record<string, unknown> | null>(null);
  const [notification, setNotification] = useState<NotificationState | null>(null);
  const { request, authMessage } = useApi();

  useEffect(() => {
    if (connections.length === 0) {
      setActiveId(null);
      return;
    }
    if (!activeId || !connections.some((c) => c.id === activeId)) {
      setActiveId(connections[0].id);
    }
  }, [connections, activeId]);

  useEffect(() => {
    setMetrics(null);
  }, [activeId]);

  useEffect(() => {
    const load = async () => {
      try {
        const [cfgRes, schemaRes] = await Promise.all([
          request(`${API_BASE}/plugin-config`),
          request(`${API_BASE}/plugin-schema`)
        ]);

        if (!cfgRes.ok) return;
        const cfgData = await cfgRes.json();
        const cfg =
          cfgData?.configuration &&
          typeof cfgData.configuration === "object" &&
          !Array.isArray(cfgData.configuration)
            ? cfgData.configuration
            : {};
        setPluginConfig(cfg);

        if (schemaRes.ok) {
          const schemaData = await schemaRes.json();
          if (schemaData?.schema && typeof schemaData.schema === "object") {
            setPluginSchema(schemaData.schema);
          }
        }
      } catch (err: unknown) {
        const e = err as ApiError;
        if (!e.isUnauthorized) return;
        notify(authMessage("loading plugin config"), "warning");
      }
    };
    load();
  }, [request, authMessage]);

  const notify = useCallback((message: string, type: string) => {
    setNotification({ message, type });
  }, []);

  const [metricsTick, setMetricsTick] = useState(0);
  useMetricsPolling(
    activeId,
    (data) => {
      setMetrics(data);
      refetchConnections();
      // Drives the dashboards' v3 monitoring/congestion/bonding refresh so
      // those cards track the same 15s cadence as the metrics card.
      setMetricsTick((t) => t + 1);
    },
    (message) => notify(message, "error")
  );

  const activeConnection: ConnectionInfo | undefined = connections.find((c) => c.id === activeId);
  const activeIndex = connections.findIndex((c) => c.id === activeId);

  return (
    <div id="app">
      <header className="header">
        <h1>SignalK Edge Link</h1>
        <p className="subtitle">Configuration and runtime monitoring</p>
      </header>

      {notification && (
        <Notification
          message={notification.message}
          type={notification.type}
          onDismiss={() => setNotification(null)}
        />
      )}

      <ConnectionTabs connections={connections} activeId={activeId} onSelect={setActiveId} />

      <div className="container">
        {/*
          `key={activeId}` remounts the dashboard on every connection switch.
          Without it React reuses the component across client→client switches,
          so if the newly-selected connection's config request fails the cards
          keep showing the PREVIOUS connection's values — and Save would write
          them to the new connection's config file.
        */}
        {activeId && activeConnection?.type === "server" ? (
          <ServerDashboard
            key={activeId}
            connId={activeId}
            metrics={metrics}
            refreshTick={metricsTick}
            pluginConfig={pluginConfig}
            pluginSchema={pluginSchema}
            activeConnectionIndex={Math.max(activeIndex, 0)}
            onNotify={notify}
            onPluginConfigSaved={setPluginConfig}
          />
        ) : activeId ? (
          <ClientDashboard
            key={activeId}
            connId={activeId}
            metrics={metrics}
            refreshTick={metricsTick}
            pluginConfig={pluginConfig}
            pluginSchema={pluginSchema}
            activeConnectionIndex={Math.max(activeIndex, 0)}
            onNotify={notify}
            onPluginConfigSaved={setPluginConfig}
          />
        ) : (
          <p>Loading connections…</p>
        )}
      </div>
    </div>
  );
}
