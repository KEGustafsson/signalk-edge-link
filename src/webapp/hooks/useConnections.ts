import { useState, useEffect, useCallback } from "react";
import { ConnectionInfo } from "../types";
import { API_BASE } from "../utils";
import { useApi } from "./useApi";

export function useConnections() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const { request } = useApi();

  const fetchConnections = useCallback(async () => {
    try {
      const res = await request(`${API_BASE}/connections`);
      if (res.ok) {
        // An empty array is an answer, not a failure. The plugin aborts its
        // whole start when any connection fails validation, so `[]` genuinely
        // means "nothing is running" — treating it as "keep whatever we had"
        // left stale tabs on screen and sent the metrics poller after instance
        // IDs that no longer exist, reporting HTTP 404 instead of the truth.
        const data: ConnectionInfo[] = await res.json();
        setConnections(Array.isArray(data) ? data : []);
        return;
      }
    } catch {
      // /connections not available — fall through to legacy fallback
    }
    // Reached only when the endpoint is missing or errored: an older plugin
    // build, or a transport failure. Keep what we have rather than blanking a
    // working dashboard.
    setConnections((prev) =>
      prev.length > 0 ? prev : [{ id: "_legacy", name: "Default", type: "client" }]
    );
  }, [request]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  return { connections, refetch: fetchConnections };
}
