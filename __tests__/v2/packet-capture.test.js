"use strict";

const { PacketCapture, PacketInspector } = require("../../lib/packet-capture");
const { PacketBuilder } = require("../../lib/packet");

// ── PacketCapture ──

describe("PacketCapture", () => {
  let capture;

  beforeEach(() => {
    capture = new PacketCapture({ maxPackets: 10 });
  });

  describe("Construction", () => {
    test("initializes with default config", () => {
      const c = new PacketCapture();
      expect(c.maxPackets).toBe(1000);
      expect(c.enabled).toBe(false);
      expect(c.packets).toEqual([]);
    });

    test("accepts custom config", () => {
      expect(capture.maxPackets).toBe(10);
    });

    test("starts disabled by default", () => {
      expect(capture.enabled).toBe(false);
    });
  });

  describe("Start/Stop", () => {
    test("starts capturing", () => {
      capture.start();
      expect(capture.enabled).toBe(true);
    });

    test("stops capturing", () => {
      capture.start();
      capture.stop();
      expect(capture.enabled).toBe(false);
    });
  });

  describe("Capture", () => {
    test("does not capture when disabled", () => {
      const packet = Buffer.from("test");
      capture.capture(packet, "send");
      expect(capture.packets.length).toBe(0);
    });

    test("captures when enabled", () => {
      capture.start();
      const packet = Buffer.from("test");
      capture.capture(packet, "send", { address: "1.2.3.4", port: 4446 });
      expect(capture.packets.length).toBe(1);
      expect(capture.packets[0].direction).toBe("send");
      expect(capture.packets[0].address).toBe("1.2.3.4");
      expect(capture.packets[0].port).toBe(4446);
    });

    test("creates a copy of packet data", () => {
      capture.start();
      const packet = Buffer.from("test");
      capture.capture(packet, "send");

      // Mutate original
      packet[0] = 0xff;

      // Captured copy should be unchanged
      expect(capture.packets[0].data[0]).not.toBe(0xff);
    });

    test("records timestamp", () => {
      capture.start();
      capture.capture(Buffer.from("test"), "recv");
      expect(capture.packets[0].timestamp).toBeDefined();
      expect(typeof capture.packets[0].timestamp).toBe("number");
    });

    test("records length", () => {
      capture.start();
      const packet = Buffer.from("test data");
      capture.capture(packet, "send");
      expect(capture.packets[0].length).toBe(packet.length);
    });

    test("trims to maxPackets", () => {
      capture.start();
      for (let i = 0; i < 15; i++) {
        capture.capture(Buffer.from(`packet-${i}`), "send");
      }
      expect(capture.packets.length).toBe(10);
      expect(capture.stats.dropped).toBe(5);
    });

    test("tracks capture statistics", () => {
      capture.start();
      for (let i = 0; i < 5; i++) {
        capture.capture(Buffer.from(`packet-${i}`), "send");
      }
      expect(capture.stats.captured).toBe(5);
    });
  });

  describe("PCAP Export", () => {
    test("exports valid pcap format with global header", () => {
      capture.start();
      capture.capture(Buffer.from("test"), "send");

      const pcap = capture.exportPcap();
      expect(Buffer.isBuffer(pcap)).toBe(true);

      // Verify pcap magic number (little-endian)
      expect(pcap.readUInt32LE(0)).toBe(0xa1b2c3d4);

      // Verify version
      expect(pcap.readUInt16LE(4)).toBe(2); // major
      expect(pcap.readUInt16LE(6)).toBe(4); // minor

      // Verify snaplen
      expect(pcap.readUInt32LE(16)).toBe(65535);
    });

    test("exports empty pcap when no packets", () => {
      const pcap = capture.exportPcap();
      expect(pcap.length).toBe(24); // Just the global header
    });

    test("exports multiple packets", () => {
      capture.start();
      capture.capture(Buffer.from("packet1"), "send");
      capture.capture(Buffer.from("packet2"), "recv");
      capture.capture(Buffer.from("packet3"), "send");

      const pcap = capture.exportPcap();
      // 24 (global header) + 3 * (16 (record header) + 1 (dir byte) + packetLen)
      expect(pcap.length).toBeGreaterThan(24 + 3 * 16);
    });

    test("includes direction marker in pcap data", () => {
      capture.start();
      capture.capture(Buffer.from("hello"), "send");
      capture.capture(Buffer.from("world"), "recv");

      const pcap = capture.exportPcap();

      // First packet starts at offset 24 (after global header)
      // Record header is 16 bytes, then direction byte
      const firstDirByte = pcap[24 + 16]; // 0 = send
      const secondDirByte = pcap[24 + 16 + 6 + 16]; // After first packet + next record header
      expect(firstDirByte).toBe(0); // send
    });

    test("exports v2 protocol packets correctly", () => {
      capture.start();
      const builder = new PacketBuilder();
      const v2Packet = builder.buildHeartbeatPacket();
      capture.capture(v2Packet, "send");

      const pcap = capture.exportPcap();
      expect(pcap.length).toBeGreaterThan(24 + 16);
    });
  });

  describe("Statistics", () => {
    test("returns correct stats", () => {
      capture.start();
      for (let i = 0; i < 5; i++) {
        capture.capture(Buffer.from(`p${i}`), "send");
      }

      const stats = capture.getStats();
      expect(stats.enabled).toBe(true);
      expect(stats.captured).toBe(5);
      expect(stats.buffered).toBe(5);
      expect(stats.maxPackets).toBe(10);
    });

    test("tracks dropped packets", () => {
      capture.start();
      for (let i = 0; i < 15; i++) {
        capture.capture(Buffer.from(`p${i}`), "send");
      }

      const stats = capture.getStats();
      expect(stats.dropped).toBe(5);
      expect(stats.buffered).toBe(10);
    });
  });

  describe("Clear/Reset", () => {
    test("clears buffer", () => {
      capture.start();
      capture.capture(Buffer.from("test"), "send");
      capture.clear();
      expect(capture.packets.length).toBe(0);
      expect(capture.stats.captured).toBe(0);
    });

    test("reset stops and clears", () => {
      capture.start();
      capture.capture(Buffer.from("test"), "send");
      capture.reset();
      expect(capture.enabled).toBe(false);
      expect(capture.packets.length).toBe(0);
    });
  });
});

// ── PacketInspector ──

describe("PacketInspector", () => {
  let inspector;

  function createMockWS() {
    const ws = {
      readyState: 1, // OPEN
      messages: [],
      closed: false,
      send: jest.fn((msg) => { ws.messages.push(msg); }),
      close: jest.fn(() => { ws.closed = true; ws.readyState = 3; }),
      on: jest.fn((event, handler) => {
        if (!ws._handlers) ws._handlers = {};
        if (!ws._handlers[event]) ws._handlers[event] = [];
        ws._handlers[event].push(handler);
      }),
      _emit(event) {
        if (ws._handlers && ws._handlers[event]) {
          ws._handlers[event].forEach(fn => fn());
        }
      }
    };
    return ws;
  }

  beforeEach(() => {
    inspector = new PacketInspector({ maxClients: 3 });
  });

  describe("Construction", () => {
    test("initializes disabled with no clients", () => {
      expect(inspector.enabled).toBe(false);
      expect(inspector.clients.size).toBe(0);
    });

    test("accepts custom maxClients", () => {
      expect(inspector.maxClients).toBe(3);
    });
  });

  describe("Client Management", () => {
    test("adds a WebSocket client", () => {
      const ws = createMockWS();
      const accepted = inspector.addClient(ws);
      expect(accepted).toBe(true);
      expect(inspector.clients.size).toBe(1);
      expect(inspector.enabled).toBe(true);
    });

    test("rejects when at maxClients", () => {
      for (let i = 0; i < 3; i++) {
        inspector.addClient(createMockWS());
      }
      const rejected = inspector.addClient(createMockWS());
      expect(rejected).toBe(false);
      expect(inspector.clients.size).toBe(3);
    });

    test("removes client on close", () => {
      const ws = createMockWS();
      inspector.addClient(ws);
      ws._emit("close");
      expect(inspector.clients.size).toBe(0);
      expect(inspector.enabled).toBe(false);
    });

    test("removes client on error", () => {
      const ws = createMockWS();
      inspector.addClient(ws);
      ws._emit("error");
      expect(inspector.clients.size).toBe(0);
    });
  });

  describe("Inspection", () => {
    test("does nothing when no clients", () => {
      inspector.inspect(Buffer.from("test"), "send");
      expect(inspector.stats.packetsInspected).toBe(0);
    });

    test("broadcasts packet summary to clients", () => {
      const ws = createMockWS();
      inspector.addClient(ws);
      inspector.inspect(Buffer.from("test-data"), "send", { address: "1.2.3.4", port: 4446 });

      expect(ws.send).toHaveBeenCalledTimes(1);
      const msg = JSON.parse(ws.messages[0]);
      expect(msg.direction).toBe("send");
      expect(msg.length).toBe(9);
      expect(msg.address).toBe("1.2.3.4");
      expect(msg.timestamp).toBeDefined();
    });

    test("parses v2 packet header in summary", () => {
      const ws = createMockWS();
      inspector.addClient(ws);

      const builder = new PacketBuilder();
      const heartbeat = builder.buildHeartbeatPacket();
      inspector.inspect(heartbeat, "recv");

      const msg = JSON.parse(ws.messages[0]);
      expect(msg.protocol).toBe("v2");
      expect(msg.type).toBe("HEARTBEAT");
      expect(msg.sequence).toBeDefined();
    });

    test("handles unknown protocol", () => {
      const ws = createMockWS();
      inspector.addClient(ws);
      inspector.inspect(Buffer.from("not-a-v2-packet"), "recv");

      const msg = JSON.parse(ws.messages[0]);
      expect(msg.protocol).toBe("unknown");
    });

    test("includes hex preview", () => {
      const ws = createMockWS();
      inspector.addClient(ws);
      inspector.inspect(Buffer.from("hello"), "send");

      const msg = JSON.parse(ws.messages[0]);
      expect(msg.hexPreview).toBeDefined();
      expect(msg.hexPreview).toBe(Buffer.from("hello").toString("hex"));
    });

    test("broadcasts to multiple clients", () => {
      const ws1 = createMockWS();
      const ws2 = createMockWS();
      inspector.addClient(ws1);
      inspector.addClient(ws2);

      inspector.inspect(Buffer.from("test"), "send");

      expect(ws1.send).toHaveBeenCalledTimes(1);
      expect(ws2.send).toHaveBeenCalledTimes(1);
    });

    test("removes dead clients during broadcast", () => {
      const ws1 = createMockWS();
      const ws2 = createMockWS();
      inspector.addClient(ws1);
      inspector.addClient(ws2);

      // Mark ws1 as closed
      ws1.readyState = 3; // CLOSED

      inspector.inspect(Buffer.from("test"), "send");
      expect(inspector.clients.size).toBe(1);
    });

    test("tracks packets inspected", () => {
      const ws = createMockWS();
      inspector.addClient(ws);

      inspector.inspect(Buffer.from("test1"), "send");
      inspector.inspect(Buffer.from("test2"), "recv");

      expect(inspector.stats.packetsInspected).toBe(2);
    });
  });

  describe("Statistics", () => {
    test("returns correct stats", () => {
      const ws = createMockWS();
      inspector.addClient(ws);
      inspector.inspect(Buffer.from("test"), "send");

      const stats = inspector.getStats();
      expect(stats.enabled).toBe(true);
      expect(stats.packetsInspected).toBe(1);
      expect(stats.clientsConnected).toBe(1);
    });
  });

  describe("Reset", () => {
    test("closes all clients and resets", () => {
      const ws1 = createMockWS();
      const ws2 = createMockWS();
      inspector.addClient(ws1);
      inspector.addClient(ws2);

      inspector.reset();
      expect(inspector.clients.size).toBe(0);
      expect(inspector.enabled).toBe(false);
      expect(ws1.close).toHaveBeenCalled();
      expect(ws2.close).toHaveBeenCalled();
    });
  });
});
