"use strict";

const {
  PATH_TO_ID,
  ID_TO_PATH,
  PATH_CATEGORIES,
  encodePath,
  decodePath,
  encodeDelta,
  decodeDelta,
  getAllPaths,
  getPathsByCategory,
  getDictionarySize
} = require("../lib/pathDictionary");

describe("Path Dictionary", () => {
  describe("PATH_TO_ID mapping", () => {
    test("should have navigation paths", () => {
      expect(PATH_TO_ID["navigation.position"]).toBe(0x0101);
      expect(PATH_TO_ID["navigation.speedOverGround"]).toBe(0x0107);
      expect(PATH_TO_ID["navigation.headingTrue"]).toBe(0x010b);
    });

    test("should have environment paths", () => {
      expect(PATH_TO_ID["environment.wind.speedApparent"]).toBe(0x022a);
      expect(PATH_TO_ID["environment.depth.belowKeel"]).toBe(0x0215);
    });

    test("should have electrical paths", () => {
      expect(PATH_TO_ID["electrical.batteries.voltage"]).toBe(0x0301);
    });

    test("should have propulsion paths", () => {
      expect(PATH_TO_ID["propulsion.revolutions"]).toBe(0x0402);
    });

    test("should have all expected categories", () => {
      const paths = Object.keys(PATH_TO_ID);
      expect(paths.some((p) => p.startsWith("navigation."))).toBe(true);
      expect(paths.some((p) => p.startsWith("environment."))).toBe(true);
      expect(paths.some((p) => p.startsWith("electrical."))).toBe(true);
      expect(paths.some((p) => p.startsWith("propulsion."))).toBe(true);
      expect(paths.some((p) => p.startsWith("steering."))).toBe(true);
      expect(paths.some((p) => p.startsWith("tanks."))).toBe(true);
    });
  });

  describe("ID_TO_PATH mapping", () => {
    test("should be inverse of PATH_TO_ID", () => {
      expect(ID_TO_PATH[0x0101]).toBe("navigation.position");
      expect(ID_TO_PATH[0x022a]).toBe("environment.wind.speedApparent");
    });

    test("should have same size as PATH_TO_ID", () => {
      expect(Object.keys(ID_TO_PATH).length).toBe(Object.keys(PATH_TO_ID).length);
    });
  });

  describe("PATH_CATEGORIES", () => {
    test("should have all expected categories", () => {
      expect(PATH_CATEGORIES.navigation).toBeDefined();
      expect(PATH_CATEGORIES.environment).toBeDefined();
      expect(PATH_CATEGORIES.electrical).toBeDefined();
      expect(PATH_CATEGORIES.propulsion).toBeDefined();
      expect(PATH_CATEGORIES.steering).toBeDefined();
      expect(PATH_CATEGORIES.tanks).toBeDefined();
      expect(PATH_CATEGORIES.communication).toBeDefined();
      expect(PATH_CATEGORIES.notifications).toBeDefined();
      expect(PATH_CATEGORIES.design).toBeDefined();
      expect(PATH_CATEGORIES.performance).toBeDefined();
      expect(PATH_CATEGORIES.sails).toBeDefined();
      expect(PATH_CATEGORIES.networking).toBeDefined();
    });

    test("should have required properties for each category", () => {
      for (const [key, category] of Object.entries(PATH_CATEGORIES)) {
        expect(category.name).toBeDefined();
        expect(category.description).toBeDefined();
        expect(category.prefix).toBeDefined();
        expect(category.prefix).toBe(`${key}.`);
      }
    });
  });

  describe("encodePath", () => {
    test("should encode known paths to numeric IDs", () => {
      expect(encodePath("navigation.position")).toBe(0x0101);
      expect(encodePath("environment.wind.speedApparent")).toBe(0x022a);
      expect(encodePath("electrical.batteries.voltage")).toBe(0x0301);
    });

    test("should return original path for unknown paths", () => {
      expect(encodePath("unknown.path.here")).toBe("unknown.path.here");
      expect(encodePath("custom.sensor.value")).toBe("custom.sensor.value");
    });

    test("should handle wildcard patterns with instance IDs", () => {
      // electrical.batteries.1.voltage should match electrical.batteries.voltage
      expect(encodePath("electrical.batteries.1.voltage")).toBe(0x0301);
      expect(encodePath("tanks.fuel.0.currentLevel")).toBe(0x060a);
    });

    test("should handle paths with multiple instance IDs", () => {
      // Even with multiple numbers, should still try to match
      const result = encodePath("propulsion.0.revolutions");
      // This should match propulsion.revolutions pattern
      expect(result).toBe(0x0402);
    });

    test("should return original for paths that dont match after stripping", () => {
      expect(encodePath("completely.unknown.1.path")).toBe("completely.unknown.1.path");
    });
  });

  describe("decodePath", () => {
    test("should decode numeric IDs to paths", () => {
      expect(decodePath(0x0101)).toBe("navigation.position");
      expect(decodePath(0x022a)).toBe("environment.wind.speedApparent");
    });

    test("should return original value for non-numeric IDs", () => {
      expect(decodePath("navigation.position")).toBe("navigation.position");
      expect(decodePath("unknown.path")).toBe("unknown.path");
    });

    test("should return original for unknown numeric IDs", () => {
      expect(decodePath(0xffff)).toBe(0xffff);
    });

    test("should handle string numbers", () => {
      // String "257" should not be decoded as numeric
      expect(decodePath("257")).toBe("257");
    });
  });

  describe("encodeDelta", () => {
    test("should encode paths in delta updates", () => {
      const delta = {
        context: "vessels.self",
        updates: [
          {
            values: [
              { path: "navigation.position", value: { latitude: 60.0, longitude: 25.0 } },
              { path: "navigation.speedOverGround", value: 5.5 }
            ]
          }
        ]
      };

      const encoded = encodeDelta(delta);

      expect(encoded.updates[0].values[0].path).toBe(0x0101);
      expect(encoded.updates[0].values[1].path).toBe(0x0107);
      expect(encoded.context).toBe("vessels.self");
    });

    test("should preserve values when encoding", () => {
      const delta = {
        updates: [
          {
            values: [{ path: "navigation.position", value: { latitude: 60.0, longitude: 25.0 } }]
          }
        ]
      };

      const encoded = encodeDelta(delta);

      expect(encoded.updates[0].values[0].value).toEqual({ latitude: 60.0, longitude: 25.0 });
    });

    test("should handle unknown paths", () => {
      const delta = {
        updates: [
          {
            values: [{ path: "custom.unknown.path", value: 123 }]
          }
        ]
      };

      const encoded = encodeDelta(delta);

      expect(encoded.updates[0].values[0].path).toBe("custom.unknown.path");
    });

    test("should return null/undefined unchanged", () => {
      expect(encodeDelta(null)).toBe(null);
      expect(encodeDelta(undefined)).toBe(undefined);
    });

    test("should handle delta without updates", () => {
      const delta = { context: "vessels.self" };
      expect(encodeDelta(delta)).toEqual(delta);
    });

    test("should handle empty values array", () => {
      const delta = {
        updates: [{ values: [] }]
      };
      const encoded = encodeDelta(delta);
      expect(encoded.updates[0].values).toEqual([]);
    });

    test("should not mutate original delta", () => {
      const delta = {
        updates: [
          {
            values: [{ path: "navigation.position", value: 1 }]
          }
        ]
      };

      encodeDelta(delta);

      expect(delta.updates[0].values[0].path).toBe("navigation.position");
    });
  });

  describe("decodeDelta", () => {
    test("should decode numeric IDs in delta updates", () => {
      const delta = {
        context: "vessels.self",
        updates: [
          {
            values: [
              { path: 0x0101, value: { latitude: 60.0, longitude: 25.0 } },
              { path: 0x0107, value: 5.5 }
            ]
          }
        ]
      };

      const decoded = decodeDelta(delta);

      expect(decoded.updates[0].values[0].path).toBe("navigation.position");
      expect(decoded.updates[0].values[1].path).toBe("navigation.speedOverGround");
    });

    test("should preserve string paths", () => {
      const delta = {
        updates: [
          {
            values: [{ path: "custom.path", value: 123 }]
          }
        ]
      };

      const decoded = decodeDelta(delta);

      expect(decoded.updates[0].values[0].path).toBe("custom.path");
    });

    test("should return null/undefined unchanged", () => {
      expect(decodeDelta(null)).toBe(null);
      expect(decodeDelta(undefined)).toBe(undefined);
    });

    test("should handle delta without updates", () => {
      const delta = { context: "vessels.self" };
      expect(decodeDelta(delta)).toEqual(delta);
    });

    test("should not mutate original delta", () => {
      const delta = {
        updates: [
          {
            values: [{ path: 0x0101, value: 1 }]
          }
        ]
      };

      decodeDelta(delta);

      expect(delta.updates[0].values[0].path).toBe(0x0101);
    });
  });

  describe("encodeDelta/decodeDelta round-trip", () => {
    test("should preserve data through encode/decode cycle", () => {
      const original = {
        context: "vessels.urn:mrn:imo:mmsi:123456789",
        updates: [
          {
            timestamp: "2024-01-01T00:00:00.000Z",
            source: { label: "test" },
            values: [
              { path: "navigation.position", value: { latitude: 60.123, longitude: 25.456 } },
              { path: "environment.wind.speedApparent", value: 10.5 },
              { path: "custom.unknown.path", value: "test" }
            ]
          }
        ]
      };

      const encoded = encodeDelta(original);
      const decoded = decodeDelta(encoded);

      // Known paths should round-trip
      expect(decoded.updates[0].values[0].path).toBe("navigation.position");
      expect(decoded.updates[0].values[1].path).toBe("environment.wind.speedApparent");
      // Unknown paths should be preserved
      expect(decoded.updates[0].values[2].path).toBe("custom.unknown.path");
      // Values should be preserved
      expect(decoded.updates[0].values[0].value).toEqual({ latitude: 60.123, longitude: 25.456 });
    });
  });

  describe("getAllPaths", () => {
    test("should return array of all paths", () => {
      const paths = getAllPaths();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);
    });

    test("should include known paths", () => {
      const paths = getAllPaths();
      expect(paths).toContain("navigation.position");
      expect(paths).toContain("environment.wind.speedApparent");
      expect(paths).toContain("electrical.batteries.voltage");
    });

    test("should return same count as dictionary size", () => {
      const paths = getAllPaths();
      expect(paths.length).toBe(getDictionarySize());
    });
  });

  describe("getPathsByCategory", () => {
    test("should return navigation paths", () => {
      const paths = getPathsByCategory("navigation");
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p.startsWith("navigation."))).toBe(true);
    });

    test("should return environment paths", () => {
      const paths = getPathsByCategory("environment");
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.every((p) => p.startsWith("environment."))).toBe(true);
    });

    test("should return empty array for unknown category", () => {
      const paths = getPathsByCategory("nonexistent");
      expect(paths).toEqual([]);
    });

    test("should return paths for all categories", () => {
      for (const category of Object.keys(PATH_CATEGORIES)) {
        const paths = getPathsByCategory(category);
        expect(paths.length).toBeGreaterThan(0);
      }
    });
  });

  describe("getDictionarySize", () => {
    test("should return number of paths", () => {
      const size = getDictionarySize();
      expect(typeof size).toBe("number");
      expect(size).toBeGreaterThan(100); // We know we have 170+ paths
    });

    test("should match PATH_TO_ID object keys", () => {
      expect(getDictionarySize()).toBe(Object.keys(PATH_TO_ID).length);
    });
  });
});
