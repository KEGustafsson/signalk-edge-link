import { useEffect, useRef } from "react";
import { MetricsData } from "../types";
import { metricsPath, METRICS_REFRESH_INTERVAL } from "../utils";
import { useApi } from "./useApi";

export function useMetricsPolling(connId: string | null, onData: (metrics: MetricsData) => void) {
  const { request } = useApi();
  const onDataRef = useRef(onData);
  onDataRef.current = onData;

  useEffect(() => {
    if (!connId) return;

    const path = metricsPath(connId);
    let inFlight = false;

    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await request(path);
        if (res.ok) onDataRef.current(await res.json());
      } catch {
        // ignore transient errors
      } finally {
        inFlight = false;
      }
    };

    poll();
    const timer = setInterval(poll, METRICS_REFRESH_INTERVAL);
    return () => clearInterval(timer);
  }, [connId, request]);
}
