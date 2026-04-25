/* eslint-disable no-undef */
const {
  validateConnectionConfig,
  sanitizeConnectionConfig,
  normalizeServerType
} = require("../lib/connection-config");

/**
 * Minimal valid client config for building test cases.
 */
function makeValidClient(overrides = {}) {
  return {
    serverType: "client",
    udpPort: 4567,
    udpAddress: "192.168.1.1",
    secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#",
    testAddress: "192.168.1.1",
    testPort: 80,
    protocolVersion: 2,
    ...overrides
  };
}

function makeValidServer(overrides = {}) {
  return {
    serverType: "server",
    udpPort: 4567,
    secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#",
    protocolVersion: 2,
    ...overrides
  };
}

describe("validateConnectionConfig", () => {
  describe("bonding primary != backup validation", () => {
    test("rejects bonding with identical primary and backup address:port", () => {
      const config = makeValidClient({
        bonding: {
          enabled: true,
          mode: "main-backup",
          primary: { address: "10.0.0.1", port: 5000 },
          backup: { address: "10.0.0.1", port: 5000 }
        }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/primary and backup links must use different/);
    });

    test("accepts bonding with different addresses", () => {
      const config = makeValidClient({
        bonding: {
          enabled: true,
          mode: "main-backup",
          primary: { address: "10.0.0.1", port: 5000 },
          backup: { address: "10.0.0.2", port: 5000 }
        }
      });
      const error = validateConnectionConfig(config);
      expect(error).toBeNull();
    });

    test("accepts bonding with different ports", () => {
      const config = makeValidClient({
        bonding: {
          enabled: true,
          mode: "main-backup",
          primary: { address: "10.0.0.1", port: 5000 },
          backup: { address: "10.0.0.1", port: 5001 }
        }
      });
      const error = validateConnectionConfig(config);
      expect(error).toBeNull();
    });

    test("accepts bonding when only primary is specified", () => {
      const config = makeValidClient({
        bonding: {
          enabled: true,
          mode: "main-backup",
          primary: { address: "10.0.0.1", port: 5000 }
        }
      });
      const error = validateConnectionConfig(config);
      expect(error).toBeNull();
    });
  });

  describe("basic validation", () => {
    test("returns null for valid client config", () => {
      expect(validateConnectionConfig(makeValidClient())).toBeNull();
    });

    test("rejects non-object input", () => {
      expect(validateConnectionConfig(null)).not.toBeNull();
      expect(validateConnectionConfig("string")).not.toBeNull();
    });

    test("rejects invalid port", () => {
      const error = validateConnectionConfig(makeValidClient({ udpPort: 100 }));
      expect(error).toMatch(/udpPort/);
    });

    test("rejects invalid protocol version", () => {
      const error = validateConnectionConfig(makeValidClient({ protocolVersion: 4 }));
      expect(error).toMatch(/protocolVersion/);
    });
  });

  describe("server mode validation", () => {
    test("valid server config passes", () => {
      expect(validateConnectionConfig(makeValidServer())).toBeNull();
    });

    test("server config with congestionControl errors", () => {
      const config = makeValidServer({ congestionControl: { enabled: true } });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/congestionControl.*not supported in server mode/);
    });

    test("server config with bonding errors", () => {
      const config = makeValidServer({ bonding: { enabled: true } });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/bonding.*not supported in server mode/);
    });

    test("server config with alertThresholds errors", () => {
      const config = makeValidServer({ alertThresholds: { rtt: { warning: 100 } } });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/alertThresholds.*not supported in server mode/);
    });
  });

  describe("reliability config validation", () => {
    test("server reliability with ackInterval out of range errors", () => {
      const config = makeValidServer({ reliability: { ackInterval: 5 } });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/ackInterval/);
    });

    test("client reliability with retransmitQueueSize out of range errors", () => {
      const config = makeValidClient({ reliability: { retransmitQueueSize: 50 } });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/retransmitQueueSize/);
    });

    test("client reliability with retransmitMinAge > retransmitMaxAge errors", () => {
      const config = makeValidClient({
        reliability: { retransmitMinAge: 20000, retransmitMaxAge: 5000 }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/retransmitMinAge must be <= retransmitMaxAge/);
    });

    test("forceDrainAfterAckIdle as non-boolean errors", () => {
      const config = makeValidClient({
        reliability: { forceDrainAfterAckIdle: "yes" }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/forceDrainAfterAckIdle must be a boolean/);
    });

    test("recoveryBurstEnabled as non-boolean errors", () => {
      const config = makeValidClient({
        reliability: { recoveryBurstEnabled: 1 }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/recoveryBurstEnabled must be a boolean/);
    });
  });

  describe("congestion control validation", () => {
    test("congestionControl as non-object errors", () => {
      const config = makeValidClient({ congestionControl: "fast" });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/congestionControl must be an object/);
    });

    test("targetRTT out of range errors", () => {
      const config = makeValidClient({ congestionControl: { targetRTT: 5000 } });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/targetRTT/);
    });

    test("maxDeltaTimer out of range errors", () => {
      const config = makeValidClient({
        congestionControl: { maxDeltaTimer: 50000 }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/maxDeltaTimer/);
    });

    test("congestionControl.enabled as non-boolean errors", () => {
      const config = makeValidClient({ congestionControl: { enabled: "true" } });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/congestionControl\.enabled must be a boolean/);
    });
  });

  describe("alert thresholds validation", () => {
    test("unknown metric name errors", () => {
      const config = makeValidClient({
        alertThresholds: { bandwidth: { warning: 100 } }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/unknown metric 'bandwidth'/);
    });

    test("ratio metric warning > 1 errors", () => {
      const config = makeValidClient({
        alertThresholds: { packetLoss: { warning: 1.5 } }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/packetLoss\.warning must be between 0 and 1/);
    });

    test("absolute metric warning <= 0 errors", () => {
      const config = makeValidClient({
        alertThresholds: { rtt: { warning: 0 } }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/rtt\.warning must be > 0/);
    });

    test("warning > critical errors", () => {
      const config = makeValidClient({
        alertThresholds: { rtt: { warning: 500, critical: 100 } }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/warning must be <= critical/);
    });
  });

  describe("bonding failover thresholds", () => {
    test("failover as non-object errors", () => {
      const config = makeValidClient({
        bonding: { enabled: true, mode: "main-backup", failover: "auto" }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/bonding\.failover must be an object/);
    });

    test("rttThreshold out of range errors", () => {
      const config = makeValidClient({
        bonding: {
          enabled: true,
          mode: "main-backup",
          failover: { rttThreshold: 50 }
        }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/rttThreshold/);
    });

    test("lossThreshold out of range errors", () => {
      const config = makeValidClient({
        bonding: {
          enabled: true,
          mode: "main-backup",
          failover: { lossThreshold: 0.9 }
        }
      });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/lossThreshold/);
    });
  });

  describe("client mode requirements", () => {
    test("missing udpAddress errors", () => {
      const config = makeValidClient({ udpAddress: undefined });
      delete config.udpAddress;
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/udpAddress is required/);
    });

    test("missing testAddress errors", () => {
      const config = makeValidClient({ testAddress: undefined });
      delete config.testAddress;
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/testAddress is required/);
    });

    test("invalid testPort errors", () => {
      const config = makeValidClient({ testPort: -1 });
      const error = validateConnectionConfig(config);
      expect(error).not.toBeNull();
      expect(error).toMatch(/testPort/);
    });
  });
});

describe("sanitizeConnectionConfig", () => {
  test("null input returns empty object", () => {
    expect(sanitizeConnectionConfig(null)).toEqual({});
  });

  test("server mode removes client-only fields", () => {
    const config = {
      serverType: "server",
      udpPort: 4567,
      secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#",
      udpAddress: "192.168.1.1",
      testAddress: "192.168.1.1",
      testPort: 80,
      congestionControl: { enabled: true },
      bonding: { enabled: true },
      alertThresholds: { rtt: { warning: 100 } }
    };
    const result = sanitizeConnectionConfig(config);
    expect(result.udpAddress).toBeUndefined();
    expect(result.testAddress).toBeUndefined();
    expect(result.testPort).toBeUndefined();
    expect(result.congestionControl).toBeUndefined();
    expect(result.bonding).toBeUndefined();
    expect(result.alertThresholds).toBeUndefined();
    expect(result.serverType).toBe("server");
  });

  test("serverType: true normalizes to 'server'", () => {
    const config = {
      serverType: true,
      udpPort: 4567,
      secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#"
    };
    const result = sanitizeConnectionConfig(config);
    expect(result.serverType).toBe("server");
  });

  test("serverType: false normalizes to 'client'", () => {
    const config = {
      serverType: false,
      udpPort: 4567,
      secretKey: "aB3$dEf7gH9!jKlMnO1pQrStUvWxYz0#"
    };
    const result = sanitizeConnectionConfig(config);
    expect(result.serverType).toBe("client");
  });

  test("preserves valid keys in client mode", () => {
    const config = makeValidClient({
      useMsgpack: true,
      reliability: { retransmitQueueSize: 500 }
    });
    const result = sanitizeConnectionConfig(config);
    expect(result.serverType).toBe("client");
    expect(result.udpPort).toBe(4567);
    expect(result.udpAddress).toBe("192.168.1.1");
    expect(result.useMsgpack).toBe(true);
    expect(result.reliability).toEqual({ retransmitQueueSize: 500 });
  });
});

describe("skipOwnData validation", () => {
  test("accepts skipOwnData on a client connection", () => {
    expect(validateConnectionConfig(makeValidClient({ skipOwnData: true }))).toBeNull();
    expect(validateConnectionConfig(makeValidClient({ skipOwnData: false }))).toBeNull();
  });

  test("rejects skipOwnData on a server connection", () => {
    const err = validateConnectionConfig(makeValidServer({ skipOwnData: true }));
    expect(err).toMatch(/skipOwnData is not supported in server mode/);
  });

  test("rejects non-boolean skipOwnData", () => {
    const err = validateConnectionConfig(makeValidClient({ skipOwnData: "yes" }));
    expect(err).toMatch(/skipOwnData must be a boolean/);
  });

  test("sanitizeConnectionConfig drops skipOwnData on server connections", () => {
    const sanitized = sanitizeConnectionConfig(makeValidServer({ skipOwnData: true }));
    expect(sanitized.skipOwnData).toBeUndefined();
  });

  test("sanitizeConnectionConfig preserves skipOwnData on client connections", () => {
    const sanitized = sanitizeConnectionConfig(makeValidClient({ skipOwnData: true }));
    expect(sanitized.skipOwnData).toBe(true);
  });
});

describe("normalizeServerType", () => {
  test("true returns 'server'", () => {
    expect(normalizeServerType(true)).toBe("server");
  });

  test("false returns 'client'", () => {
    expect(normalizeServerType(false)).toBe("client");
  });

  test("'server' passes through", () => {
    expect(normalizeServerType("server")).toBe("server");
  });
});
