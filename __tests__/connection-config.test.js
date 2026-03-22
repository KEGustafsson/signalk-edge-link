/* eslint-disable no-undef */
const { validateConnectionConfig } = require("../lib/connection-config");

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
});
