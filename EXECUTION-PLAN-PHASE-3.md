# Signal K Edge Link v2.0 - Phase 3 Execution Plan (DETAILED)

**Phase**: Network Quality Metrics  
**Duration**: April 5 - April 25, 2026 (3 weeks)  
**Prerequisites**: Phase 2 complete (v2.0.0-alpha.2 released)

---

## Overview

Phase 3 adds comprehensive network quality monitoring:
- 13 new Signal K paths for network metrics
- Link quality calculation algorithm
- Dashboard enhancements
- Optional InfluxDB/Prometheus integration

**Goal**: Complete observability of network conditions

---

## Week 9: Metrics Publisher Implementation

### STEP 9.1: Create Metrics Publisher Specification

**File**: `docs/planning/metrics-spec.md`

**Content**:
```markdown
# Network Metrics Specification

## Signal K Paths (13 new)

### Core Metrics
1. `networking.edgeLink.rtt` (number, ms) - Round-trip time
2. `networking.edgeLink.jitter` (number, ms) - RTT variance
3. `networking.edgeLink.packetLoss` (number, 0.0-1.0) - Loss rate
4. `networking.edgeLink.bandwidth.upload` (number, bytes/sec)
5. `networking.edgeLink.bandwidth.download` (number, bytes/sec)

### Performance Metrics
6. `networking.edgeLink.packetsPerSecond.sent` (number)
7. `networking.edgeLink.packetsPerSecond.received` (number)
8. `networking.edgeLink.retransmissions` (number) - Cumulative count
9. `networking.edgeLink.sequenceNumber` (number) - Current sequence
10. `networking.edgeLink.queueDepth` (number) - Retransmit queue size

### Quality Metrics
11. `networking.edgeLink.linkQuality` (number, 0-100) - Composite score
12. `networking.edgeLink.activeLink` (string) - "primary"|"backup"|"bonded"
13. `networking.edgeLink.compressionRatio` (number) - Existing from v1

### Per-Link Metrics (for bonding)
- `networking.edgeLink.links.primary.{status, rtt, loss, quality}`
- `networking.edgeLink.links.backup.{status, rtt, loss, quality}`

## Link Quality Algorithm

### Formula
```
quality = (
  (1 - packetLoss) * 40 +
  rttScore * 30 +
  jitterScore * 20 +
  retransmitScore * 10
)

where:
  rttScore = clamp(1 - (rtt / 1000), 0, 1)
  jitterScore = clamp(1 - (jitter / 500), 0, 1)
  retransmitScore = clamp(1 - (retransmitRate / 0.1), 0, 1)
```

### Score Interpretation
- 90-100: Excellent (green)
- 70-89: Good (yellow)
- 50-69: Fair (orange)
- 0-49: Poor (red)

## Update Frequency
- Publish every 1 second
- Calculate as moving average (window: 10 seconds)

## Data Sources

### Client Side
- RTT: From ACK timestamp echo
- Jitter: RTT variance (standard deviation)
- Upload bandwidth: Bytes sent per second
- Retransmissions: From retransmit queue stats
- Queue depth: Current retransmit queue size

### Server Side
- Packet loss: From sequence tracker gaps
- Download bandwidth: Bytes received per second
- Packets per second: Received packet count
```

**Git Commit**: `docs(metrics): add network metrics specification`

---

### STEP 9.2: Implement lib/metrics-publisher.js

**File**: `lib/metrics-publisher.js`

**Code**:
```javascript
/**
 * Signal K Edge Link v2.0 - Metrics Publisher
 * 
 * Publishes network quality metrics to Signal K paths.
 * Calculates link quality score from multiple factors.
 * 
 * @module lib/metrics-publisher
 */

class MetricsPublisher {
  /**
   * @param {Object} app - Signal K app instance
   * @param {Object} config - Configuration
   */
  constructor(app, config = {}) {
    this.app = app;
    this.config = config;
    
    // Moving average windows
    this.rttWindow = [];
    this.jitterWindow = [];
    this.lossWindow = [];
    
    this.windowSize = 10; // 10 seconds
    
    // Last published values (for deduplication)
    this.lastPublished = {};
  }

  /**
   * Publish metrics to Signal K
   * 
   * @param {Object} metrics - Metrics object
   */
  publish(metrics) {
    const values = [];
    
    // Core metrics
    if (metrics.rtt !== undefined) {
      this._addToWindow(this.rttWindow, metrics.rtt);
      const avgRtt = this._calculateAverage(this.rttWindow);
      values.push({ path: 'networking.edgeLink.rtt', value: avgRtt });
    }
    
    if (metrics.jitter !== undefined) {
      this._addToWindow(this.jitterWindow, metrics.jitter);
      const avgJitter = this._calculateAverage(this.jitterWindow);
      values.push({ path: 'networking.edgeLink.jitter', value: avgJitter });
    }
    
    if (metrics.packetLoss !== undefined) {
      this._addToWindow(this.lossWindow, metrics.packetLoss);
      const avgLoss = this._calculateAverage(this.lossWindow);
      values.push({ path: 'networking.edgeLink.packetLoss', value: avgLoss });
    }
    
    // Bandwidth
    if (metrics.uploadBandwidth !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.bandwidth.upload', 
        value: metrics.uploadBandwidth 
      });
    }
    
    if (metrics.downloadBandwidth !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.bandwidth.download', 
        value: metrics.downloadBandwidth 
      });
    }
    
    // Performance
    if (metrics.packetsSentPerSec !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.packetsPerSecond.sent', 
        value: metrics.packetsSentPerSec 
      });
    }
    
    if (metrics.packetsReceivedPerSec !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.packetsPerSecond.received', 
        value: metrics.packetsReceivedPerSec 
      });
    }
    
    if (metrics.retransmissions !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.retransmissions', 
        value: metrics.retransmissions 
      });
    }
    
    if (metrics.sequenceNumber !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.sequenceNumber', 
        value: metrics.sequenceNumber 
      });
    }
    
    if (metrics.queueDepth !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.queueDepth', 
        value: metrics.queueDepth 
      });
    }
    
    // Calculate and publish link quality
    const quality = this.calculateLinkQuality({
      rtt: this._calculateAverage(this.rttWindow),
      jitter: this._calculateAverage(this.jitterWindow),
      packetLoss: this._calculateAverage(this.lossWindow),
      retransmitRate: metrics.retransmitRate || 0
    });
    
    values.push({ 
      path: 'networking.edgeLink.linkQuality', 
      value: quality 
    });
    
    // Active link
    if (metrics.activeLink) {
      values.push({ 
        path: 'networking.edgeLink.activeLink', 
        value: metrics.activeLink 
      });
    }
    
    // Compression ratio (from v1)
    if (metrics.compressionRatio !== undefined) {
      values.push({ 
        path: 'networking.edgeLink.compressionRatio', 
        value: metrics.compressionRatio 
      });
    }
    
    // Only publish if values changed
    if (this._hasChanged(values)) {
      this.app.handleMessage('vessels.self', {
        updates: [{
          source: {
            label: 'signalk-edge-link',
            type: 'plugin'
          },
          timestamp: new Date().toISOString(),
          values: values
        }]
      });
      
      this._updateLastPublished(values);
    }
  }

  /**
   * Calculate link quality score (0-100)
   * 
   * @param {Object} params
   * @returns {number} Quality score
   */
  calculateLinkQuality({ rtt, jitter, packetLoss, retransmitRate }) {
    // Normalize to 0-1 scores
    const rttScore = this._clamp(1 - (rtt / 1000), 0, 1);
    const jitterScore = this._clamp(1 - (jitter / 500), 0, 1);
    const lossScore = 1 - packetLoss;
    const retransmitScore = this._clamp(1 - (retransmitRate / 0.1), 0, 1);
    
    // Weighted average
    const quality = (
      lossScore * 40 +
      rttScore * 30 +
      jitterScore * 20 +
      retransmitScore * 10
    );
    
    return Math.round(quality);
  }

  /**
   * Publish per-link metrics (for bonding)
   * 
   * @param {string} linkName - "primary" or "backup"
   * @param {Object} linkMetrics - Link-specific metrics
   */
  publishLinkMetrics(linkName, linkMetrics) {
    const basePath = `networking.edgeLink.links.${linkName}`;
    
    const values = [
      { path: `${basePath}.status`, value: linkMetrics.status },
      { path: `${basePath}.rtt`, value: linkMetrics.rtt },
      { path: `${basePath}.loss`, value: linkMetrics.loss },
      { 
        path: `${basePath}.quality`, 
        value: this.calculateLinkQuality(linkMetrics) 
      }
    ];
    
    this.app.handleMessage('vessels.self', {
      updates: [{
        source: { label: 'signalk-edge-link' },
        timestamp: new Date().toISOString(),
        values: values
      }]
    });
  }

  /**
   * Add value to moving average window
   * 
   * @private
   */
  _addToWindow(window, value) {
    window.push(value);
    if (window.length > this.windowSize) {
      window.shift();
    }
  }

  /**
   * Calculate average of window
   * 
   * @private
   */
  _calculateAverage(window) {
    if (window.length === 0) return 0;
    const sum = window.reduce((a, b) => a + b, 0);
    return sum / window.length;
  }

  /**
   * Clamp value between min and max
   * 
   * @private
   */
  _clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * Check if values have changed since last publish
   * 
   * @private
   */
  _hasChanged(values) {
    for (const { path, value } of values) {
      if (this.lastPublished[path] !== value) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update last published values
   * 
   * @private
   */
  _updateLastPublished(values) {
    for (const { path, value } of values) {
      this.lastPublished[path] = value;
    }
  }

  /**
   * Reset all metrics
   */
  reset() {
    this.rttWindow = [];
    this.jitterWindow = [];
    this.lossWindow = [];
    this.lastPublished = {};
  }
}

module.exports = { MetricsPublisher };
```

**Verification**:
```bash
node -c lib/metrics-publisher.js
```

**Git Commit**: `feat(metrics): implement metrics publisher`

---

### STEP 9.3: Write Metrics Publisher Tests

**File**: `__tests__/v2/metrics-publisher.test.js`

**Code** (30+ tests):
```javascript
const { MetricsPublisher } = require('../../lib/metrics-publisher');

describe('MetricsPublisher', () => {
  let publisher;
  let publishedMessages = [];
  
  const mockApp = {
    handleMessage: jest.fn((context, delta) => {
      publishedMessages.push(delta);
    })
  };

  beforeEach(() => {
    publishedMessages = [];
    publisher = new MetricsPublisher(mockApp);
  });

  describe('Core Metrics Publishing', () => {
    test('publishes RTT metric', () => {
      publisher.publish({ rtt: 50 });
      
      const values = publishedMessages[0].updates[0].values;
      const rttMetric = values.find(v => v.path === 'networking.edgeLink.rtt');
      
      expect(rttMetric).toBeDefined();
      expect(rttMetric.value).toBe(50);
    });

    test('publishes jitter metric', () => {
      publisher.publish({ jitter: 20 });
      
      const values = publishedMessages[0].updates[0].values;
      const jitterMetric = values.find(v => v.path === 'networking.edgeLink.jitter');
      
      expect(jitterMetric).toBeDefined();
      expect(jitterMetric.value).toBe(20);
    });

    test('publishes packet loss metric', () => {
      publisher.publish({ packetLoss: 0.05 });
      
      const values = publishedMessages[0].updates[0].values;
      const lossMetric = values.find(v => v.path === 'networking.edgeLink.packetLoss');
      
      expect(lossMetric).toBeDefined();
      expect(lossMetric.value).toBe(0.05);
    });

    test('publishes bandwidth metrics', () => {
      publisher.publish({ 
        uploadBandwidth: 1000000,
        downloadBandwidth: 500000
      });
      
      const values = publishedMessages[0].updates[0].values;
      
      const upload = values.find(v => v.path === 'networking.edgeLink.bandwidth.upload');
      const download = values.find(v => v.path === 'networking.edgeLink.bandwidth.download');
      
      expect(upload.value).toBe(1000000);
      expect(download.value).toBe(500000);
    });

    test('publishes all 13 metrics when provided', () => {
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
        activeLink: 'primary',
        compressionRatio: 0.97,
        retransmitRate: 0.05
      });
      
      const values = publishedMessages[0].updates[0].values;
      
      // Should have 13 paths (including calculated link quality)
      expect(values.length).toBe(13);
    });
  });

  describe('Link Quality Calculation', () => {
    test('calculates perfect quality (100)', () => {
      const quality = publisher.calculateLinkQuality({
        rtt: 0,
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });
      
      expect(quality).toBe(100);
    });

    test('calculates poor quality with high loss', () => {
      const quality = publisher.calculateLinkQuality({
        rtt: 100,
        jitter: 50,
        packetLoss: 0.20,  // 20% loss
        retransmitRate: 0.05
      });
      
      expect(quality).toBeLessThan(50);
    });

    test('weights packet loss heavily (40%)', () => {
      const highLoss = publisher.calculateLinkQuality({
        rtt: 0,
        jitter: 0,
        packetLoss: 0.50,  // Only bad metric
        retransmitRate: 0
      });
      
      // 50% loss should result in ~50 quality (loss has 40% weight)
      expect(highLoss).toBeGreaterThan(40);
      expect(highLoss).toBeLessThan(60);
    });

    test('weights RTT second (30%)', () => {
      const highRTT = publisher.calculateLinkQuality({
        rtt: 1000,  // Very high RTT
        jitter: 0,
        packetLoss: 0,
        retransmitRate: 0
      });
      
      // High RTT should reduce quality by ~30
      expect(highRTT).toBeGreaterThan(60);
      expect(highRTT).toBeLessThan(80);
    });

    test('clamps scores to 0-100 range', () => {
      const veryBad = publisher.calculateLinkQuality({
        rtt: 10000,
        jitter: 10000,
        packetLoss: 1.0,
        retransmitRate: 1.0
      });
      
      expect(veryBad).toBeGreaterThanOrEqual(0);
      expect(veryBad).toBeLessThanOrEqual(100);
    });
  });

  describe('Moving Average', () => {
    test('calculates moving average over window', () => {
      publisher.publish({ rtt: 50 });
      publisher.publish({ rtt: 60 });
      publisher.publish({ rtt: 70 });
      
      // Average should be (50 + 60 + 70) / 3 = 60
      const lastMessage = publishedMessages[publishedMessages.length - 1];
      const rttValue = lastMessage.updates[0].values.find(
        v => v.path === 'networking.edgeLink.rtt'
      );
      
      expect(rttValue.value).toBe(60);
    });

    test('limits window size to configured value', () => {
      publisher.windowSize = 3;
      
      for (let i = 0; i < 10; i++) {
        publisher.publish({ rtt: i * 10 });
      }
      
      // Window should only contain last 3 values: 70, 80, 90
      // Average: (70 + 80 + 90) / 3 = 80
      const lastMessage = publishedMessages[publishedMessages.length - 1];
      const rttValue = lastMessage.updates[0].values.find(
        v => v.path === 'networking.edgeLink.rtt'
      );
      
      expect(rttValue.value).toBe(80);
    });
  });

  describe('Deduplication', () => {
    test('does not publish if values unchanged', () => {
      publisher.publish({ rtt: 50 });
      expect(publishedMessages.length).toBe(1);
      
      publisher.publish({ rtt: 50 });  // Same value
      expect(publishedMessages.length).toBe(1);  // Not published again
    });

    test('publishes if any value changed', () => {
      publisher.publish({ rtt: 50, jitter: 20 });
      expect(publishedMessages.length).toBe(1);
      
      publisher.publish({ rtt: 50, jitter: 25 });  // Jitter changed
      expect(publishedMessages.length).toBe(2);  // Published
    });
  });

  describe('Per-Link Metrics', () => {
    test('publishes primary link metrics', () => {
      publisher.publishLinkMetrics('primary', {
        status: 'active',
        rtt: 50,
        loss: 0.01,
        jitter: 10,
        retransmitRate: 0
      });
      
      const values = publishedMessages[0].updates[0].values;
      
      expect(values).toContainEqual({
        path: 'networking.edgeLink.links.primary.status',
        value: 'active'
      });
      
      expect(values).toContainEqual({
        path: 'networking.edgeLink.links.primary.rtt',
        value: 50
      });
    });

    test('publishes backup link metrics', () => {
      publisher.publishLinkMetrics('backup', {
        status: 'standby',
        rtt: 100,
        loss: 0.05,
        jitter: 30,
        retransmitRate: 0.02
      });
      
      const values = publishedMessages[0].updates[0].values;
      
      const status = values.find(v => 
        v.path === 'networking.edgeLink.links.backup.status'
      );
      
      expect(status.value).toBe('standby');
    });

    test('calculates per-link quality', () => {
      publisher.publishLinkMetrics('primary', {
        status: 'active',
        rtt: 0,
        loss: 0,
        jitter: 0,
        retransmitRate: 0
      });
      
      const values = publishedMessages[0].updates[0].values;
      const quality = values.find(v => 
        v.path === 'networking.edgeLink.links.primary.quality'
      );
      
      expect(quality.value).toBe(100);
    });
  });

  describe('Reset', () => {
    test('clears all windows and last published', () => {
      publisher.publish({ rtt: 50, jitter: 20 });
      
      publisher.reset();
      
      expect(publisher.rttWindow).toEqual([]);
      expect(publisher.jitterWindow).toEqual([]);
      expect(publisher.lastPublished).toEqual({});
    });

    test('allows fresh publishing after reset', () => {
      publisher.publish({ rtt: 50 });
      publisher.reset();
      
      publishedMessages = [];
      publisher.publish({ rtt: 50 });
      
      expect(publishedMessages.length).toBe(1);
    });
  });
});
```

**Verification**:
```bash
npm test -- __tests__/v2/metrics-publisher.test.js --coverage
```

**Expected**: 30+ tests pass, >95% coverage

**Git Commit**: `test(metrics): add metrics publisher tests`

---

### STEP 9.4: Integrate Metrics into Client Pipeline

**File**: `lib/pipeline-v2-client.js`

**Changes**:
```javascript
const { MetricsPublisher } = require('./metrics-publisher');

class PipelineV2Client {
  constructor(config, state, app) {
    // ... existing code ...
    
    // Add metrics publisher
    this.metricsPublisher = new MetricsPublisher(app, config);
    
    // Metrics collection
    this.metricsInterval = null;
    this.lastMetricsTime = Date.now();
    this.lastBytesSent = 0;
    this.lastPacketsSent = 0;
  }

  start() {
    // ... existing code ...
    
    // Start metrics publishing (every 1 second)
    this._startMetricsPublishing();
  }

  /**
   * Start periodic metrics publishing
   * 
   * @private
   */
  _startMetricsPublishing() {
    this.metricsInterval = setInterval(() => {
      this._publishMetrics();
    }, 1000);
  }

  /**
   * Collect and publish metrics
   * 
   * @private
   */
  _publishMetrics() {
    const now = Date.now();
    const elapsed = (now - this.lastMetricsTime) / 1000; // seconds
    
    // Calculate rates
    const bytesSent = this.metrics.bytesSent - this.lastBytesSent;
    const packetsSent = this.metrics.packetsSent - this.lastPacketsSent;
    
    const uploadBandwidth = bytesSent / elapsed;
    const packetsSentPerSec = packetsSent / elapsed;
    
    // Calculate retransmit rate
    const retransmitRate = this.metrics.packetsSent > 0 ?
      this.metrics.retransmissions / this.metrics.packetsSent : 0;
    
    // Publish to Signal K
    this.metricsPublisher.publish({
      rtt: this.metrics.rtt || 0,
      jitter: this.metrics.jitter || 0,
      uploadBandwidth: uploadBandwidth,
      packetsSentPerSec: packetsSentPerSec,
      retransmissions: this.metrics.retransmissions,
      sequenceNumber: this.packetBuilder.getCurrentSequence(),
      queueDepth: this.retransmitQueue.getSize(),
      retransmitRate: retransmitRate,
      activeLink: 'primary',  // Phase 5: Update for bonding
      compressionRatio: this.metrics.compressionRatio || 0
    });
    
    // Update last values
    this.lastMetricsTime = now;
    this.lastBytesSent = this.metrics.bytesSent;
    this.lastPacketsSent = this.metrics.packetsSent;
  }

  stop() {
    // ... existing code ...
    
    // Stop metrics publishing
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }
}
```

**Git Commit**: `feat(pipeline): integrate metrics publishing in client`

---

### STEP 9.5: Integrate Metrics into Server Pipeline

**File**: `lib/pipeline-v2-server.js`

**Changes**:
```javascript
const { MetricsPublisher } = require('./metrics-publisher');

class PipelineV2Server {
  constructor(config, state, app) {
    // ... existing code ...
    
    // Add metrics publisher
    this.metricsPublisher = new MetricsPublisher(app, config);
    
    // Metrics collection
    this.metricsInterval = null;
    this.lastMetricsTime = Date.now();
    this.lastBytesReceived = 0;
    this.lastPacketsReceived = 0;
  }

  listen() {
    // ... existing code ...
    
    // Start metrics publishing
    this._startMetricsPublishing();
  }

  /**
   * Start periodic metrics publishing
   * 
   * @private
   */
  _startMetricsPublishing() {
    this.metricsInterval = setInterval(() => {
      this._publishMetrics();
    }, 1000);
  }

  /**
   * Collect and publish metrics
   * 
   * @private
   */
  _publishMetrics() {
    const now = Date.now();
    const elapsed = (now - this.lastMetricsTime) / 1000;
    
    // Calculate rates
    const bytesReceived = this.metrics.bytesReceived - this.lastBytesReceived;
    const packetsReceived = this.metrics.packetsReceived - this.lastPacketsReceived;
    
    const downloadBandwidth = bytesReceived / elapsed;
    const packetsReceivedPerSec = packetsReceived / elapsed;
    
    // Calculate packet loss
    const totalExpected = this.sequenceTracker.expectedSeq;
    const totalReceived = this.metrics.packetsReceived;
    const packetLoss = totalExpected > 0 ? 
      (totalExpected - totalReceived) / totalExpected : 0;
    
    // Publish to Signal K
    this.metricsPublisher.publish({
      downloadBandwidth: downloadBandwidth,
      packetsReceivedPerSec: packetsReceivedPerSec,
      packetLoss: Math.max(0, packetLoss),
      sequenceNumber: this.sequenceTracker.expectedSeq,
      compressionRatio: this.metrics.compressionRatio || 0
    });
    
    // Update last values
    this.lastMetricsTime = now;
    this.lastBytesReceived = this.metrics.bytesReceived;
    this.lastPacketsReceived = this.metrics.packetsReceived;
  }

  stop() {
    // ... existing code ...
    
    // Stop metrics publishing
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }
  }
}
```

**Git Commit**: `feat(pipeline): integrate metrics publishing in server`

---

## Week 10: Dashboard Updates

### STEP 10.1: Add Metrics Endpoint Updates

**File**: `lib/routes.js`

**Add Endpoint**:
```javascript
/**
 * GET /plugins/signalk-edge-link/metrics
 * Returns current network metrics
 */
router.get('/metrics', (req, res) => {
  try {
    const metrics = {
      // From pipeline
      ...state.pipeline.getMetrics(),
      
      // From metrics publisher
      linkQuality: state.pipeline.metricsPublisher.calculateLinkQuality({
        rtt: state.pipeline.metrics.rtt || 0,
        jitter: state.pipeline.metrics.jitter || 0,
        packetLoss: state.pipeline.metrics.packetLoss || 0,
        retransmitRate: state.pipeline.metrics.retransmitRate || 0
      }),
      
      // Timestamp
      timestamp: Date.now()
    };
    
    res.json(metrics);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

**Git Commit**: `feat(routes): add comprehensive metrics endpoint`

---

### STEP 10.2: Update Dashboard UI - Charts

**File**: `src/webapp/index.js`

**Add RTT Chart**:
```javascript
// Add to existing dashboard code

// RTT Chart (line chart)
function createRTTChart() {
  const canvas = document.getElementById('rtt-chart');
  const ctx = canvas.getContext('2d');
  
  const rttData = {
    labels: [],
    datasets: [{
      label: 'RTT (ms)',
      data: [],
      borderColor: 'rgb(75, 192, 192)',
      tension: 0.1,
      fill: false
    }]
  };
  
  const rttChart = new Chart(ctx, {
    type: 'line',
    data: rttData,
    options: {
      responsive: true,
      scales: {
        y: {
          beginAtZero: true,
          title: {
            display: true,
            text: 'Milliseconds'
          }
        },
        x: {
          title: {
            display: true,
            text: 'Time'
          }
        }
      },
      plugins: {
        title: {
          display: true,
          text: 'Round-Trip Time (RTT)'
        }
      }
    }
  });
  
  return rttChart;
}

// Update chart with new data
function updateRTTChart(chart, metrics) {
  const now = new Date().toLocaleTimeString();
  
  chart.data.labels.push(now);
  chart.data.datasets[0].data.push(metrics.rtt);
  
  // Keep last 60 data points (1 minute at 1Hz)
  if (chart.data.labels.length > 60) {
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  
  chart.update();
}
```

**Add Link Quality Gauge**:
```javascript
function createLinkQualityGauge() {
  const canvas = document.getElementById('link-quality-gauge');
  const ctx = canvas.getContext('2d');
  
  const gauge = new Chart(ctx, {
    type: 'doughnut',
    data: {
      datasets: [{
        data: [0, 100],
        backgroundColor: ['#4CAF50', '#E0E0E0'],
        circumference: 180,
        rotation: 270
      }]
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: 'Link Quality'
        },
        tooltip: {
          enabled: false
        }
      }
    }
  });
  
  return gauge;
}

function updateLinkQualityGauge(gauge, quality) {
  // Update value
  gauge.data.datasets[0].data = [quality, 100 - quality];
  
  // Update color based on quality
  let color;
  if (quality >= 90) color = '#4CAF50';  // Green
  else if (quality >= 70) color = '#FFC107';  // Yellow
  else if (quality >= 50) color = '#FF9800';  // Orange
  else color = '#F44336';  // Red
  
  gauge.data.datasets[0].backgroundColor = [color, '#E0E0E0'];
  gauge.update();
}
```

**Git Commit**: `feat(dashboard): add RTT chart and link quality gauge`

---

*Due to length, continuing in next file...*
