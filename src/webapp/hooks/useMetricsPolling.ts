import { useEffect, useRef } from "react";
import { MetricsData } from "../types";
import { metricsPath, METRICS_REFRESH_INTERVAL } from "../utils";
import { useApi, ApiError } from "./useApi";

/**
 * Poll a connection's metrics endpoint.
 *
 * `onError` is reported at most once per failure streak (and again after a
 * recovery), so a persistent 401/429/503 surfaces to the operator instead of
 * leaving the dashboard on "Loading metrics…" forever. Aborts from unmount or a
 * connection switch are never reported.
 */
export function useMetricsPolling(
  connId: string | null,
  onData: (metrics: MetricsData) => void,
  onError?: (message: string, err: ApiError) => void
) {
  const { request, authMessage } = useApi();
  const onDataRef = useRef(onData);
  onDataRef.current = onData;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    if (!connId) return;

    const path = metricsPath(connId);
    let inFlight = false;
    let stopped = false;
    let controller: AbortController | null = null;
    let reportedFailure = false;

    const report = (message: string, err: ApiError) => {
      if (reportedFailure) return;
      reportedFailure = true;
      onErrorRef.current?.(message, err);
    };

    const poll = async () => {
      if (inFlight || stopped) return;
      inFlight = true;
      try {
        controller = new AbortController();
        const res = await request(path, { signal: controller.signal });
        if (stopped) return;
        if (res.ok) {
          reportedFailure = false;
          onDataRef.current(await res.json());
        } else {
          const httpError = Object.assign(new Error(`HTTP ${res.status}`), {
            status: res.status,
            isUnauthorized: res.status === 401 || res.status === 403
          }) as ApiError;
          report(
            httpError.isUnauthorized
              ? authMessage("polling metrics")
              : `Metrics unavailable (HTTP ${res.status})`,
            httpError
          );
        }
      } catch (err: unknown) {
        const e = err as ApiError;
        // An abort is our own teardown, not a failure worth surfacing.
        if (stopped || e?.name === "AbortError") return;
        report(
          e?.isUnauthorized ? authMessage("polling metrics") : `Metrics unavailable: ${e?.message}`,
          e
        );
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
  }, [connId, request, authMessage]);
}
