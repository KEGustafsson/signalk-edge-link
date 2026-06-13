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
    let stopped = false;
    let controller: AbortController | null = null;

    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        controller = new AbortController();
        const res = await request(path, { signal: controller.signal });
        if (!stopped && res.ok) onDataRef.current(await res.json());
      } catch {
        // ignore transient errors and abort errors
      } finally {
        inFlight = false;
        controller = null;
      }
    };

    poll();
    const timer = setInterval(poll, METRICS_REFRESH_INTERVAL);
    return () => {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [connId, request]);
}
