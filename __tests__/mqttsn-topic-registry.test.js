"use strict";

const { TopicRegistry, skPathToTopic, topicToSkPath } = require("../lib/mqttsn-topic-registry");

// ── TopicRegistry ─────────────────────────────────────────────────────────────

describe("TopicRegistry.assign", () => {
  test("returns sequential IDs starting at 1", () => {
    const r = new TopicRegistry();
    expect(r.assign("sk/nav/speed")).toBe(1);
    expect(r.assign("sk/nav/heading")).toBe(2);
  });

  test("same topic name always returns the same ID", () => {
    const r = new TopicRegistry();
    expect(r.assign("sk/nav/speed")).toBe(1);
    expect(r.assign("sk/nav/speed")).toBe(1);
  });

  test("different topics get different IDs", () => {
    const r = new TopicRegistry();
    const id1 = r.assign("sk/nav/speed");
    const id2 = r.assign("sk/nav/heading");
    expect(id1).not.toBe(id2);
  });
});

describe("TopicRegistry.getIdForName / getNameForId", () => {
  test("round-trip after assign", () => {
    const r = new TopicRegistry();
    const id = r.assign("sk/nav/speed");
    expect(r.getIdForName("sk/nav/speed")).toBe(id);
    expect(r.getNameForId(id)).toBe("sk/nav/speed");
  });

  test("returns undefined for unknown name", () => {
    const r = new TopicRegistry();
    expect(r.getIdForName("sk/unknown")).toBeUndefined();
  });

  test("returns undefined for unknown id", () => {
    const r = new TopicRegistry();
    expect(r.getNameForId(999)).toBeUndefined();
  });
});

describe("TopicRegistry.set", () => {
  test("stores client-assigned ID", () => {
    const r = new TopicRegistry();
    r.set("sk/nav/speed", 42);
    expect(r.getIdForName("sk/nav/speed")).toBe(42);
    expect(r.getNameForId(42)).toBe("sk/nav/speed");
  });

  test("set overwrites existing mapping and removes stale reverse entry", () => {
    const r = new TopicRegistry();
    r.set("sk/nav/speed", 1);
    r.set("sk/nav/speed", 99);
    expect(r.getIdForName("sk/nav/speed")).toBe(99);
    expect(r.getNameForId(99)).toBe("sk/nav/speed");
    expect(r.getNameForId(1)).toBeUndefined();
  });
});

describe("TopicRegistry.clear", () => {
  test("resets all mappings", () => {
    const r = new TopicRegistry();
    r.assign("sk/nav/speed");
    r.set("sk/nav/heading", 5);
    r.clear();
    expect(r.getIdForName("sk/nav/speed")).toBeUndefined();
    expect(r.getIdForName("sk/nav/heading")).toBeUndefined();
  });

  test("ID counter resets after clear", () => {
    const r = new TopicRegistry();
    r.assign("sk/a");
    r.assign("sk/b");
    r.clear();
    expect(r.assign("sk/a")).toBe(1);
  });
});

// ── skPathToTopic ─────────────────────────────────────────────────────────────

describe("skPathToTopic", () => {
  test("converts dots to slashes and prepends prefix", () => {
    expect(skPathToTopic("navigation.speedOverGround", "sk")).toBe("sk/navigation/speedOverGround");
  });

  test("handles single-segment path", () => {
    expect(skPathToTopic("depth", "vessel")).toBe("vessel/depth");
  });

  test("handles deep path", () => {
    expect(skPathToTopic("propulsion.0.rpm", "sk")).toBe("sk/propulsion/0/rpm");
  });

  test("throws on MQTT wildcard characters in path", () => {
    expect(() => skPathToTopic("nav/#/speed", "sk")).toThrow();
    expect(() => skPathToTopic("nav/+/speed", "sk")).toThrow();
  });
});

// ── topicToSkPath ─────────────────────────────────────────────────────────────

describe("topicToSkPath", () => {
  test("converts slashes to dots and strips prefix", () => {
    expect(topicToSkPath("sk/navigation/speedOverGround", "sk")).toBe("navigation.speedOverGround");
  });

  test("returns null when prefix does not match", () => {
    expect(topicToSkPath("other/navigation/speed", "sk")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(topicToSkPath("", "sk")).toBeNull();
  });

  test("handles deep topics", () => {
    expect(topicToSkPath("sk/propulsion/0/rpm", "sk")).toBe("propulsion.0.rpm");
  });
});
