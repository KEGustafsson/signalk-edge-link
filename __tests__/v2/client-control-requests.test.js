"use strict";

/**
 * Client-side handling of server-initiated control requests.
 *
 * `invokeRequestHandler` — reached only from the META_REQUEST and
 * FULL_STATUS_REQUEST branches — had no coverage: the server's *emission* of
 * these packets was well tested, but no test ever built one and fed it to a
 * client pipeline. Breaking the PacketType comparison would leave every
 * downstream vessel showing stale data after a server restart, with the suite
 * green.
 */

const { createPipelineV2Client } = require("../../lib/pipeline-v2-client");
const { PacketBuilder } = require("../../lib/packet");
const createMetrics = require("../../lib/metrics");

const SECRET = "12345678901234567890123456789012";
const WRONG_SECRET = "abcdefghijklmnopqrstuvwxyz012345";
const PEER = { address: "127.0.0.1", port: 4446 };

function makeClient(udpAddress = PEER.address) {
  const app = { debug: jest.fn(), error: jest.fn(), handleMessage: jest.fn() };
  const state = {
    instanceId: "client-1",
    options: {
      secretKey: SECRET,
      udpAddress,
      udpPort: PEER.port,
      protocolVersion: 3,
      stretchAsciiKey: false
    },
    socketUdp: { send: jest.fn((_p, _port, _addr, cb) => cb && cb(null)) },
    deltaTimerTime: 1000,
    avgBytesPerDelta: 100,
    maxDeltasPerBatch: 10,
    stopped: false
  };
  const pipeline = createPipelineV2Client(app, state, createMetrics());
  return { app, state, pipeline };
}

function builder() {
  return new PacketBuilder({ protocolVersion: 3, secretKey: SECRET });
}

describe("client control-request dispatch", () => {
  test("a META_REQUEST packet invokes the registered handler", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setMetaRequestHandler(handler);

    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, PEER);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  // The source-address check compares rinfo.address against the CONFIGURED
  // udpAddress. Those are different representations of the same peer whenever a
  // hostname is configured, or when an IPv6 socket reports an IPv4 peer as
  // ::ffff:x.x.x.x. Comparing them as raw strings dropped every ACK and NAK
  // from a correctly configured server, which stalls RTT measurement, freezes
  // the cumulative ACK and lets the retransmit queue grow without bound.
  describe("peer address matching", () => {
    test("accepts a peer reported in IPv4-mapped IPv6 form", async () => {
      const { pipeline } = makeClient("127.0.0.1");
      const handler = jest.fn();
      pipeline.setMetaRequestHandler(handler);

      const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
      await pipeline.handleControlPacket(packet, { address: "::ffff:127.0.0.1", port: 4446 });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    test("accepts only the addresses a configured hostname resolves to", async () => {
      const dns = require("dns");
      const spy = jest.spyOn(dns, "lookup").mockImplementation((_host, _opts, cb) => {
        const done = typeof _opts === "function" ? _opts : cb;
        done(null, [{ address: "192.0.2.10", family: 4 }]);
      });
      try {
        const { pipeline } = makeClient("resolves.example");
        const handler = jest.fn();
        pipeline.setMetaRequestHandler(handler);

        // First packet lands inside the resolve grace and also triggers the
        // lookup, which the mock completes synchronously.
        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "192.0.2.10", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(1);

        // Now that the name is resolved, an address outside its set is refused —
        // a hostname must not become a wildcard.
        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "203.0.113.9", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(1);

        // ...and a resolved address still is.
        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "192.0.2.10", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(2);
      } finally {
        spy.mockRestore();
      }
    });

    // A peer that moves — dynamic DNS, failover to a standby host — must be
    // recognised at its new address. Resolving once and never re-checking would
    // reject it permanently, dropping every ACK exactly as the original string
    // comparison did.
    test("picks up a peer whose address changes", async () => {
      const dns = require("dns");
      let current = "192.0.2.10";
      const spy = jest.spyOn(dns, "lookup").mockImplementation((_host, _opts, cb) => {
        const done = typeof _opts === "function" ? _opts : cb;
        done(null, [{ address: current, family: 4 }]);
      });
      const realNow = Date.now;
      try {
        const { pipeline } = makeClient("moves.example");
        const handler = jest.fn();
        pipeline.setMetaRequestHandler(handler);

        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "192.0.2.10", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(1);

        // The peer moves; the old address must stop being accepted...
        current = "198.51.100.5";
        Date.now = () => realNow() + 120_000;
        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "192.0.2.10", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(1);

        // ...and the new one must start.
        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "198.51.100.5", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(2);
      } finally {
        Date.now = realNow;
        spy.mockRestore();
      }
    });

    // An open-ended grace is the validation switched off, not relaxed.
    test("stops accepting once the resolve grace expires without a result", async () => {
      const dns = require("dns");
      const spy = jest.spyOn(dns, "lookup").mockImplementation((_host, _opts, cb) => {
        const done = typeof _opts === "function" ? _opts : cb;
        done(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
      });
      const realNow = Date.now;
      try {
        const { pipeline } = makeClient("never-resolves.example");
        const handler = jest.fn();
        pipeline.setMetaRequestHandler(handler);

        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "203.0.113.9", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(1); // inside the grace

        Date.now = () => realNow() + 120_000;
        await pipeline.handleControlPacket(
          builder().buildMetaRequestPacket({ secretKey: SECRET }),
          { address: "203.0.113.9", port: 4446 }
        );
        expect(handler).toHaveBeenCalledTimes(1); // grace expired: refused
      } finally {
        Date.now = realNow;
        spy.mockRestore();
      }
    });

    // A name that does not resolve leaves nothing cached, so without a
    // rate limit every inbound control packet would start another lookup — a
    // DNS flood at packet rate, triggered by the very misconfiguration the
    // operator is trying to diagnose.
    test("an unresolvable peer name does not issue a lookup per packet", async () => {
      const dns = require("dns");
      // Fail synchronously so the in-flight guard has already cleared by the
      // next packet — otherwise a burst is absorbed by that guard alone and the
      // rate limit is never exercised.
      const spy = jest.spyOn(dns, "lookup").mockImplementation((_host, _opts, cb) => {
        const done = typeof _opts === "function" ? _opts : cb;
        done(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }), []);
      });
      try {
        const { pipeline } = makeClient("no-such-host.invalid");
        const handler = jest.fn();
        pipeline.setMetaRequestHandler(handler);

        for (let i = 0; i < 25; i++) {
          const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
          await pipeline.handleControlPacket(packet, { address: "192.0.2.10", port: 4446 });
        }

        expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
        // Packets are still accepted while the name is unresolved.
        expect(handler).toHaveBeenCalledTimes(25);
      } finally {
        spy.mockRestore();
      }
    });

    test("still rejects an unrelated source when the peer is a literal address", async () => {
      const { pipeline, app } = makeClient("127.0.0.1");
      const handler = jest.fn();
      pipeline.setMetaRequestHandler(handler);

      const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
      await pipeline.handleControlPacket(packet, { address: "203.0.113.9", port: 4446 });

      expect(handler).not.toHaveBeenCalled();
      expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("unexpected source"));
    });
  });

  test("a FULL_STATUS_REQUEST packet invokes the registered handler", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setFullStatusRequestHandler(handler);

    const packet = builder().buildFullStatusRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, PEER);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("a request signed with the wrong key does not invoke the handler", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setFullStatusRequestHandler(handler);

    const forged = new PacketBuilder({
      protocolVersion: 3,
      secretKey: WRONG_SECRET
    }).buildFullStatusRequestPacket({ secretKey: WRONG_SECRET });
    await pipeline.handleControlPacket(forged, PEER);

    expect(handler).not.toHaveBeenCalled();
  });

  test("a request from an unexpected source address is ignored", async () => {
    const { pipeline } = makeClient();
    const handler = jest.fn();
    pipeline.setMetaRequestHandler(handler);

    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, { address: "203.0.113.9", port: 4446 });

    expect(handler).not.toHaveBeenCalled();
  });

  test("a throwing handler does not surface as a parse error", async () => {
    const { app, pipeline } = makeClient();
    pipeline.setMetaRequestHandler(() => {
      throw new Error("handler blew up");
    });

    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await expect(pipeline.handleControlPacket(packet, PEER)).resolves.toBeUndefined();
    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("handler error"));
  });

  test("a rejecting async handler is caught", async () => {
    const { app, pipeline } = makeClient();
    pipeline.setFullStatusRequestHandler(() => Promise.reject(new Error("async boom")));

    const packet = builder().buildFullStatusRequestPacket({ secretKey: SECRET });
    await pipeline.handleControlPacket(packet, PEER);
    await Promise.resolve();
    await Promise.resolve();

    expect(app.debug).toHaveBeenCalledWith(expect.stringContaining("handler rejected"));
  });

  test("no registered handler is a no-op, not a crash", async () => {
    const { pipeline } = makeClient();
    const packet = builder().buildMetaRequestPacket({ secretKey: SECRET });
    await expect(pipeline.handleControlPacket(packet, PEER)).resolves.toBeUndefined();
  });
});
