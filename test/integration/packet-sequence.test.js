"use strict";

const { PacketBuilder, PacketParser, PacketType } = require("../../lib/packet");
const { SequenceTracker } = require("../../lib/sequence");

describe("Packet + Sequence Integration", () => {
  let builder;
  let parser;
  let tracker;

  beforeEach(() => {
    builder = new PacketBuilder();
    parser = new PacketParser();
    tracker = new SequenceTracker();
  });

  afterEach(() => {
    tracker.reset();
  });

  test("tracks sequences from parsed packets in order", () => {
    for (let i = 0; i < 5; i++) {
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      const parsed = parser.parseHeader(packet);
      const result = tracker.processSequence(parsed.sequence);
      expect(result.inOrder).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.duplicate).toBe(false);
    }

    expect(tracker.expectedSeq).toBe(5);
  });

  test("detects loss from packet sequence gap", () => {
    // Build packets with specific sequence numbers: 0, 1, 3 (missing 2)
    const packets = [];
    for (const seq of [0, 1, 3]) {
      builder.setSequence(seq);
      packets.push(builder.buildDataPacket(Buffer.from(`data ${seq}`)));
    }

    const results = packets.map(packet => {
      const parsed = parser.parseHeader(packet);
      return {
        sequence: parsed.sequence,
        result: tracker.processSequence(parsed.sequence)
      };
    });

    expect(results[0].result.inOrder).toBe(true);
    expect(results[1].result.inOrder).toBe(true);
    expect(results[2].result.inOrder).toBe(false);
    expect(results[2].result.missing).toContain(2);
  });

  test("handles out-of-order packet delivery", () => {
    // Build packets in order but deliver out of order
    const packets = {};
    for (let i = 0; i < 5; i++) {
      builder.setSequence(i);
      packets[i] = builder.buildDataPacket(Buffer.from(`data ${i}`));
    }

    // Deliver: 0, 1, 3, 4, 2
    const deliveryOrder = [0, 1, 3, 4, 2];
    for (const seq of deliveryOrder) {
      const parsed = parser.parseHeader(packets[seq]);
      tracker.processSequence(parsed.sequence);
    }

    expect(tracker.expectedSeq).toBe(5);
  });

  test("detects duplicate packets", () => {
    const packet = builder.buildDataPacket(Buffer.from("duplicate test"));
    const parsed1 = parser.parseHeader(packet);
    const parsed2 = parser.parseHeader(packet);

    const result1 = tracker.processSequence(parsed1.sequence);
    const result2 = tracker.processSequence(parsed2.sequence);

    expect(result1.duplicate).toBe(false);
    expect(result2.duplicate).toBe(true);
  });

  test("correctly parses payload after sequence tracking", () => {
    const testData = { navigation: { position: { lat: 60.1, lon: 24.9 } } };
    const payload = Buffer.from(JSON.stringify(testData));

    const packet = builder.buildDataPacket(payload, {
      compressed: true,
      encrypted: true
    });

    const parsed = parser.parseHeader(packet);
    tracker.processSequence(parsed.sequence);

    // Verify payload integrity after round-trip
    const receivedData = JSON.parse(parsed.payload.toString());
    expect(receivedData).toEqual(testData);
    expect(parsed.flags.compressed).toBe(true);
    expect(parsed.flags.encrypted).toBe(true);
  });

  test("simulates realistic packet flow with NAK", async () => {
    const losses = [];
    const t = new SequenceTracker({
      nakTimeout: 50,
      onLossDetected: (seqs) => losses.push(...seqs)
    });

    // Simulate: send 10 packets, lose packet 3 and 7
    const sent = [0, 1, 2, 4, 5, 6, 8, 9];
    for (const seq of sent) {
      builder.setSequence(seq);
      const packet = builder.buildDataPacket(Buffer.from(`data ${seq}`));
      const parsed = parser.parseHeader(packet);
      t.processSequence(parsed.sequence);
    }

    // Wait for NAK timeout
    await new Promise(resolve => setTimeout(resolve, 70));

    expect(losses).toContain(3);
    expect(losses).toContain(7);
    t.reset();
  });

  test("non-DATA packets do not affect sequence tracking", () => {
    // Send a heartbeat - should not increment builder sequence
    const heartbeat = builder.buildHeartbeatPacket();
    const parsedHB = parser.parseHeader(heartbeat);
    expect(parsedHB.type).toBe(PacketType.HEARTBEAT);

    // Send DATA packets - sequence should start at 0
    const data1 = builder.buildDataPacket(Buffer.from("first"));
    const parsed1 = parser.parseHeader(data1);
    expect(parsed1.sequence).toBe(0);

    const result = tracker.processSequence(parsed1.sequence);
    expect(result.inOrder).toBe(true);
  });

  test("ACK packet carries correct sequence for acknowledgement", () => {
    // Process some data packets
    for (let i = 0; i < 5; i++) {
      builder.setSequence(i);
      const packet = builder.buildDataPacket(Buffer.from(`data ${i}`));
      const parsed = parser.parseHeader(packet);
      tracker.processSequence(parsed.sequence);
    }

    // Build ACK for the last received sequence
    const ackBuilder = new PacketBuilder();
    const ackPacket = ackBuilder.buildACKPacket(tracker.expectedSeq - 1);
    const parsedAck = parser.parseHeader(ackPacket);

    expect(parsedAck.type).toBe(PacketType.ACK);
    expect(parser.parseACKPayload(parsedAck.payload)).toBe(4);
  });

  test("NAK packet carries missing sequences", () => {
    // Create a gap
    builder.setSequence(0);
    tracker.processSequence(
      parser.parseHeader(builder.buildDataPacket(Buffer.from("a"))).sequence
    );

    builder.setSequence(3);
    const result = tracker.processSequence(
      parser.parseHeader(builder.buildDataPacket(Buffer.from("d"))).sequence
    );

    // Build NAK for missing sequences
    const nakBuilder = new PacketBuilder();
    const nakPacket = nakBuilder.buildNAKPacket(result.missing);
    const parsedNak = parser.parseHeader(nakPacket);

    expect(parsedNak.type).toBe(PacketType.NAK);
    expect(parser.parseNAKPayload(parsedNak.payload)).toEqual([1, 2]);
  });
});
