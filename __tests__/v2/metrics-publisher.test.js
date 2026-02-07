"use strict";

const { MetricsPublisher } = require("../../lib/metrics-publisher");

describe("MetricsPublisher", () => {
  let publisher;
  let publishedMessages;

  const mockApp = {
    handleMessage: jest.fn((context, delta) => {
      publishedMessages.push(delta);
    })
  };

  beforeEach(() => {
    publishedMessages = [];
    mockApp.handleMessage.mockClear();
    publisher = new MetricsPublisher(mockApp);
  });

  describe("Construction", () => {
    test("initializes with empty windows", () => {
      expect(publisher.rttWindow).toEqual([]);
      expect(publisher.jitterWindow).toEqual([]);
      expect(publisher.lossWindow).toEqual([]);
    });

    test("initializes with default window size of 10", () => {
      expect(publisher.windowSize).toBe(10);
    });

    test("initializes with empty lastPublished", () => {
      expect(publisher.lastPublished).toEqual({});
    });

    test("stores app reference", () => {
      expect(publisher.app).toBe(mockApp);
    });

    test("accepts optional config", () => {
      const config = { custom: "value" };
      const pub = new MetricsPublisher(mockApp, config);
      expect(pub.config).toEqual(config);
    });
  });

  describe("Core Metrics Publishing", () => {
    test("publishes RTT metric", () => {
      publisher.publish({ rtt: 50 });

      const values = publishedMessages[0].updates[0].values;
      const rttMetric = values.find(v => v.path === "networking.edgeLink.rtt");

      expect(rttMetric).toBeDefined();
      expect(rttMetric.value).toBe(50);
    });

    test("publishes jitter metric", () => {
      publisher.publish({ jitter: 20 });

      const values = publishedMessages[0].updates[0].values;
      const jitterMetric = values.find(v => v.path === "networking.edgeLink.jitter");

      expect(jitterMetric).toBeDefined();
      expect(jitterMetric.value).toBe(20);
    });

    test("publishes packet loss metric", () => {
      publisher.publish({ packetLoss: 0.05 });

      const values = publishedMessages[0].updates[0].values;
      const lossMetric = values.find(v => v.path === "networking.edgeLink.packetLoss");

      expect(lossMetric).toBeDefined();
      expect(lossMetric.value).toBe(0.05);
    });

    test("publishes bandwidth metrics", () => {
      publisher.publish({
        uploadBandwidth: 1000000,
        downloadBandwidth: 500000
      });

      const values = publishedMessages[0].updates[0].values;

      const upload = values.find(v => v.path === "networking.edgeLink.bandwidth.upload");
      const download = values.find(v => v.path === "networking.edgeLink.bandwidth.download");

      expect(upload.value).toBe(1000000);
      expect(download.value).toBe(500000);
    });

    test("publishes packets per second metrics", () => {
      publisher.publish({
        packetsSentPerSec: 100,
        packetsReceivedPerSec: 95
      });

      const values = publishedMessages[0].updates[0].values;

      const sent = values.find(v => v.path === "networking.edgeLink.packetsPerSecond.sent");
      const received = values.find(v => v.path === "networking.edgeLink.packetsPerSecond.received");

      expect(sent.value).toBe(100);
      expect(received.value).toBe(95);
    });

    test("publishes retransmission count", () => {
      publisher.publish({ retransmissions: 5 });

      const values = publishedMessages[0].updates[0].values;
      const metric = values.find(v => v.path === "networking.edgeLink.retransmissions");

      expect(metric.value).toBe(5);
    });

    test("publishes sequence number", () => {
      publisher.publish({ sequenceNumber: 12345 });

      const values = publishedMessages[0].updates[0].values;
      const metric = values.find(v => v.path === "networking.edgeLink.sequenceNumber");

      expect(metric.value).toBe(12345);
    });

    test("publishes queue depth", () => {
      publisher.publish({ queueDepth: 10 });

      const values = publishedMessages[0].updates[0].values;
      const metric = values.find(v => v.path === "networking.edgeLink.queueDepth");

      expect(metric.value).toBe(10);
    });

    test("publishes active link", () => {
      publisher.publish({ activeLink: "primary" });

      const values = publishedMessages[0].updates[0].values;
      const metric = values.find(v => v.path === "networking.edgeLink.activeLink");

      expect(metric.value).toBe("primary");
    });

    test("publishes compression ratio", () => {
      publisher.publish({ compressionRatio: 0.97 });

      const values = publishedMessages[0].updates[0].values;
      const metric = values.find(v => v.path === "networking.edgeLink.compressionRatio");

      expect(metric.value).toBe(0.97);
    });

    test("always publishes linkQuality", () => {
      publisher.publish({ rtt: 50 });

      const values = publishedMessages[0].updates[0].values;
      const quality = values.find(v => v.path === "networking.edgeLink.linkQuality");

      expect(quality).toBeDefined();
      expect(typeof quality.value).toBe("number");
    });

    test("publishes all 13 metrics when provided", () => {
      publisher.publish({
        rtt: 50,
        jitter: 20,
        packetLoss: 0.05,
        uploadBandwidth: 1000000,
        downloadBandwidth: 500000,
        packetsSentPerSec: 100,
        packetsReceivedPerSec: 95,
        retransmissions: 5,
        sequenceNumber: 12345,
        queueDepth: 10,
        activeLink: "primary",
        compressionRatio: 0.97,
        retransmitRate: 0.05
      });

      const values = publishedMessages[0].updates[0].values;

      // Should have 13 paths (including calculated link quality)
      expect(values.length).toBe(13);
    });

    test("publishes with correct source label", () => {
      publisher.publish({ rtt: 50 });

      const source = publishedMessages[0].updates[0].source;
      expect(source.label).toBe("signalk-edge-link");
      expect(source.type).toBe("plugin");
    });

    test("publishes with ISO timestamp", () => {
      publisher.publish({ rtt: 50 });

      const timestamp = publishedMessages[0].updates[0].timestamp;
      expect(() => new Date(timestamp)).not.toThrow();
      expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    test("calls handleMessage with vessels.self context", () => {
      publisher.publish({ rtt: 50 });

      expect(mockApp.handleMessage).toHaveBeenCalledWith(
        "vessels.self",
        expect.any(Object)
      );
    });
  });

  describe("Link Quality Calculation", () => {
    test("calculates perfect quality (100)", () => {
      const quality = publisher.calculateLinkQuality({
        rtt: 0,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });

      expect(quality).toBe(100);
    });

    test("calculates poor quality with high loss", () => {
      const quality = publisher.calculateLinkQuality({
        rtt: 800,
        jitter: 400,
        packetLoss: 0.80,
        retransmitRate: 0.08
      });

      expect(quality).toBeLessThan(30);
    });

    test("weights packet loss heavily (40%)", () => {
      const highLoss = publisher.calculateLinkQuality({
        rtt: 0,
        jitter: 0,
        packetLoss: 0.50,
        retransmitRate: 0
      });

      // 50% loss: lossScore = 0.5 * 40 = 20; rtt=30; jitter=20; retransmit=10 => 80
      expect(highLoss).toBeGreaterThan(70);
      expect(highLoss).toBeLessThan(90);
    });

    test("weights RTT second (30%)", () => {
      const highRTT = publisher.calculateLinkQuality({
        rtt: 1000,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });

      // rtt=1000 => rttScore=0 => 0*30=0; loss=40; jitter=20; retransmit=10 => 70
      expect(highRTT).toBe(70);
    });

    test("weights jitter third (20%)", () => {
      const highJitter = publisher.calculateLinkQuality({
        rtt: 0,
        jitter: 500,
        packetLoss: 0,
        retransmitRate: 0
      });

      // jitter=500 => jitterScore=0 => 0*20=0; loss=40; rtt=30; retransmit=10 => 80
      expect(highJitter).toBe(80);
    });

    test("weights retransmit rate last (10%)", () => {
      const highRetransmit = publisher.calculateLinkQuality({
        rtt: 0,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0.1
      });

      // retransmitRate=0.1 => score=0 => 0*10=0; loss=40; rtt=30; jitter=20 => 90
      expect(highRetransmit).toBe(90);
    });

    test("clamps scores to 0-100 range", () => {
      const veryBad = publisher.calculateLinkQuality({
        rtt: 10000,
        jitter: 10000,
        packetLoss: 1.0,
        retransmitRate: 1.0
      });

      expect(veryBad).toBeGreaterThanOrEqual(0);
      expect(veryBad).toBeLessThanOrEqual(100);
    });

    test("returns 0 for worst case scenario", () => {
      const worst = publisher.calculateLinkQuality({
        rtt: 10000,
        jitter: 10000,
        packetLoss: 1.0,
        retransmitRate: 1.0
      });

      expect(worst).toBe(0);
    });

    test("handles moderate conditions correctly", () => {
      const moderate = publisher.calculateLinkQuality({
        rtt: 200,
        jitter: 50,
        packetLoss: 0.02,
        retransmitRate: 0.01
      });

      // Should be in the "good" range
      expect(moderate).toBeGreaterThan(70);
      expect(moderate).toBeLessThan(100);
    });

    test("returns rounded integer", () => {
      const quality = publisher.calculateLinkQuality({
        rtt: 123,
        jitter: 45,
        packetLoss: 0.03,
        retransmitRate: 0.02
      });

      expect(Number.isInteger(quality)).toBe(true);
    });
  });

  describe("Moving Average", () => {
    test("calculates moving average over window", () => {
      publisher.publish({ rtt: 50 });
      publisher.publish({ rtt: 60 });
      publisher.publish({ rtt: 70 });

      // Average should be (50 + 60 + 70) / 3 = 60
      const lastMessage = publishedMessages[publishedMessages.length - 1];
      const rttValue = lastMessage.updates[0].values.find(
        v => v.path === "networking.edgeLink.rtt"
      );

      expect(rttValue.value).toBe(60);
    });

    test("limits window size to configured value", () => {
      publisher.windowSize = 3;

      for (let i = 0; i < 10; i++) {
        publisher.publish({ rtt: i * 10 });
      }

      // Window should only contain last 3 values: 70, 80, 90
      // Average: (70 + 80 + 90) / 3 = 80
      const lastMessage = publishedMessages[publishedMessages.length - 1];
      const rttValue = lastMessage.updates[0].values.find(
        v => v.path === "networking.edgeLink.rtt"
      );

      expect(rttValue.value).toBe(80);
    });

    test("smooths out spikes in jitter", () => {
      publisher.publish({ jitter: 10 });
      publisher.publish({ jitter: 10 });
      publisher.publish({ jitter: 10 });
      publisher.publish({ jitter: 100 }); // spike

      const lastMessage = publishedMessages[publishedMessages.length - 1];
      const jitterValue = lastMessage.updates[0].values.find(
        v => v.path === "networking.edgeLink.jitter"
      );

      // Average of 10, 10, 10, 100 = 32.5 (smoothed)
      expect(jitterValue.value).toBe(32.5);
    });

    test("handles empty window returning 0", () => {
      // Calling _calculateAverage directly with empty array
      expect(publisher._calculateAverage([])).toBe(0);
    });

    test("handles single value window", () => {
      publisher.publish({ rtt: 42 });

      const rttValue = publishedMessages[0].updates[0].values.find(
        v => v.path === "networking.edgeLink.rtt"
      );

      expect(rttValue.value).toBe(42);
    });

    test("maintains separate windows for each metric", () => {
      publisher.publish({ rtt: 100, jitter: 10, packetLoss: 0.01 });
      publisher.publish({ rtt: 200, jitter: 20, packetLoss: 0.02 });

      const lastMessage = publishedMessages[publishedMessages.length - 1];
      const values = lastMessage.updates[0].values;

      const rtt = values.find(v => v.path === "networking.edgeLink.rtt");
      const jitter = values.find(v => v.path === "networking.edgeLink.jitter");
      const loss = values.find(v => v.path === "networking.edgeLink.packetLoss");

      expect(rtt.value).toBe(150);   // (100+200)/2
      expect(jitter.value).toBe(15); // (10+20)/2
      expect(loss.value).toBe(0.015); // (0.01+0.02)/2
    });
  });

  describe("Deduplication", () => {
    test("does not publish if values unchanged", () => {
      publisher.publish({ rtt: 50 });
      expect(publishedMessages.length).toBe(1);

      publisher.publish({ rtt: 50 });
      expect(publishedMessages.length).toBe(1); // Not published again
    });

    test("publishes if any value changed", () => {
      publisher.publish({ rtt: 50, jitter: 20 });
      expect(publishedMessages.length).toBe(1);

      publisher.publish({ rtt: 50, jitter: 25 });
      expect(publishedMessages.length).toBe(2); // Published
    });

    test("detects change in calculated link quality", () => {
      publisher.publish({ rtt: 50 });
      expect(publishedMessages.length).toBe(1);

      // linkQuality changes because rtt window average changes
      publisher.publish({ rtt: 500 });
      expect(publishedMessages.length).toBe(2);
    });
  });

  describe("Per-Link Metrics", () => {
    test("publishes primary link metrics", () => {
      publisher.publishLinkMetrics("primary", {
        status: "active",
        rtt: 50,
        loss: 0.01,
        jitter: 10,
        packetLoss: 0.01,
        retransmitRate: 0
      });

      const values = publishedMessages[0].updates[0].values;

      expect(values).toContainEqual({
        path: "networking.edgeLink.links.primary.status",
        value: "active"
      });

      expect(values).toContainEqual({
        path: "networking.edgeLink.links.primary.rtt",
        value: 50
      });
    });

    test("publishes backup link metrics", () => {
      publisher.publishLinkMetrics("backup", {
        status: "standby",
        rtt: 100,
        loss: 0.05,
        jitter: 30,
        packetLoss: 0.05,
        retransmitRate: 0.02
      });

      const values = publishedMessages[0].updates[0].values;

      const status = values.find(v =>
        v.path === "networking.edgeLink.links.backup.status"
      );

      expect(status.value).toBe("standby");
    });

    test("calculates per-link quality", () => {
      publisher.publishLinkMetrics("primary", {
        status: "active",
        rtt: 0,
        loss: 0,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });

      const values = publishedMessages[0].updates[0].values;
      const quality = values.find(v =>
        v.path === "networking.edgeLink.links.primary.quality"
      );

      expect(quality.value).toBe(100);
    });

    test("publishes per-link loss", () => {
      publisher.publishLinkMetrics("primary", {
        status: "active",
        rtt: 50,
        loss: 0.05,
        jitter: 10,
        packetLoss: 0.05,
        retransmitRate: 0
      });

      const values = publishedMessages[0].updates[0].values;
      const loss = values.find(v =>
        v.path === "networking.edgeLink.links.primary.loss"
      );

      expect(loss.value).toBe(0.05);
    });

    test("publishes with source label", () => {
      publisher.publishLinkMetrics("primary", {
        status: "active",
        rtt: 0,
        loss: 0,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });

      const source = publishedMessages[0].updates[0].source;
      expect(source.label).toBe("signalk-edge-link");
    });
  });

  describe("Reset", () => {
    test("clears all windows and last published", () => {
      publisher.publish({ rtt: 50, jitter: 20 });

      publisher.reset();

      expect(publisher.rttWindow).toEqual([]);
      expect(publisher.jitterWindow).toEqual([]);
      expect(publisher.lossWindow).toEqual([]);
      expect(publisher.lastPublished).toEqual({});
    });

    test("allows fresh publishing after reset", () => {
      publisher.publish({ rtt: 50 });
      publisher.reset();

      publishedMessages = [];
      mockApp.handleMessage.mockClear();
      publisher.publish({ rtt: 50 });

      expect(publishedMessages.length).toBe(1);
    });

    test("resets moving averages", () => {
      // Fill windows with high values
      for (let i = 0; i < 5; i++) {
        publisher.publish({ rtt: 500 });
      }

      publisher.reset();
      publishedMessages = [];

      // After reset, average should be just the new value
      publisher.publish({ rtt: 10 });

      const rttValue = publishedMessages[0].updates[0].values.find(
        v => v.path === "networking.edgeLink.rtt"
      );
      expect(rttValue.value).toBe(10);
    });
  });

  describe("Edge Cases", () => {
    test("handles zero values", () => {
      publisher.publish({
        rtt: 0,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });

      const values = publishedMessages[0].updates[0].values;
      const quality = values.find(v => v.path === "networking.edgeLink.linkQuality");
      expect(quality.value).toBe(100);
    });

    test("handles very large RTT", () => {
      const quality = publisher.calculateLinkQuality({
        rtt: 999999,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });

      // rttScore should be clamped to 0
      expect(quality).toBe(70); // loss(40) + rtt(0) + jitter(20) + retransmit(10)
    });

    test("handles partial metrics", () => {
      publisher.publish({ rtt: 50 });

      const values = publishedMessages[0].updates[0].values;
      // Should have rtt and linkQuality at minimum
      expect(values.length).toBeGreaterThanOrEqual(2);
    });

    test("handles empty metrics object", () => {
      publisher.publish({});

      // Should still publish linkQuality
      expect(publishedMessages.length).toBe(1);
      const values = publishedMessages[0].updates[0].values;
      const quality = values.find(v => v.path === "networking.edgeLink.linkQuality");
      expect(quality).toBeDefined();
    });
  });
});
