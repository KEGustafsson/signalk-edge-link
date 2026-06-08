"use strict";

const {
  ok,
  err,
  isOk,
  isErr,
  unwrap,
  unwrapOr,
  EdgeLinkError,
  DecryptError,
  PacketParseError,
  ConfigValidationError
} = require("../../lib/foundation/result");

describe("foundation/result", () => {
  describe("Result constructors and guards", () => {
    test("ok wraps a value", () => {
      const r = ok(42);
      expect(r).toEqual({ ok: true, value: 42 });
      expect(isOk(r)).toBe(true);
      expect(isErr(r)).toBe(false);
    });

    test("err wraps an error", () => {
      const e = new Error("boom");
      const r = err(e);
      expect(r).toEqual({ ok: false, error: e });
      expect(isErr(r)).toBe(true);
      expect(isOk(r)).toBe(false);
    });
  });

  describe("unwrap", () => {
    test("returns the value for ok", () => {
      expect(unwrap(ok("x"))).toBe("x");
    });

    test("throws the carried Error for err", () => {
      const e = new Error("nope");
      expect(() => unwrap(err(e))).toThrow(e);
    });

    test("wraps a non-Error payload in an Error before throwing", () => {
      expect(() => unwrap(err("stringly"))).toThrow("stringly");
    });

    test("unwrapOr returns fallback for err and value for ok", () => {
      expect(unwrapOr(err(new Error("x")), 7)).toBe(7);
      expect(unwrapOr(ok(3), 7)).toBe(3);
    });
  });

  describe("typed errors", () => {
    test("EdgeLinkError carries a code and the subclass name", () => {
      const e = new DecryptError("bad tag");
      expect(e).toBeInstanceOf(Error);
      expect(e).toBeInstanceOf(EdgeLinkError);
      expect(e.code).toBe("DECRYPT_FAILED");
      expect(e.name).toBe("DecryptError");
      expect(e.message).toBe("bad tag");
    });

    test("DecryptError defaults keyMismatchHint to false and accepts override", () => {
      expect(new DecryptError("x").keyMismatchHint).toBe(false);
      expect(new DecryptError("x", { keyMismatchHint: true }).keyMismatchHint).toBe(true);
    });

    test("PacketParseError and ConfigValidationError carry stable codes", () => {
      expect(new PacketParseError("m").code).toBe("PACKET_PARSE_FAILED");
      expect(new ConfigValidationError("m").code).toBe("CONFIG_INVALID");
    });
  });
});
