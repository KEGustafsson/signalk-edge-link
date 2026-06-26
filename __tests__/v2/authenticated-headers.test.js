"use strict";

const {
  PacketBuilder,
  PacketParser,
  PacketType,
  PacketFlags,
  HEADER_SIZE,
  crc16
} = require("../../lib/packet");
const { encryptBinary, decryptBinary, CONTROL_AUTH_TAG_LENGTH } = require("../../lib/crypto");

const { createPipelineV2Server } = require("../../lib/pipeline-v2-server");
const createMetrics = require("../../lib/metrics");
const { promisify } = require("util");
const zlib = require("zlib");

const SECRET_KEY = "12345678901234567890123456789012";
const OTHER_KEY = "abcdefghijklmnopqrstuvwxyz012345";

function authBuilder(opts = {}) {
  return new PacketBuilder({ secretKey: SECRET_KEY, authenticatedHeaders: true, ...opts });
}
function authParser(opts = {}) {
  return new PacketParser({ secretKey: SECRET_KEY, authenticatedHeaders: true, ...opts });
}

describe("authenticated DATA/METADATA headers (opt-in)", () => {
  test("round-trips a DATA packet and sets the AUTHENTICATED_HEADER flag", () => {
    const payload = Buffer.from("hello-world");
    const packet = authBuilder().buildDataPacket(payload);

    expect(packet[4] & PacketFlags.AUTHENTICATED_HEADER).toBe(PacketFlags.AUTHENTICATED_HEADER);

    const parsed = authParser().parseHeader(packet, { secretKey: SECRET_KEY });
    expect(parsed.type).toBe(PacketType.DATA);
    expect(parsed.flags.authenticatedHeader).toBe(true);
    expect(parsed.payload.equals(payload)).toBe(true);
  });

  test("round-trips a METADATA packet", () => {
    const payload = Buffer.from("meta-payload");
    const packet = authBuilder().buildMetadataPacket(payload);
    const parsed = authParser().parseHeader(packet, { secretKey: SECRET_KEY });
    expect(parsed.type).toBe(PacketType.METADATA);
    expect(parsed.payload.equals(payload)).toBe(true);
  });

  test("adds exactly CONTROL_AUTH_TAG_LENGTH bytes vs. the legacy packet", () => {
    const payload = Buffer.from("size-check");
    const legacy = new PacketBuilder({ secretKey: SECRET_KEY }).buildDataPacket(payload);
    const authed = authBuilder().buildDataPacket(payload);
    expect(authed.length - legacy.length).toBe(CONTROL_AUTH_TAG_LENGTH);
  });

  test("detects header tampering: flipping the sequence byte fails authentication", () => {
    const packet = authBuilder().buildDataPacket(Buffer.from("payload"));
    const tampered = Buffer.from(packet);
    // Flip a byte of the sequence field (offset 5-8) and fix the CRC so the
    // packet passes the CRC check — only the HMAC should catch the change.
    tampered[5] ^= 0xff;
    tampered.writeUInt16BE(crc16(tampered.subarray(0, 13)), 13);

    expect(() => authParser().parseHeader(tampered, { secretKey: SECRET_KEY })).toThrow();
  });

  test("detects flag tampering: clearing a flag bit fails authentication", () => {
    const packet = authBuilder().buildDataPacket(Buffer.from("payload"), { compressed: true });
    const tampered = Buffer.from(packet);
    tampered[4] &= ~PacketFlags.COMPRESSED; // clear the COMPRESSED bit
    tampered.writeUInt16BE(crc16(tampered.subarray(0, 13)), 13);

    expect(() => authParser().parseHeader(tampered, { secretKey: SECRET_KEY })).toThrow();
  });

  test("rejects a downgrade: missing AUTHENTICATED_HEADER flag when auth is required", () => {
    const legacy = new PacketBuilder({ secretKey: SECRET_KEY }).buildDataPacket(
      Buffer.from("payload")
    );
    expect(() => authParser().parseHeader(legacy, { secretKey: SECRET_KEY })).toThrow(
      /AUTHENTICATED_HEADER flag not set/
    );
  });

  test("rejects a wrong-key tag", () => {
    const packet = authBuilder().buildDataPacket(Buffer.from("payload"));
    expect(() => authParser().parseHeader(packet, { secretKey: OTHER_KEY })).toThrow();
  });

  test("both ends must agree: a legacy parser sees the tag as trailing ciphertext", () => {
    const payload = Buffer.from("payload");
    const packet = authBuilder().buildDataPacket(payload);
    const legacyParser = new PacketParser({ secretKey: SECRET_KEY });
    const parsed = legacyParser.parseHeader(packet, { secretKey: SECRET_KEY });
    // Legacy parser does not strip the tag, so the payload is longer than the
    // original — confirming a mismatched pair cannot interoperate.
    expect(parsed.payload.length).toBe(payload.length + CONTROL_AUTH_TAG_LENGTH);
  });

  test("full path: encrypt -> authenticated frame -> parse+verify -> decrypt", () => {
    const plaintext = Buffer.from(JSON.stringify({ path: "navigation.speedOverGround", value: 3 }));
    const ciphertext = encryptBinary(plaintext, SECRET_KEY);
    const packet = authBuilder().buildDataPacket(ciphertext, {
      encrypted: true,
      compressed: false
    });

    const parsed = authParser().parseHeader(packet, { secretKey: SECRET_KEY });
    const decrypted = decryptBinary(parsed.payload, SECRET_KEY);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  test("legacy build/parse pair is byte-identical to before (feature off by default)", () => {
    const payload = Buffer.from("legacy");
    const packet = new PacketBuilder({ secretKey: SECRET_KEY }).buildDataPacket(payload);
    expect(packet[4] & PacketFlags.AUTHENTICATED_HEADER).toBe(0);
    expect(packet.length).toBe(HEADER_SIZE + payload.length);
    const parsed = new PacketParser({ secretKey: SECRET_KEY }).parseHeader(packet);
    expect(parsed.payload.equals(payload)).toBe(true);
  });
});

describe("authenticated headers end-to-end (server pipeline)", () => {
  const brotliCompress = promisify(zlib.brotliCompress);

  function makeServer() {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn(),
      setPluginStatus: jest.fn(),
      setProviderStatus: jest.fn()
    };
    const state = {
      instanceId: null,
      options: {
        secretKey: SECRET_KEY,
        protocolVersion: 3,
        authenticatedHeaders: true,
        reliability: { ackInterval: 100, ackResendInterval: 1000, nakTimeout: 50 }
      },
      socketUdp: { send: jest.fn((data, port, address, cb) => cb && cb(null)) }
    };
    const metricsApi = createMetrics();
    const server = createPipelineV2Server(app, state, metricsApi);
    return { app, state, server, metricsApi };
  }

  async function buildAuthDataPacket(delta) {
    const compressed = await brotliCompress(Buffer.from(JSON.stringify(delta)));
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    return authBuilder().buildDataPacket(encrypted, { compressed: true, encrypted: true });
  }

  const client = { address: "10.0.0.9", port: 4321 };

  test("server with authenticatedHeaders accepts a valid authenticated DATA packet", async () => {
    const { app, server } = makeServer();
    const packet = await buildAuthDataPacket([
      { updates: [{ values: [{ path: "navigation.speedOverGround", value: 4 }] }] }
    ]);
    await server.receivePacket(packet, SECRET_KEY, client);
    server.stopACKTimer();
    server.stopMetricsPublishing();

    expect(app.handleMessage).toHaveBeenCalled();
    expect(server.getMetrics().totalSessions).toBe(1);
  });

  test("server rejects a DATA packet whose header was tampered after signing", async () => {
    const { app, server } = makeServer();
    const packet = await buildAuthDataPacket([
      { updates: [{ values: [{ path: "navigation.speedOverGround", value: 4 }] }] }
    ]);
    const tampered = Buffer.from(packet);
    tampered[5] ^= 0xff; // corrupt the sequence
    tampered.writeUInt16BE(crc16(tampered.subarray(0, 13)), 13); // keep CRC valid

    await server.receivePacket(tampered, SECRET_KEY, client);
    server.stopACKTimer();
    server.stopMetricsPublishing();

    // Tampered packet must not be injected into the local Signal K server.
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("server rejects a legacy (unauthenticated) DATA packet when auth is required", async () => {
    const { app, server } = makeServer();
    const compressed = await brotliCompress(
      Buffer.from(
        JSON.stringify([
          { updates: [{ values: [{ path: "navigation.speedOverGround", value: 4 }] }] }
        ])
      )
    );
    const encrypted = encryptBinary(compressed, SECRET_KEY);
    const legacy = new PacketBuilder({ secretKey: SECRET_KEY }).buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true
    });

    await server.receivePacket(legacy, SECRET_KEY, client);
    server.stopACKTimer();
    server.stopMetricsPublishing();

    // Downgrade (no AUTHENTICATED_HEADER flag) must be rejected, not injected.
    expect(app.handleMessage).not.toHaveBeenCalled();
  });

  test("header authentication is ON by default (option omitted)", async () => {
    // A v3 server built WITHOUT specifying authenticatedHeaders must default to
    // ON: it rejects a legacy unauthenticated packet and accepts an authenticated
    // one. This locks in the secure-by-default behavior.
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn(),
      setPluginStatus: jest.fn(),
      setProviderStatus: jest.fn()
    };
    const state = {
      instanceId: null,
      options: {
        secretKey: SECRET_KEY,
        protocolVersion: 3,
        // authenticatedHeaders intentionally omitted — must default to true.
        reliability: { ackInterval: 100, ackResendInterval: 1000, nakTimeout: 50 }
      },
      socketUdp: { send: jest.fn((data, port, address, cb) => cb && cb(null)) }
    };
    const server = createPipelineV2Server(app, state, createMetrics());

    const delta = [{ updates: [{ values: [{ path: "navigation.speedOverGround", value: 4 }] }] }];
    const compressed = await brotliCompress(Buffer.from(JSON.stringify(delta)));
    const encrypted = encryptBinary(compressed, SECRET_KEY);

    // Legacy packet → rejected (default requires authentication).
    const legacy = new PacketBuilder({ secretKey: SECRET_KEY }).buildDataPacket(encrypted, {
      compressed: true,
      encrypted: true
    });
    await server.receivePacket(legacy, SECRET_KEY, client);
    expect(app.handleMessage).not.toHaveBeenCalled();

    // Authenticated packet → accepted.
    const authed = authBuilder().buildDataPacket(encrypted, { compressed: true, encrypted: true });
    await server.receivePacket(authed, SECRET_KEY, { address: "10.0.0.99", port: 5555 });
    server.stopACKTimer();
    server.stopMetricsPublishing();
    expect(app.handleMessage).toHaveBeenCalled();
  });

  test("server with auth OFF rejects an authenticated packet with a clear mismatch diagnostic", async () => {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn(),
      setPluginStatus: jest.fn(),
      setProviderStatus: jest.fn()
    };
    const state = {
      instanceId: null,
      options: {
        secretKey: SECRET_KEY,
        protocolVersion: 3,
        authenticatedHeaders: false, // receiver OFF, sender ON
        reliability: { ackInterval: 100, ackResendInterval: 1000, nakTimeout: 50 }
      },
      socketUdp: { send: jest.fn((data, port, address, cb) => cb && cb(null)) }
    };
    const server = createPipelineV2Server(app, state, createMetrics());

    const packet = await buildAuthDataPacket([
      { updates: [{ values: [{ path: "navigation.speedOverGround", value: 4 }] }] }
    ]);
    await server.receivePacket(packet, SECRET_KEY, client);
    server.stopACKTimer();
    server.stopMetricsPublishing();

    expect(app.handleMessage).not.toHaveBeenCalled();
    expect(app.error.mock.calls.some((c) => /authenticatedHeaders mismatch/i.test(c[0]))).toBe(
      true
    );
  });
});

describe("two-hop proxy relay end-to-end (boat -> proxy -> cloud)", () => {
  const brotliCompress = promisify(zlib.brotliCompress);

  // Each link uses its OWN secret key, modelling a real relay where the
  // boat<->proxy and proxy<->cloud hops are independently keyed.
  const KEY_BOAT_PROXY = SECRET_KEY;
  const KEY_PROXY_CLOUD = OTHER_KEY;

  function makeServerWithKey(key) {
    const app = {
      debug: jest.fn(),
      error: jest.fn(),
      handleMessage: jest.fn(),
      setPluginStatus: jest.fn(),
      setProviderStatus: jest.fn()
    };
    const state = {
      instanceId: null,
      options: {
        secretKey: key,
        protocolVersion: 3,
        authenticatedHeaders: true,
        reliability: { ackInterval: 100, ackResendInterval: 1000, nakTimeout: 50 }
      },
      socketUdp: { send: jest.fn((data, port, address, cb) => cb && cb(null)) }
    };
    const server = createPipelineV2Server(app, state, createMetrics());
    return { app, server };
  }

  // Models a client send for a given link: serialize -> compress -> encrypt ->
  // authenticated frame, with the per-link key.
  async function clientSend(deltas, key) {
    const compressed = await brotliCompress(Buffer.from(JSON.stringify(deltas)));
    const encrypted = encryptBinary(compressed, key);
    return new PacketBuilder({ secretKey: key, authenticatedHeaders: true }).buildDataPacket(
      encrypted,
      { compressed: true, encrypted: true }
    );
  }

  function valuesByPath(delta) {
    const out = {};
    for (const update of delta.updates || []) {
      for (const v of update.values || []) {
        out[v.path] = v.value;
      }
    }
    return out;
  }

  const originalDelta = {
    context: "vessels.urn:mrn:imo:mmsi:230035780",
    updates: [
      {
        source: { label: "GPS", type: "NMEA2000" },
        timestamp: "2026-06-14T12:00:00.000Z",
        values: [
          { path: "navigation.speedOverGround", value: 6.2 },
          { path: "navigation.courseOverGroundTrue", value: 1.47 }
        ]
      }
    ]
  };

  test("a delta survives both authenticated hops with per-link keys", async () => {
    const boat = { address: "10.10.0.2", port: 5001 };
    const proxy = { address: "10.20.0.2", port: 5002 };

    // Hop 1: boat client -> proxy server (KEY_BOAT_PROXY)
    const proxyNode = makeServerWithKey(KEY_BOAT_PROXY);
    const pkt1 = await clientSend([originalDelta], KEY_BOAT_PROXY);
    await proxyNode.server.receivePacket(pkt1, KEY_BOAT_PROXY, boat);
    proxyNode.server.stopACKTimer();
    proxyNode.server.stopMetricsPublishing();

    expect(proxyNode.app.handleMessage).toHaveBeenCalled();
    const proxyReceived = proxyNode.app.handleMessage.mock.calls[0][1];

    // Hop 2: proxy client re-sends the delta it injected locally -> cloud server
    // (KEY_PROXY_CLOUD — a different key for the second link).
    const cloudNode = makeServerWithKey(KEY_PROXY_CLOUD);
    const pkt2 = await clientSend([proxyReceived], KEY_PROXY_CLOUD);
    await cloudNode.server.receivePacket(pkt2, KEY_PROXY_CLOUD, proxy);
    cloudNode.server.stopACKTimer();
    cloudNode.server.stopMetricsPublishing();

    expect(cloudNode.app.handleMessage).toHaveBeenCalled();
    const cloudReceived = cloudNode.app.handleMessage.mock.calls[0][1];

    // Values are preserved byte-for-byte across both hops.
    const finalValues = valuesByPath(cloudReceived);
    expect(finalValues["navigation.speedOverGround"]).toBe(6.2);
    expect(finalValues["navigation.courseOverGroundTrue"]).toBe(1.47);
    expect(cloudReceived.context).toBe(originalDelta.context);
  });

  test("link isolation: a packet keyed for the boat<->proxy link is rejected by the cloud server", async () => {
    const proxy = { address: "10.20.0.2", port: 5002 };
    const cloudNode = makeServerWithKey(KEY_PROXY_CLOUD);

    // Forward using the WRONG (first-link) key — the cloud server must reject it.
    const wrongHopPacket = await clientSend([originalDelta], KEY_BOAT_PROXY);
    await cloudNode.server.receivePacket(wrongHopPacket, KEY_PROXY_CLOUD, proxy);
    cloudNode.server.stopACKTimer();
    cloudNode.server.stopMetricsPublishing();

    expect(cloudNode.app.handleMessage).not.toHaveBeenCalled();
  });
});
