"use strict";

/**
 * Registers control routes: /congestion, /delta-timer, /bonding, /bonding/failover
 *
 * @param {Object} router - Express router
 * @param {Object} ctx - Shared route context
 */
function register(router, ctx) {
  const { rateLimitMiddleware, requireJson, getFirstBundle } = ctx;

  router.get("/congestion", rateLimitMiddleware, (req, res) => {
    try {
      const bundle = getFirstBundle();
      if (!bundle) {return res.status(503).json({ error: "Plugin not started" });}
      const { state } = bundle;
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }

      if (!state.pipeline || !state.pipeline.getCongestionControl) {
        return res.status(503).json({ error: "Congestion control not initialized" });
      }

      const cc = state.pipeline.getCongestionControl();
      res.json(cc.getState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/delta-timer", rateLimitMiddleware, requireJson, (req, res) => {
    try {
      const bundle = getFirstBundle();
      if (!bundle) {return res.status(503).json({ error: "Plugin not started" });}
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
        return res.status(400).json({ error: "Invalid timer value. Must be between 100 and 10000ms" });
      }

      if (state.pipeline && state.pipeline.getCongestionControl) {
        state.pipeline.getCongestionControl().setManualDeltaTimer(value);
      }

      state.deltaTimerTime = value;

      res.json({ deltaTimer: value, mode: "manual" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get("/bonding", rateLimitMiddleware, (req, res) => {
    try {
      const bundle = getFirstBundle();
      if (!bundle) {return res.status(503).json({ error: "Plugin not started" });}
      const { state } = bundle;
      if (state.isServerMode) {
        return res.status(404).json({ error: "Not available in server mode" });
      }

      if (!state.pipeline || !state.pipeline.getBondingManager) {
        return res.status(503).json({ error: "Bonding not available" });
      }

      const bonding = state.pipeline.getBondingManager();
      if (!bonding) {
        return res.json({ enabled: false });
      }

      res.json(bonding.getState());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post("/bonding/failover", rateLimitMiddleware, (req, res) => {
    try {
      const bundle = getFirstBundle();
      if (!bundle) {return res.status(503).json({ error: "Plugin not started" });}
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
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { register };
