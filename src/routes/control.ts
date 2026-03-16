import { RouteRequest, RouteResponse, Router, RouteContext, InstanceBundle } from "./types";

/**
 * Registers control routes: /congestion, /delta-timer, /bonding, /bonding/failover
 *
 * @param router - Express router
 * @param ctx - Shared route context
 */
function register(router: Router, ctx: RouteContext): void {
  const {
    rateLimitMiddleware,
    requireJson,
    getFirstBundle,
    instanceRegistry,
    managementAuthMiddleware
  } = ctx;

  router.get(
    "/congestion",
    rateLimitMiddleware,
    managementAuthMiddleware("congestion.read"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (state.isServerMode) {
          return res.status(404).json({ error: "Not available in server mode" });
        }

        if (!state.pipeline || !state.pipeline.getCongestionControl) {
          return res.status(503).json({ error: "Congestion control not initialized" });
        }

        const cc = state.pipeline.getCongestionControl();
        res.json(cc.getState());
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.post(
    "/delta-timer",
    rateLimitMiddleware,
    managementAuthMiddleware("delta-timer.update"),
    requireJson,
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (state.isServerMode) {
          return res.status(404).json({ error: "Not available in server mode" });
        }

        const { value, mode } = req.body;

        if (mode === "auto") {
          if (state.pipeline && state.pipeline.getCongestionControl) {
            state.pipeline.getCongestionControl().enableAutoMode();
            return res.json({
              deltaTimer: state.pipeline.getCongestionControl().getCurrentDeltaTimer(),
              mode: "auto"
            });
          }
          return res.status(503).json({ error: "Congestion control not initialized" });
        }

        if (value === undefined || typeof value !== "number") {
          return res.status(400).json({ error: "value must be a number" });
        }

        if (value < 100 || value > 10000) {
          return res
            .status(400)
            .json({ error: "Invalid timer value. Must be between 100 and 10000ms" });
        }

        if (state.pipeline && state.pipeline.getCongestionControl) {
          state.pipeline.getCongestionControl().setManualDeltaTimer(value);
        }

        state.deltaTimerTime = value;

        res.json({ deltaTimer: value, mode: "manual" });
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.get(
    "/bonding",
    rateLimitMiddleware,
    managementAuthMiddleware("bonding.read"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const all = instanceRegistry.getAll();
        if (!all || all.length === 0) {
          return res.status(503).json({ error: "Plugin not started" });
        }

        const instances = all.map((bundle: InstanceBundle) => {
          const { state } = bundle;
          const bondingManager =
            state.pipeline && state.pipeline.getBondingManager
              ? state.pipeline.getBondingManager()
              : null;
          return {
            id: bundle.id,
            name: bundle.name,
            enabled: Boolean(bondingManager),
            state: bondingManager ? bondingManager.getState() : null
          };
        });

        const enabledCount = instances.filter((item) => item.enabled).length;
        res.json({
          totalInstances: instances.length,
          bondingEnabledInstances: enabledCount,
          instances
        });
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.post(
    "/bonding",
    rateLimitMiddleware,
    managementAuthMiddleware("bonding.update"),
    requireJson,
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const allowedKeys = new Set([
          "rttThreshold",
          "lossThreshold",
          "healthCheckInterval",
          "failbackDelay",
          "heartbeatTimeout"
        ]);
        const body = req.body || {};

        if (typeof body !== "object" || Array.isArray(body)) {
          return res.status(400).json({ error: "Request body must be a JSON object" });
        }

        const updates: Record<string, number> = {};
        for (const [key, value] of Object.entries(body)) {
          if (!allowedKeys.has(key)) {
            return res.status(400).json({ error: `Unsupported bonding setting '${key}'` });
          }
          const numericValue = Number(value);
          if (!Number.isFinite(numericValue) || numericValue < 0) {
            return res.status(400).json({ error: `${key} must be a non-negative number` });
          }
          updates[key] = numericValue;
        }

        if (Object.keys(updates).length === 0) {
          return res.status(400).json({ error: "At least one bonding setting must be provided" });
        }

        const updatedInstances: Array<{ id: string; thresholds: Record<string, number> }> = [];
        for (const bundle of instanceRegistry.getAll()) {
          const { state } = bundle;
          const bondingManager =
            state.pipeline && state.pipeline.getBondingManager
              ? state.pipeline.getBondingManager()
              : null;
          if (!bondingManager || !bondingManager.failoverThresholds) {
            continue;
          }
          Object.assign(bondingManager.failoverThresholds, updates);
          updatedInstances.push({
            id: bundle.id,
            thresholds: { ...bondingManager.failoverThresholds }
          });
        }

        if (updatedInstances.length === 0) {
          return res.status(503).json({ error: "No bonding-enabled instances available" });
        }

        res.json({ success: true, updated: updates, instances: updatedInstances });
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );

  router.post(
    "/bonding/failover",
    rateLimitMiddleware,
    managementAuthMiddleware("bonding.failover"),
    (req: RouteRequest, res: RouteResponse) => {
      try {
        const bundle = getFirstBundle();
        if (!bundle) {
          return res.status(503).json({ error: "Plugin not started" });
        }
        const { state } = bundle;
        if (state.isServerMode) {
          return res.status(404).json({ error: "Not available in server mode" });
        }

        if (!state.pipeline || !state.pipeline.getBondingManager) {
          return res.status(503).json({ error: "Bonding not available" });
        }

        const bonding = state.pipeline.getBondingManager();
        if (!bonding) {
          return res.status(503).json({ error: "Bonding not enabled" });
        }

        bonding.forceFailover();

        res.json({
          success: true,
          activeLink: bonding.getActiveLinkName(),
          links: bonding.getLinkHealth()
        });
      } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    }
  );
}

export { register };
