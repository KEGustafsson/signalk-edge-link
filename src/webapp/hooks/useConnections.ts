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
        const data: ConnectionInfo[] = await res.json();
        if (data.length > 0) {
          setConnections(data);
          return;
        }
      }
    } catch {
      // /connections not available — fall through to legacy fallback
    }
    setConnections((prev) =>
      prev.length > 0 ? prev : [{ id: "_legacy", name: "Default", type: "client" }]
    );
  }, [request]);

  useEffect(() => {
    fetchConnections();
  }, [fetchConnections]);

  return { connections, refetch: fetchConnections };
}
