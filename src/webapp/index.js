import "./styles.css";

// Constants
const API_BASE_PATH = "/plugins/signalk-edge-link";
const DELTA_TIMER_MIN = 100;
const DELTA_TIMER_MAX = 10000;
const NOTIFICATION_TIMEOUT = 4000;
const METRICS_REFRESH_INTERVAL = 15000; // 15 seconds (optimized from 5s to reduce server load)
const JSON_SYNC_DEBOUNCE = 300; // Debounce delay for JSON editor sync

// HTML Template Helpers
const renderCard = (title, subtitle, contentId, contentClass = "") => `
  <div class="config-section">
    <div class="card">
      <div class="card-header">
        <h2>${title}</h2>
        ${subtitle ? `<p class="subtitle">${subtitle}</p>` : ""}
      </div>
      <div class="card-content">
        <div id="${contentId}" class="${contentClass || contentId + "-info"}">
          <p>Loading ${title.toLowerCase()}...</p>
        </div>
      </div>
    </div>
  </div>
`;

const renderStatItem = (label, value, hasError = false) => `
  <div class="stat-item${hasError ? " error" : ""}">
    <span class="stat-label">${label}:</span>
    <span class="stat-value">${value}</span>
  </div>
`;

const renderMetricItem = (label, value, statusClass = "") => `
  <div class="metric-item${statusClass ? " " + statusClass : ""}">
    <div class="metric-label">${label}</div>
    <div class="metric-value">${value}</div>
  </div>
`;

const renderBwStat = (label, value, isHighlight = false, isSuccess = false) => `
  <div class="bw-stat${isHighlight ? " highlight" : ""}">
    <span class="bw-label">${label}:</span>
    <span class="bw-value${isSuccess ? " success-text" : ""}">${value}</span>
  </div>
`;

class DataConnectorConfig {
  constructor() {
    this.deltaTimerConfig = null;
    this.subscriptionConfig = null;
    this.sentenceFilterConfig = null;
    this.isServerMode = false;
    this.metricsInterval = null;
    this.syncTimeout = null;
    this.init();
  }

  async init() {
    try {
      await this.checkServerMode();
      if (this.isServerMode) {
        this.showServerModeUI();
      } else {
        await this.loadConfigurations();
        this.setupEventListeners();
        this.updateUI();
        this.updateStatus();
      }
      await this.loadMetrics();
      this.startMetricsRefresh();
    } catch (error) {
      console.error("Initialization error:", error);
      this.showNotification("Failed to initialize application: " + error.message, "error");
    }
  }

  async checkServerMode() {
    try {
      // Try to access the configuration API
      const response = await fetch(`${API_BASE_PATH}/config/delta_timer.json`);
      this.isServerMode = !response.ok && (response.status === 404 || response.status === 405);
    } catch (error) {
      // If fetch fails completely, assume server mode
      this.isServerMode = true;
    }
  }

  async loadConfigurations() {
    try {
      const [deltaResponse, subResponse, filterResponse] = await Promise.all([
        fetch(`${API_BASE_PATH}/config/delta_timer.json`),
        fetch(`${API_BASE_PATH}/config/subscription.json`),
        fetch(`${API_BASE_PATH}/config/sentence_filter.json`)
      ]);

      if (deltaResponse.ok) {
        this.deltaTimerConfig = await deltaResponse.json();
      }
      if (subResponse.ok) {
        this.subscriptionConfig = await subResponse.json();
      }
      if (filterResponse.ok) {
        this.sentenceFilterConfig = await filterResponse.json();
      }
    } catch (error) {
      this.showNotification("Error loading configurations: " + error.message, "error");
    }
  }

  setupEventListeners() {
    // Delta timer save button
    document.getElementById("saveDeltaTimer").addEventListener("click", () => {
      this.saveDeltaTimer();
    });

    // Subscription save button
    document.getElementById("saveSubscription").addEventListener("click", () => {
      this.saveSubscription();
    });

    // Sentence filter save button
    document.getElementById("saveSentenceFilter").addEventListener("click", () => {
      this.saveSentenceFilter();
    });

    // Add path button
    document.getElementById("addPath").addEventListener("click", () => {
      this.addPathItem();
    });

    // JSON editor sync (debounced to avoid rebuilding form on every keystroke)
    document.getElementById("subscriptionJson").addEventListener("input", () => {
      if (this.syncTimeout) {
        clearTimeout(this.syncTimeout);
      }
      this.syncTimeout = setTimeout(() => {
        this.syncFromJson();
      }, JSON_SYNC_DEBOUNCE);
    });

    // Context input change
    document.getElementById("context").addEventListener("input", () => {
      this.updateJsonFromForm();
    });
  }

  updateUI() {
    // Update delta timer input
    if (this.deltaTimerConfig && this.deltaTimerConfig.deltaTimer) {
      document.getElementById("deltaTimer").value = this.deltaTimerConfig.deltaTimer;
    }

    // Update subscription configuration
    if (this.subscriptionConfig) {
      document.getElementById("context").value = this.subscriptionConfig.context || "*";

      // Clear existing paths
      document.getElementById("pathsList").innerHTML = "";

      // Add subscription paths
      if (this.subscriptionConfig.subscribe && Array.isArray(this.subscriptionConfig.subscribe)) {
        this.subscriptionConfig.subscribe.forEach((sub) => {
          this.addPathItem(sub.path);
        });
      }

      // Update JSON editor
      document.getElementById("subscriptionJson").value = JSON.stringify(
        this.subscriptionConfig,
        null,
        2
      );
    }

    // Update sentence filter input
    if (this.sentenceFilterConfig && Array.isArray(this.sentenceFilterConfig.excludedSentences)) {
      document.getElementById("sentenceFilter").value =
        this.sentenceFilterConfig.excludedSentences.join(", ");
    }
  }

  addPathItem(path = "") {
    const pathsList = document.getElementById("pathsList");
    const pathItem = document.createElement("div");
    pathItem.className = "path-item";

    // Create elements safely to prevent XSS
    const input = document.createElement("input");
    input.type = "text";
    input.value = path; // Safe: value property is automatically escaped
    input.placeholder = "navigation.position";
    input.className = "path-input";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-danger";
    button.textContent = "Remove";

    // Add event listeners
    input.addEventListener("input", () => {
      this.updateJsonFromForm();
    });

    button.addEventListener("click", () => {
      pathItem.remove();
      this.updateJsonFromForm();
    });

    pathItem.appendChild(input);
    pathItem.appendChild(button);
    pathsList.appendChild(pathItem);
    this.updateJsonFromForm();
  }

  updateJsonFromForm() {
    const context = document.getElementById("context").value || "*";
    const pathInputs = document.querySelectorAll(".path-input");
    const subscribe = Array.from(pathInputs)
      .map((input) => ({ path: input.value }))
      .filter((sub) => sub.path.trim() !== "");

    const config = {
      context: context,
      subscribe: subscribe
    };

    document.getElementById("subscriptionJson").value = JSON.stringify(config, null, 2);
  }

  syncFromJson() {
    try {
      const jsonText = document.getElementById("subscriptionJson").value;
      const config = JSON.parse(jsonText);

      // Update context
      document.getElementById("context").value = config.context || "*";

      // Update paths
      const pathsList = document.getElementById("pathsList");
      pathsList.innerHTML = "";

      if (config.subscribe && Array.isArray(config.subscribe)) {
        config.subscribe.forEach((sub) => {
          this.addPathItem(sub.path || "");
        });
      }
    } catch (error) {
      // Invalid JSON, don't update form
      console.warn("Invalid JSON in editor:", error.message);
    }
  }

  async saveConfig(filename, config, configKey, label) {
    try {
      const response = await fetch(`${API_BASE_PATH}/config/${filename}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });

      if (response.ok) {
        this[configKey] = config;
        this.showNotification(`${label} saved successfully!`, "success");
        this.updateStatus();
      } else {
        throw new Error("Failed to save configuration");
      }
    } catch (error) {
      this.showNotification(`Error saving ${label.toLowerCase()}: ` + error.message, "error");
    }
  }

  async saveDeltaTimer() {
    const deltaTimer = parseInt(document.getElementById("deltaTimer").value);

    if (isNaN(deltaTimer) || deltaTimer < DELTA_TIMER_MIN || deltaTimer > DELTA_TIMER_MAX) {
      this.showNotification(
        `Delta timer must be between ${DELTA_TIMER_MIN} and ${DELTA_TIMER_MAX} milliseconds`,
        "error"
      );
      return;
    }

    await this.saveConfig("delta_timer.json", { deltaTimer }, "deltaTimerConfig", "Delta timer configuration");
  }

  async saveSubscription() {
    try {
      const jsonText = document.getElementById("subscriptionJson").value;
      const config = JSON.parse(jsonText);

      if (!config.context) {
        throw new Error("Context is required");
      }
      if (!config.subscribe || !Array.isArray(config.subscribe)) {
        throw new Error("Subscribe array is required");
      }

      await this.saveConfig("subscription.json", config, "subscriptionConfig", "Subscription configuration");
    } catch (error) {
      this.showNotification("Error saving subscription: " + error.message, "error");
    }
  }

  async saveSentenceFilter() {
    const filterInput = document.getElementById("sentenceFilter").value;
    const excludedSentences = filterInput
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);

    await this.saveConfig("sentence_filter.json", { excludedSentences }, "sentenceFilterConfig", "Sentence filter");
  }

  async loadMetrics() {
    try {
      const response = await fetch(`${API_BASE_PATH}/metrics`);
      if (response.ok) {
        const metrics = await response.json();
        this.updateMetricsDisplay(metrics);
      }
    } catch (error) {
      console.error("Error loading metrics:", error.message);
    }
  }

  startMetricsRefresh() {
    // Clear any existing interval
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    this.metricsInterval = setInterval(() => {
      this.loadMetrics();
    }, METRICS_REFRESH_INTERVAL);
  }

  updateMetricsDisplay(metrics) {
    // Update bandwidth display
    this.updateBandwidthDisplay(metrics);

    // Update path analytics display
    this.updatePathAnalyticsDisplay(metrics);

    // Update general metrics
    const metricsDiv = document.getElementById("metrics");
    if (!metricsDiv) {
      return;
    }

    const isClient = metrics.mode === "client";
    const { stats, status, uptime } = metrics;

    const hasErrors =
      stats.udpSendErrors > 0 ||
      stats.compressionErrors > 0 ||
      stats.encryptionErrors > 0 ||
      stats.subscriptionErrors > 0;

    // Build metrics grid items
    const metricsGridItems = [
      renderMetricItem("Uptime", uptime.formatted),
      renderMetricItem("Mode", isClient ? "📱 Client" : "🖥️ Server"),
      renderMetricItem("Status", status.readyToSend ? "✓ Ready" : "✗ Not Ready", status.readyToSend ? "success" : "error"),
      isClient ? renderMetricItem("Buffered Deltas", status.deltasBuffered) : ""
    ].join("");

    // Build stats items
    const statsItems = [
      isClient
        ? renderStatItem("Deltas Sent", stats.deltasSent.toLocaleString())
        : renderStatItem("Deltas Received", stats.deltasReceived.toLocaleString()),
      isClient ? renderStatItem("UDP Send Errors", stats.udpSendErrors, stats.udpSendErrors > 0) : "",
      isClient ? renderStatItem("UDP Retries", stats.udpRetries) : "",
      renderStatItem("Compression Errors", stats.compressionErrors, stats.compressionErrors > 0),
      renderStatItem("Encryption Errors", stats.encryptionErrors, stats.encryptionErrors > 0),
      isClient ? renderStatItem("Subscription Errors", stats.subscriptionErrors, stats.subscriptionErrors > 0) : ""
    ].join("");

    let metricsHtml = `
      <h4>📊 Performance Metrics</h4>
      <div class="metrics-grid">${metricsGridItems}</div>
      <div class="metrics-stats">
        <h5>Transmission Statistics</h5>
        <div class="stats-grid">${statsItems}</div>
      </div>
    `;

    // Add Smart Batching section for client mode
    if (isClient && metrics.smartBatching) {
      const sb = metrics.smartBatching;
      const totalSends = sb.earlySends + sb.timerSends;
      const earlyPercent = totalSends > 0 ? Math.round((sb.earlySends / totalSends) * 100) : 0;

      metricsHtml += `
        <div class="metrics-stats">
          <h5>📦 Smart Batching</h5>
          <div class="stats-grid">
            ${renderStatItem("Avg Bytes/Delta", sb.avgBytesPerDelta + " bytes")}
            ${renderStatItem("Max Deltas/Batch", sb.maxDeltasPerBatch)}
            ${renderStatItem("Early Sends", sb.earlySends.toLocaleString() + " (" + earlyPercent + "%)")}
            ${renderStatItem("Timer Sends", sb.timerSends.toLocaleString())}
            ${renderStatItem("Oversized Packets", sb.oversizedPackets, sb.oversizedPackets > 0)}
          </div>
        </div>
      `;
    }

    if (metrics.lastError) {
      const timeAgo = metrics.lastError.timeAgo;
      const timeAgoStr = timeAgo < 60000
        ? `${Math.floor(timeAgo / 1000)}s ago`
        : `${Math.floor(timeAgo / 60000)}m ago`;

      metricsHtml += `
        <div class="metrics-error">
          <h5>⚠️ Last Error</h5>
          <div class="error-message">${this.escapeHtml(metrics.lastError.message)}</div>
          <div class="error-time">Occurred ${timeAgoStr}</div>
        </div>
      `;
    } else if (!hasErrors) {
      metricsHtml += `
        <div class="metrics-success">
          <div class="success-message">✓ No errors detected</div>
        </div>
      `;
    }

    metricsDiv.innerHTML = metricsHtml;
  }

  updateBandwidthDisplay(metrics) {
    const bandwidthDiv = document.getElementById("bandwidth");
    if (!bandwidthDiv || !metrics.bandwidth) {
      return;
    }

    const bw = metrics.bandwidth;
    const isClient = metrics.mode === "client";

    // Calculate savings (client uses bytesOut, server uses bytesIn)
    const savedBytes = isClient ? bw.bytesOutRaw - bw.bytesOut : bw.bytesInRaw - bw.bytesIn;
    const savedFormatted = this.formatBytes(savedBytes > 0 ? savedBytes : 0);

    // Build bandwidth stats based on mode
    const bandwidthStats = isClient
      ? [
        renderBwStat("Total Sent (Compressed)", bw.bytesOutFormatted),
        renderBwStat("Total Raw (Before Compression)", bw.bytesOutRawFormatted),
        renderBwStat("Bandwidth Saved", savedFormatted, true, true),
        renderBwStat("Packets Sent", bw.packetsOut.toLocaleString())
      ]
      : [
        renderBwStat("Total Received (Compressed)", bw.bytesInFormatted),
        renderBwStat("Total Raw (After Decompression)", this.formatBytes(bw.bytesInRaw || 0)),
        renderBwStat("Bandwidth Saved", savedFormatted, true, true),
        renderBwStat("Packets Received", bw.packetsIn.toLocaleString())
      ];

    const bandwidthHtml = `
      <div class="bandwidth-dashboard">
        <div class="bandwidth-hero">
          <div class="hero-stat ${isClient ? "primary" : "secondary"}">
            <div class="hero-value">${isClient ? bw.rateOutFormatted : bw.rateInFormatted}</div>
            <div class="hero-label">${isClient ? "Upload Rate" : "Download Rate"}</div>
          </div>
          <div class="hero-stat success">
            <div class="hero-value">${bw.compressionRatio}%</div>
            <div class="hero-label">Compression Ratio</div>
          </div>
          <div class="hero-stat">
            <div class="hero-value">${bw.avgPacketSizeFormatted}</div>
            <div class="hero-label">Avg Packet Size</div>
          </div>
        </div>

        <div class="bandwidth-details">
          <h5>📊 Bandwidth Details</h5>
          <div class="bandwidth-grid">${bandwidthStats.join("")}</div>
        </div>

        ${this.renderBandwidthChart(bw.history, isClient)}
      </div>
    `;

    bandwidthDiv.innerHTML = bandwidthHtml;
  }

  renderBandwidthChart(history, isClient) {
    if (!history || history.length < 2) {
      return `
        <div class="bandwidth-chart-placeholder">
          <p>Collecting data for chart... (${history ? history.length : 0}/2 points)</p>
        </div>
      `;
    }

    // Simple SVG sparkline chart
    const width = 100;
    const height = 40;
    const maxRate = Math.max(...history.map((h) => (isClient ? h.rateOut : h.rateIn)), 1);
    const points = history
      .map((h, i) => {
        const x = (i / (history.length - 1)) * width;
        const y = height - ((isClient ? h.rateOut : h.rateIn) / maxRate) * height;
        return `${x},${y}`;
      })
      .join(" ");

    const maxRateFormatted = this.formatBytes(maxRate);
    const intervalSeconds = METRICS_REFRESH_INTERVAL / 1000;

    return `
      <div class="bandwidth-chart">
        <h5>📈 Rate History (Last ${history.length * intervalSeconds}s)</h5>
        <div class="chart-container">
          <svg viewBox="0 0 ${width} ${height}" class="sparkline" preserveAspectRatio="none">
            <polyline
              fill="none"
              stroke="var(--primary-color)"
              stroke-width="1.5"
              points="${points}"
            />
          </svg>
          <div class="chart-labels">
            <span class="chart-max">${maxRateFormatted}/s</span>
            <span class="chart-min">0</span>
          </div>
        </div>
      </div>
    `;
  }

  updatePathAnalyticsDisplay(metrics) {
    const pathDiv = document.getElementById("pathAnalytics");
    if (!pathDiv || !metrics.pathStats) {
      return;
    }

    const paths = metrics.pathStats;

    if (paths.length === 0) {
      pathDiv.innerHTML = `
        <div class="path-analytics-empty">
          <p>No path data collected yet. Data will appear once deltas are transmitted.</p>
        </div>
      `;
      return;
    }

    // Count unique categories
    const categoryCount = new Set(paths.map((p) => p.path.split(".")[0])).size;

    let pathHtml = `
      <div class="path-analytics-dashboard">
        <div class="path-summary">
          <div class="summary-stat">
            <span class="summary-value">${paths.length}</span>
            <span class="summary-label">Active Paths</span>
          </div>
          <div class="summary-stat">
            <span class="summary-value">${categoryCount}</span>
            <span class="summary-label">Categories</span>
          </div>
        </div>

        <div class="path-table-container">
          <table class="path-table">
            <thead>
              <tr>
                <th>Path</th>
                <th>Updates/min</th>
                <th>Data Volume</th>
                <th>% of Total</th>
              </tr>
            </thead>
            <tbody>
    `;

    // Show top 15 paths
    paths.slice(0, 15).forEach((p) => {
      const barWidth = Math.max(p.percentage, 2); // Minimum 2% width for visibility
      pathHtml += `
        <tr>
          <td class="path-name" title="${this.escapeHtml(p.path)}">${this.escapeHtml(p.path)}</td>
          <td class="path-rate">${p.updatesPerMinute}</td>
          <td class="path-bytes">${p.bytesFormatted}</td>
          <td class="path-percentage">
            <div class="percentage-bar-container">
              <div class="percentage-bar" style="width: ${barWidth}%"></div>
              <span class="percentage-text">${p.percentage}%</span>
            </div>
          </td>
        </tr>
      `;
    });

    pathHtml += `
            </tbody>
          </table>
        </div>
    `;

    if (paths.length > 15) {
      pathHtml += `
        <div class="path-more">
          <p>Showing top 15 of ${paths.length} paths</p>
        </div>
      `;
    }

    pathHtml += "</div>";

    pathDiv.innerHTML = pathHtml;
  }

  formatBytes(bytes) {
    if (!bytes || bytes <= 0) {
      return "0 B";
    }
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  updateStatus() {
    const statusDiv = document.getElementById("status");
    let statusHtml = "<h4>Configuration Status</h4>";

    // Delta timer status
    if (this.deltaTimerConfig) {
      statusHtml += `
                <div class="status-item">
                    <strong>Delta Timer:</strong> ${this.escapeHtml(String(this.deltaTimerConfig.deltaTimer))}ms
                    <span class="status-indicator success">✓ Configured</span>
                </div>
            `;
    } else {
      statusHtml += `
                <div class="status-item">
                    <strong>Delta Timer:</strong>
                    <span class="status-indicator warning">⚠ Not configured</span>
                </div>
            `;
    }

    // Subscription status
    if (this.subscriptionConfig && this.subscriptionConfig.subscribe) {
      const pathCount = this.subscriptionConfig.subscribe.length;
      const escapedContext = this.escapeHtml(this.subscriptionConfig.context || "");
      const escapedPaths = this.subscriptionConfig.subscribe.map((s) => this.escapeHtml(s.path)).join(", ");
      statusHtml += `
                <div class="status-item">
                    <strong>Subscriptions:</strong> ${pathCount} path(s) configured
                    <span class="status-indicator success">✓ Configured</span>
                </div>
                <div class="status-details">
                    <strong>Context:</strong> ${escapedContext}<br>
                    <strong>Paths:</strong> ${escapedPaths}
                </div>
            `;
    } else {
      statusHtml += `
                <div class="status-item">
                    <strong>Subscriptions:</strong>
                    <span class="status-indicator warning">⚠ Not configured</span>
                </div>
            `;
    }

    // Sentence filter status
    if (
      this.sentenceFilterConfig &&
      this.sentenceFilterConfig.excludedSentences &&
      this.sentenceFilterConfig.excludedSentences.length > 0
    ) {
      const filterCount = this.sentenceFilterConfig.excludedSentences.length;
      const escapedFilters = this.sentenceFilterConfig.excludedSentences.map((s) => this.escapeHtml(s)).join(", ");
      statusHtml += `
                <div class="status-item">
                    <strong>Sentence Filter:</strong> ${filterCount} sentence(s) excluded
                    <span class="status-indicator success">✓ Configured</span>
                </div>
                <div class="status-details">
                    <strong>Excluded:</strong> ${escapedFilters}
                </div>
            `;
    } else {
      statusHtml += `
                <div class="status-item">
                    <strong>Sentence Filter:</strong>
                    <span class="status-indicator info">ℹ No filters (all sentences transmitted)</span>
                </div>
            `;
    }

    statusDiv.innerHTML = statusHtml;
  }

  showServerModeUI() {
    const container = document.querySelector(".container");

    // Server mode info card (special styling)
    const serverModeCard = `
      <div class="config-section">
        <div class="card server-mode-card">
          <div class="card-header">
            <h2>Server Mode Active</h2>
            <p>This plugin is running in Server Mode - receiving data from clients</p>
          </div>
          <div class="card-content">
            <div class="server-mode-info">
              <div class="info-grid compact">
                <div class="info-item">
                  <h4>Configuration</h4>
                  <p>Managed through SignalK plugin settings</p>
                </div>
                <div class="info-item">
                  <h4>Data Flow</h4>
                  <p>Client Devices → Server → SignalK</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    container.innerHTML =
      serverModeCard +
      renderCard("Bandwidth Monitor", "Network reception statistics", "bandwidth") +
      renderCard("Path Analytics", "Incoming data volume by SignalK path", "pathAnalytics") +
      renderCard("Performance Metrics", "Real-time reception statistics (auto-refreshes every 15 seconds)", "metrics");
  }

  showNotification(message, type = "success") {
    const notification = document.getElementById("notification");
    notification.textContent = message;
    notification.className = `notification ${type} show`;

    setTimeout(() => {
      notification.classList.remove("show");
    }, NOTIFICATION_TIMEOUT);
  }
}

// Initialize when DOM is loaded
document.addEventListener("DOMContentLoaded", () => {
  window.dataConnectorConfig = new DataConnectorConfig();
});

// Clean up metrics refresh interval when page is hidden or unloaded
document.addEventListener("visibilitychange", () => {
  if (!window.dataConnectorConfig) {
    return;
  }

  if (document.hidden) {
    // Stop refreshing when page is hidden
    if (window.dataConnectorConfig.metricsInterval) {
      clearInterval(window.dataConnectorConfig.metricsInterval);
      window.dataConnectorConfig.metricsInterval = null;
    }
  } else if (!window.dataConnectorConfig.metricsInterval) {
    // Load metrics immediately and restart refresh when page becomes visible
    window.dataConnectorConfig.loadMetrics();
    window.dataConnectorConfig.startMetricsRefresh();
  }
});

window.addEventListener("beforeunload", () => {
  if (window.dataConnectorConfig && window.dataConnectorConfig.metricsInterval) {
    clearInterval(window.dataConnectorConfig.metricsInterval);
    window.dataConnectorConfig.metricsInterval = null;
  }
});

// Export for global access
export default DataConnectorConfig;
