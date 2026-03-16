import "./styles.css";
import { apiFetch, getTokenHelpText, MANAGEMENT_TOKEN_ERROR_MESSAGE } from "./utils/apiFetch";

// Constants
const API_BASE_PATH = "/plugins/signalk-edge-link";
const DELTA_TIMER_MIN = 100;
const DELTA_TIMER_MAX = 10000;
const NOTIFICATION_TIMEOUT = 4000;
const METRICS_REFRESH_INTERVAL = 15000;
const JSON_SYNC_DEBOUNCE = 300;

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConnectionInfo {
  id: string;
  name?: string;
  type: string;
  healthy?: boolean;
  readyToSend?: boolean;
}

interface AuthenticatedError extends Error {
  isUnauthorized?: boolean;
}

// Escape HTML special characters to prevent XSS when inserting dynamic values into innerHTML
function escapeHtml(str: string | number): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// HTML Template Helpers
const renderCard = (
  title: string,
  subtitle: string | null,
  contentId: string,
  contentClass = ""
) => `
  <div class="config-section">
    <div class="card">
      <div class="card-header">
        <h2>${escapeHtml(title)}</h2>
        ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      <div class="card-content">
        <div id="${contentId}" class="${contentClass || contentId + "-info"}">
          <p>Loading ${escapeHtml(title.toLowerCase())}...</p>
        </div>
      </div>
    </div>
  </div>
`;

const renderStatItem = (label: string, value: string | number, hasError = false) => `
  <div class="stat-item${hasError ? " error" : ""}">
    <span class="stat-label">${escapeHtml(label)}:</span>
    <span class="stat-value">${escapeHtml(value)}</span>
  </div>
`;

const renderMetricItem = (label: string, value: string | number, statusClass = "") => `
  <div class="metric-item${statusClass ? " " + statusClass : ""}">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${escapeHtml(value)}</div>
  </div>
`;

// Variants that accept a pre-sanitized HTML string as the value (label is still escaped)
const renderMetricItemHtml = (label: string, htmlValue: string, statusClass = "") => `
  <div class="metric-item${statusClass ? " " + statusClass : ""}">
    <div class="metric-label">${escapeHtml(label)}</div>
    <div class="metric-value">${htmlValue}</div>
  </div>
`;

const renderStatItemHtml = (label: string, htmlValue: string, hasError = false) => `
  <div class="stat-item${hasError ? " error" : ""}">
    <span class="stat-label">${escapeHtml(label)}:</span>
    <span class="stat-value">${htmlValue}</span>
  </div>
`;

const renderBwStat = (
  label: string,
  value: string | number,
  isHighlight = false,
  isSuccess = false
) => `
  <div class="bw-stat${isHighlight ? " highlight" : ""}">
    <span class="bw-label">${escapeHtml(label)}:</span>
    <span class="bw-value${isSuccess ? " success-text" : ""}">${escapeHtml(value)}</span>
  </div>
`;

const renderSectionGroup = (
  title: string,
  description: string | null,
  content: string,
  id = ""
) => `
  <section class="page-group"${id ? ` id="${id}"` : ""}>
    <div class="page-group-header">
      <h2>${escapeHtml(title)}</h2>
      ${description ? `<p>${escapeHtml(description)}</p>` : ""}
    </div>
    <div class="page-group-content">
      ${content}
    </div>
  </section>
`;

class DataConnectorConfig {
  connections: ConnectionInfo[];
  activeConnectionId: string | null;
  pluginConfig: Record<string, unknown> | null;
  pluginSchema: Record<string, unknown> | null;
  schemaCurrentMode: string | null;
  metricsInterval: ReturnType<typeof setInterval> | null;
  syncTimeout: ReturnType<typeof setTimeout> | null;
  tokenHelpText: string;
  deltaTimerConfig: Record<string, unknown> | null;
  subscriptionConfig: Record<string, unknown> | null;
  sentenceFilterConfig: Record<string, unknown> | null;
  protocolVersion: number;
  isServerMode: boolean;
  _refreshInFlight: boolean;
  _notificationTimer: ReturnType<typeof setTimeout> | null;

  constructor() {
    this.connections = [];
    this.activeConnectionId = null;
    this.pluginConfig = null;
    this.pluginSchema = null;
    this.schemaCurrentMode = null;
    this.metricsInterval = null;
    this.syncTimeout = null;
    this.tokenHelpText = getTokenHelpText();

    // Per-connection state (loaded for the active tab)
    this.deltaTimerConfig = null;
    this.subscriptionConfig = null;
    this.sentenceFilterConfig = null;
    this.protocolVersion = 1;
    this.isServerMode = false;
    this._refreshInFlight = false;
    this._notificationTimer = null;

    this.init();
  }

  async init() {
    try {
      await this.loadPluginConfiguration(false);
      await this.fetchConnections();
      this.renderPage();
      this.startMetricsRefresh();
    } catch (error: unknown) {
      console.error("Initialization error:", error);
      this.showNotification(
        "Failed to initialize application: " +
          (error instanceof Error ? error.message : String(error)),
        "error"
      );
    }
  }

  // ── Connections list ───────────────────────────────────────────────────────

  async fetchConnections() {
    try {
      const res = await this.request(`${API_BASE_PATH}/connections`);
      if (res.ok) {
        this.connections = await res.json();
      }
    } catch (_e) {
      // /connections not available – fall back to legacy single-instance detection
    }

    if (!this.connections || this.connections.length === 0) {
      // Fallback: detect mode from plugin config and treat as single connection
      const type = this.detectModeFromConfig();
      this.connections = [{ id: "_legacy", name: "Default", type }];
    }

    if (!this.activeConnectionId) {
      this.activeConnectionId = this.connections[0].id;
    }
  }

  detectModeFromConfig(): string {
    if (this.pluginConfig) {
      const st = this.normalizeServerType(this.pluginConfig.serverType);
      if (st) {
        return st;
      }
    }
    if (this.schemaCurrentMode) {
      return this.schemaCurrentMode;
    }
    return "client";
  }

  getActiveConnection(): ConnectionInfo {
    return this.connections.find((c) => c.id === this.activeConnectionId) || this.connections[0];
  }

  isLegacyMode(): boolean {
    return this.connections.length === 1 && this.connections[0].id === "_legacy";
  }

  // ── API path helpers ───────────────────────────────────────────────────────

  metricsPath(connId: string): string {
    if (connId === "_legacy") {
      return `${API_BASE_PATH}/metrics`;
    }
    return `${API_BASE_PATH}/connections/${encodeURIComponent(connId)}/metrics`;
  }

  configPath(connId: string, filename: string): string {
    if (connId === "_legacy") {
      return `${API_BASE_PATH}/config/${filename}`;
    }
    return `${API_BASE_PATH}/connections/${encodeURIComponent(connId)}/config/${filename}`;
  }

  monitoringPath(connId: string, sub: string): string {
    if (connId === "_legacy") {
      return `${API_BASE_PATH}/monitoring/${sub}`;
    }
    return `${API_BASE_PATH}/connections/${encodeURIComponent(connId)}/monitoring/${sub}`;
  }

  congestionPath(connId: string): string {
    if (connId === "_legacy") {
      return `${API_BASE_PATH}/congestion`;
    }
    return `${API_BASE_PATH}/connections/${encodeURIComponent(connId)}/congestion`;
  }

  bondingPath(connId: string): string {
    if (connId === "_legacy") {
      return `${API_BASE_PATH}/bonding`;
    }
    return `${API_BASE_PATH}/connections/${encodeURIComponent(connId)}/bonding`;
  }

  bondingFailoverPath(connId: string): string {
    if (connId === "_legacy") {
      return `${API_BASE_PATH}/bonding/failover`;
    }
    return `${API_BASE_PATH}/connections/${encodeURIComponent(connId)}/bonding/failover`;
  }

  async request(input: RequestInfo, init: RequestInit = {}): Promise<Response> {
    const response = await apiFetch(input, init);
    if (response.status === 401) {
      const error: AuthenticatedError = new Error(MANAGEMENT_TOKEN_ERROR_MESSAGE);
      error.isUnauthorized = true;
      throw error;
    }
    return response;
  }

  authFailureMessage(context: string): string {
    return `${MANAGEMENT_TOKEN_ERROR_MESSAGE} Failed while ${context}. ${this.tokenHelpText}`;
  }

  // ── Page rendering ─────────────────────────────────────────────────────────

  renderPage() {
    this.renderTabs();
    this.renderConnectionContent();
  }

  renderTabs() {
    const tabsDiv = document.getElementById("connectionTabs");
    if (!tabsDiv) {
      return;
    }

    if (this.connections.length <= 1) {
      tabsDiv.innerHTML = "";
      tabsDiv.style.display = "none";
      return;
    }

    tabsDiv.style.display = "";
    tabsDiv.innerHTML = `<div class="tabs-container">${this.connections
      .map((c) => {
        const icon = c.type === "server" ? "&#x1F5A5;" : "&#x1F4F1;";
        const statusDot =
          c.healthy === false
            ? '<span class="tab-status-dot error"></span>'
            : c.readyToSend || c.type === "server"
              ? '<span class="tab-status-dot ok"></span>'
              : '<span class="tab-status-dot warning"></span>';
        return `<button class="connection-tab${c.id === this.activeConnectionId ? " active" : ""}"
                data-connection-id="${this.escapeHtml(c.id)}">
          ${statusDot}
          <span class="tab-icon">${icon}</span>
          <span class="tab-name">${this.escapeHtml(c.name || c.id)}</span>
          <span class="tab-type">${this.escapeHtml(c.type)}</span>
        </button>`;
      })
      .join("")}</div>`;

    // Attach tab click listeners
    tabsDiv.querySelectorAll(".connection-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = (btn as HTMLElement).dataset.connectionId;
        if (id !== this.activeConnectionId) {
          this.activeConnectionId = id!;
          this.renderPage();
          this.loadConnectionData();
        }
      });
    });
  }

  renderConnectionContent() {
    const contentDiv = document.getElementById("connectionContent");
    if (!contentDiv) {
      return;
    }

    const conn = this.getActiveConnection();
    this.isServerMode = conn.type === "server";

    if (this.isServerMode) {
      this.renderServerContent(contentDiv);
    } else {
      this.renderClientContent(contentDiv);
    }

    this.setupEventListeners();
    this.loadConnectionData();
  }

  renderServerContent(container: HTMLElement) {
    const telemetryAndHealth =
      renderCard(
        "Performance Metrics",
        "Real-time reception statistics (auto-refreshes every 15 seconds)",
        "metrics"
      ) +
      '<div id="monitoringSection" style="display:none;">' +
      renderCard(
        "Network Quality",
        "Link quality score and network health indicators",
        "networkQuality"
      ) +
      renderCard("Bandwidth Monitor", "Network reception statistics", "bandwidth") +
      renderCard("Path Analytics", "Incoming data volume by SignalK path", "pathAnalytics") +
      renderCard(
        "Monitoring & Alerts",
        "Packet loss, retransmission tracking, and alert thresholds",
        "monitoringAlerts"
      ) +
      "</div>";

    container.innerHTML =
      renderSectionGroup(
        "Operations & Monitoring",
        "Track reception quality, throughput, and runtime behavior.",
        telemetryAndHealth,
        "operationsGroup"
      ) +
      renderSectionGroup(
        "Advanced",
        "Full plugin configurator (JSON editor).",
        this.renderPluginConfigurationCard(),
        "advancedGroup"
      );
  }

  renderClientContent(container: HTMLElement) {
    const configuration =
      this.renderDeltaTimerCard() + this.renderSubscriptionCard() + this.renderSentenceFilterCard();

    const telemetryAndHealth =
      renderCard(
        "Performance Metrics",
        "Real-time transmission statistics (auto-refreshes every 15 seconds)",
        "metrics"
      ) +
      '<div id="congestionSection" class="config-section" style="display:none;">' +
      renderCard(
        "Network Quality",
        "Link quality score and network health indicators",
        "networkQuality"
      ) +
      renderCard("Bandwidth Monitor", "Real-time data transmission statistics", "bandwidth") +
      renderCard("Path Analytics", "Data volume by subscription path", "pathAnalytics") +
      renderCard(
        "Congestion Control",
        "AIMD congestion control state and delta timer auto-adjustment",
        "congestionControl"
      ) +
      "</div>" +
      '<div id="bondingSection" class="config-section" style="display:none;">' +
      renderCard(
        "Connection Bonding",
        "Multi-link bonding status and failover control",
        "bondingStatus"
      ) +
      "</div>" +
      '<div id="monitoringSection" style="display:none;">' +
      renderCard(
        "Monitoring & Alerts",
        "Packet loss, retransmission tracking, and alert thresholds",
        "monitoringAlerts"
      ) +
      "</div>" +
      renderCard("Status", null, "status", "status-info");

    container.innerHTML =
      renderSectionGroup(
        "Configuration",
        "Set up transmission behavior and plugin-level parameters.",
        configuration,
        "configurationGroup"
      ) +
      renderSectionGroup(
        "Operations & Monitoring",
        "Track transmission quality, reliability, and runtime performance.",
        telemetryAndHealth,
        "operationsGroup"
      ) +
      renderSectionGroup(
        "Advanced",
        "Full plugin configurator (JSON editor).",
        this.renderPluginConfigurationCard(),
        "advancedGroup"
      );
  }

  renderDeltaTimerCard(): string {
    return `
      <div class="config-section">
        <div class="card">
          <div class="card-header">
            <h2>Delta Timer Configuration</h2>
            <p>Controls how often deltas are collected and sent (in milliseconds)</p>
          </div>
          <div class="card-content">
            <div class="form-group">
              <label for="deltaTimer">Delta Timer (ms):</label>
              <input type="number" id="deltaTimer" min="100" max="10000" step="100" placeholder="1000" />
              <small class="help-text">
                Lower values = more frequent updates, higher bandwidth usage<br>
                Higher values = better compression ratio, lower bandwidth usage
              </small>
            </div>
            <button id="saveDeltaTimer" class="btn btn-primary">Save Delta Timer</button>
          </div>
        </div>
      </div>
    `;
  }

  renderSubscriptionCard(): string {
    return `
      <div class="config-section">
        <div class="card">
          <div class="card-header">
            <h2>Subscription Configuration</h2>
            <p>Define which SignalK data paths to subscribe to</p>
          </div>
          <div class="card-content">
            <div class="form-group">
              <label for="context">Context:</label>
              <input type="text" id="context" placeholder="*" />
              <small class="help-text">
                Context for the subscription (e.g., "vessels.self", "*" for all)
              </small>
            </div>
            <div class="subscription-paths">
              <h3>Subscription Paths</h3>
              <div id="pathsList" class="paths-list"></div>
              <button id="addPath" class="btn btn-secondary">Add Path</button>
            </div>
            <div class="json-editor">
              <h3>JSON Editor</h3>
              <textarea id="subscriptionJson" rows="10" placeholder='{"context": "*", "subscribe": [{"path": "*"}]}'></textarea>
              <small class="help-text">Advanced: Edit the raw JSON configuration</small>
            </div>
            <button id="saveSubscription" class="btn btn-primary">Save Subscription</button>
          </div>
        </div>
      </div>
    `;
  }

  renderSentenceFilterCard(): string {
    return `
      <div class="config-section">
        <div class="card">
          <div class="card-header">
            <h2>Sentence Filter</h2>
            <p>Exclude NMEA sentences from transmission (reduces bandwidth)</p>
          </div>
          <div class="card-content">
            <div class="form-group">
              <label for="sentenceFilter">Excluded Sentences:</label>
              <input type="text" id="sentenceFilter" placeholder="" autocomplete="off" />
              <small class="help-text">
                Comma-separated list of NMEA sentence types to exclude.
              </small>
            </div>
            <button id="saveSentenceFilter" class="btn btn-primary">Save Sentence Filter</button>
          </div>
        </div>
      </div>
    `;
  }

  renderPluginConfigurationCard(): string {
    return `
      <div class="config-section">
        <div class="card">
          <div class="card-header">
            <h2>Full Plugin Configuration</h2>
            <p>All parameters from <code>/plugin-config</code> (advanced JSON editor)</p>
          </div>
          <div class="card-content">
            <div id="pluginConfigSummary" class="plugin-config-summary">
              <p>Loading plugin configuration...</p>
            </div>
            <div class="json-editor plugin-config-editor">
              <h3>Plugin Config JSON</h3>
              <textarea
                id="pluginConfigJson"
                rows="20"
                placeholder='{"serverType":"client","udpPort":4446,"secretKey":"..."}'
              ></textarea>
              <small class="help-text">
                This editor exposes all available plugin fields. Save triggers plugin restart when supported.
              </small>
              <small class="help-text">${this.escapeHtml(this.tokenHelpText)}</small>
            </div>
            <div class="plugin-config-actions">
              <button id="savePluginConfig" class="btn btn-primary">Save Full Plugin Config</button>
              <button id="reloadPluginConfig" class="btn btn-secondary">Reload From Server</button>
              <button id="loadDefaultPluginConfig" class="btn btn-secondary">Load Schema Defaults</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async loadConnectionData() {
    const conn = this.getActiveConnection();
    const connId = conn.id;

    if (!this.isServerMode) {
      await this.loadConfigurations(connId);
      this.updateUI();
      this.updateStatus();
    } else {
      this.updatePluginConfigUI();
    }

    await this.loadMetrics(connId);
  }

  async loadPluginConfiguration(showErrors = true): Promise<boolean> {
    try {
      const [configResponse, schemaResponse] = await Promise.all([
        this.request(`${API_BASE_PATH}/plugin-config`),
        this.request(`${API_BASE_PATH}/plugin-schema`)
      ]);

      if (!configResponse.ok) {
        throw new Error(`Failed to load plugin configuration (${configResponse.status})`);
      }

      const configData = await configResponse.json();
      const configuration =
        configData &&
        configData.configuration &&
        typeof configData.configuration === "object" &&
        !Array.isArray(configData.configuration)
          ? configData.configuration
          : {};

      if (schemaResponse.ok) {
        const schemaData = await schemaResponse.json();
        if (schemaData && schemaData.schema && typeof schemaData.schema === "object") {
          this.pluginSchema = schemaData.schema;
        }
        if (
          schemaData &&
          (schemaData.currentMode === "server" || schemaData.currentMode === "client")
        ) {
          this.schemaCurrentMode = schemaData.currentMode;
        }
      }

      this.pluginConfig = this.buildCompletePluginConfig(configuration);
      return true;
    } catch (error: unknown) {
      if (showErrors) {
        const err = error as AuthenticatedError;
        this.showNotification(
          err.isUnauthorized
            ? this.authFailureMessage("loading plugin config")
            : "Error loading plugin config: " + err.message,
          "warning"
        );
      }
      return false;
    }
  }

  async loadConfigurations(connId: string) {
    try {
      const [deltaResponse, subResponse, filterResponse] = await Promise.all([
        this.request(this.configPath(connId, "delta_timer.json")),
        this.request(this.configPath(connId, "subscription.json")),
        this.request(this.configPath(connId, "sentence_filter.json"))
      ]);

      this.deltaTimerConfig = deltaResponse.ok ? await deltaResponse.json() : null;
      this.subscriptionConfig = subResponse.ok ? await subResponse.json() : null;
      this.sentenceFilterConfig = filterResponse.ok ? await filterResponse.json() : null;
    } catch (error: unknown) {
      const err = error as AuthenticatedError;
      this.showNotification(
        err.isUnauthorized
          ? this.authFailureMessage("loading connection configuration")
          : "Error loading configurations: " + err.message,
        "error"
      );
    }
  }

  async loadMetrics(connId?: string) {
    if (!connId) {
      connId = this.activeConnectionId!;
    }
    try {
      const response = await this.request(this.metricsPath(connId));
      if (response.ok) {
        const metrics = await response.json();
        this.protocolVersion = metrics.protocolVersion || 1;
        this.updateMetricsDisplay(metrics);

        if (this.protocolVersion >= 2) {
          this.loadV2Data(connId);
        }
      }
    } catch (error: unknown) {
      console.error("Error loading metrics:", (error as Error).message);
    }
  }

  async loadV2Data(connId: string) {
    const isClient = !this.isServerMode;

    const fetches: Promise<Response | null>[] = [
      this.request(this.monitoringPath(connId, "alerts")).catch(() => null),
      this.request(this.monitoringPath(connId, "packet-loss")).catch(() => null),
      this.request(this.monitoringPath(connId, "retransmissions")).catch(() => null)
    ];

    if (isClient) {
      fetches.push(
        this.request(this.congestionPath(connId)).catch(() => null),
        this.request(this.bondingPath(connId)).catch(() => null)
      );
    }

    const results = await Promise.all(fetches);
    const [alertsRes, packetLossRes, retransmissionsRes, congestionRes, bondingRes] = results;

    const monitoringData: Record<string, unknown> = {};
    if (alertsRes && alertsRes.ok) {
      monitoringData.alerts = await alertsRes.json();
    }
    if (packetLossRes && packetLossRes.ok) {
      monitoringData.packetLoss = await packetLossRes.json();
    }
    if (retransmissionsRes && retransmissionsRes.ok) {
      monitoringData.retransmissions = await retransmissionsRes.json();
    }
    this.updateMonitoringDisplay(monitoringData);

    if (isClient && congestionRes && congestionRes.ok) {
      const congestionData = await congestionRes.json();
      this.updateCongestionDisplay(congestionData);
    }

    if (isClient && bondingRes && bondingRes.ok) {
      const bondingData = await bondingRes.json();
      this.updateBondingDisplay(bondingData);
    }
  }

  startMetricsRefresh() {
    if (this.metricsInterval) {
      clearInterval(this.metricsInterval);
    }

    this.metricsInterval = setInterval(() => {
      if (this._refreshInFlight) {
        return;
      }
      this._refreshInFlight = true;
      this.refreshActiveTab().finally(() => {
        this._refreshInFlight = false;
      });
    }, METRICS_REFRESH_INTERVAL);
  }

  async refreshActiveTab() {
    // Refresh the connections list to update tab badges
    try {
      const res = await this.request(`${API_BASE_PATH}/connections`);
      if (res.ok) {
        const updated = await res.json();
        if (updated.length > 0) {
          this.connections = updated;
          this.renderTabs();
        }
      }
    } catch (_e) {
      /* ignore */
    }

    await this.loadMetrics(this.activeConnectionId!);
  }

  // ── Event listeners ────────────────────────────────────────────────────────

  setupEventListeners() {
    const saveDeltaTimerBtn = document.getElementById("saveDeltaTimer");
    if (saveDeltaTimerBtn) {
      saveDeltaTimerBtn.addEventListener("click", () => this.saveDeltaTimer());
    }

    const saveSubscriptionBtn = document.getElementById("saveSubscription");
    if (saveSubscriptionBtn) {
      saveSubscriptionBtn.addEventListener("click", () => this.saveSubscription());
    }

    const saveSentenceFilterBtn = document.getElementById("saveSentenceFilter");
    if (saveSentenceFilterBtn) {
      saveSentenceFilterBtn.addEventListener("click", () => this.saveSentenceFilter());
    }

    const addPathBtn = document.getElementById("addPath");
    if (addPathBtn) {
      addPathBtn.addEventListener("click", () => this.addPathItem());
    }

    const subscriptionJsonEditor = document.getElementById("subscriptionJson");
    if (subscriptionJsonEditor) {
      subscriptionJsonEditor.addEventListener("input", () => {
        if (this.syncTimeout) {
          clearTimeout(this.syncTimeout);
        }
        this.syncTimeout = setTimeout(() => this.syncFromJson(), JSON_SYNC_DEBOUNCE);
      });
    }

    const contextInput = document.getElementById("context");
    if (contextInput) {
      contextInput.addEventListener("input", () => this.updateJsonFromForm());
    }

    const savePluginConfigBtn = document.getElementById("savePluginConfig");
    if (savePluginConfigBtn) {
      savePluginConfigBtn.addEventListener("click", () => this.savePluginConfig());
    }

    const reloadPluginConfigBtn = document.getElementById("reloadPluginConfig");
    if (reloadPluginConfigBtn) {
      reloadPluginConfigBtn.addEventListener("click", () => this.reloadPluginConfiguration());
    }

    const loadDefaultPluginConfigBtn = document.getElementById("loadDefaultPluginConfig");
    if (loadDefaultPluginConfigBtn) {
      loadDefaultPluginConfigBtn.addEventListener("click", () =>
        this.loadDefaultPluginConfiguration()
      );
    }
  }

  // ── UI updates ─────────────────────────────────────────────────────────────

  updateUI() {
    this.updatePluginConfigUI();

    if (this.deltaTimerConfig && (this.deltaTimerConfig as Record<string, unknown>).deltaTimer) {
      const el = document.getElementById("deltaTimer") as HTMLInputElement | null;
      if (el) {
        el.value = String((this.deltaTimerConfig as Record<string, unknown>).deltaTimer);
      }
    }

    if (this.subscriptionConfig) {
      const cfg = this.subscriptionConfig as Record<string, unknown>;
      const ctxEl = document.getElementById("context") as HTMLInputElement | null;
      if (ctxEl) {
        ctxEl.value = (cfg.context as string) || "*";
      }

      const pathsList = document.getElementById("pathsList");
      if (pathsList) {
        pathsList.innerHTML = "";
        if (cfg.subscribe && Array.isArray(cfg.subscribe)) {
          (cfg.subscribe as Array<{ path: string }>).forEach((sub) => this.addPathItem(sub.path));
        }
      }

      const jsonEl = document.getElementById("subscriptionJson") as HTMLTextAreaElement | null;
      if (jsonEl) {
        jsonEl.value = JSON.stringify(this.subscriptionConfig, null, 2);
      }
    }

    if (
      this.sentenceFilterConfig &&
      Array.isArray((this.sentenceFilterConfig as Record<string, unknown>).excludedSentences)
    ) {
      const el = document.getElementById("sentenceFilter") as HTMLInputElement | null;
      if (el) {
        el.value = (
          (this.sentenceFilterConfig as Record<string, unknown>).excludedSentences as string[]
        ).join(", ");
      }
    }
  }

  updatePluginConfigUI() {
    const editor = document.getElementById("pluginConfigJson") as HTMLTextAreaElement | null;
    const summary = document.getElementById("pluginConfigSummary");

    if (!editor) {
      return;
    }

    if (!this.pluginConfig) {
      editor.value = "{}";
      if (summary) {
        summary.innerHTML = "<p>Plugin config unavailable.</p>";
      }
      return;
    }

    editor.value = JSON.stringify(this.pluginConfig, null, 2);

    if (summary) {
      const hasConnections =
        Array.isArray(this.pluginConfig.connections) &&
        (this.pluginConfig.connections as unknown[]).length > 0;

      let summaryScope = "Top-level";
      let keyLabel = "Top-Level Fields";
      let summaryConfig: Record<string, unknown> = this.pluginConfig;

      if (hasConnections) {
        const totalConnections = (this.pluginConfig.connections as unknown[]).length;
        const runtimeIndex = this.connections.findIndex((c) => c.id === this.activeConnectionId);
        const summaryIndex =
          runtimeIndex >= 0 && runtimeIndex < totalConnections ? runtimeIndex : 0;
        const candidate = (this.pluginConfig.connections as Record<string, unknown>[])[
          summaryIndex
        ];
        summaryConfig =
          candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate : {};
        summaryScope = `Connection ${summaryIndex + 1}/${totalConnections}`;
        keyLabel = "Connection Fields";
      }

      const mode = this.normalizeServerType(summaryConfig.serverType) || "client";
      const protocol =
        Number(summaryConfig.protocolVersion) >= 2 ? Number(summaryConfig.protocolVersion) : 1;
      const keyCount = Object.keys(summaryConfig).length;
      summary.innerHTML = `
        <div class="plugin-summary-grid">
          ${renderStatItem("Scope", summaryScope)}
          ${renderStatItem("Mode", mode.toUpperCase())}
          ${renderStatItem("Protocol", "v" + String(protocol))}
          ${renderStatItem(keyLabel, String(keyCount))}
        </div>
      `;
    }
  }

  // ── Form helpers (subscription paths) ──────────────────────────────────────

  addPathItem(path = "") {
    const pathsList = document.getElementById("pathsList");
    if (!pathsList) {
      return;
    }

    const pathItem = document.createElement("div");
    pathItem.className = "path-item";

    const input = document.createElement("input");
    input.type = "text";
    input.value = path;
    input.placeholder = "navigation.position";
    input.className = "path-input";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-danger";
    button.textContent = "Remove";

    input.addEventListener("input", () => this.updateJsonFromForm());
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
    const contextEl = document.getElementById("context") as HTMLInputElement | null;
    const context = contextEl ? contextEl.value || "*" : "*";
    const pathInputs = document.querySelectorAll(".path-input") as NodeListOf<HTMLInputElement>;
    const subscribe = Array.from(pathInputs)
      .map((input) => ({ path: input.value }))
      .filter((sub) => sub.path.trim() !== "");

    const config = { context, subscribe };
    const jsonEl = document.getElementById("subscriptionJson") as HTMLTextAreaElement | null;
    if (jsonEl) {
      jsonEl.value = JSON.stringify(config, null, 2);
    }
  }

  syncFromJson() {
    try {
      const jsonEl = document.getElementById("subscriptionJson") as HTMLTextAreaElement | null;
      if (!jsonEl) {
        return;
      }
      const config = JSON.parse(jsonEl.value);

      const ctxEl = document.getElementById("context") as HTMLInputElement | null;
      if (ctxEl) {
        ctxEl.value = config.context || "*";
      }

      const pathsList = document.getElementById("pathsList");
      if (pathsList) {
        pathsList.innerHTML = "";
        if (config.subscribe && Array.isArray(config.subscribe)) {
          config.subscribe.forEach((sub: { path?: string }) => this.addPathItem(sub.path || ""));
        }
      }
    } catch (error: unknown) {
      console.warn("Invalid JSON in editor:", (error as Error).message);
    }
  }

  // ── Save operations ────────────────────────────────────────────────────────

  async saveConfig(filename: string, config: unknown, configKey: string, label: string) {
    const connId = this.activeConnectionId!;
    try {
      const response = await this.request(this.configPath(connId, filename), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config)
      });

      if (response.ok) {
        (this as Record<string, unknown>)[configKey] = config;
        this.showNotification(`${label} saved successfully!`, "success");
        this.updateStatus();
      } else {
        throw new Error("Failed to save configuration");
      }
    } catch (error: unknown) {
      const err = error as AuthenticatedError;
      this.showNotification(
        err.isUnauthorized
          ? this.authFailureMessage(`saving ${label.toLowerCase()}`)
          : `Error saving ${label.toLowerCase()}: ` + err.message,
        "error"
      );
    }
  }

  async saveDeltaTimer() {
    const deltaTimer = parseInt((document.getElementById("deltaTimer") as HTMLInputElement).value);

    if (isNaN(deltaTimer) || deltaTimer < DELTA_TIMER_MIN || deltaTimer > DELTA_TIMER_MAX) {
      this.showNotification(
        `Delta timer must be between ${DELTA_TIMER_MIN} and ${DELTA_TIMER_MAX} milliseconds`,
        "error"
      );
      return;
    }

    await this.saveConfig(
      "delta_timer.json",
      { deltaTimer },
      "deltaTimerConfig",
      "Delta timer configuration"
    );
  }

  async saveSubscription() {
    try {
      const jsonText = (document.getElementById("subscriptionJson") as HTMLTextAreaElement).value;
      const config = JSON.parse(jsonText);

      if (!config.context) {
        throw new Error("Context is required");
      }
      if (!config.subscribe || !Array.isArray(config.subscribe)) {
        throw new Error("Subscribe array is required");
      }

      await this.saveConfig(
        "subscription.json",
        config,
        "subscriptionConfig",
        "Subscription configuration"
      );
    } catch (error: unknown) {
      this.showNotification("Error saving subscription: " + (error as Error).message, "error");
    }
  }

  async saveSentenceFilter() {
    const filterInput = (document.getElementById("sentenceFilter") as HTMLInputElement).value;
    const excludedSentences = filterInput
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);

    await this.saveConfig(
      "sentence_filter.json",
      { excludedSentences },
      "sentenceFilterConfig",
      "Sentence filter"
    );
  }

  async savePluginConfig() {
    const editor = document.getElementById("pluginConfigJson") as HTMLTextAreaElement | null;
    if (!editor) {
      return;
    }

    try {
      const parsedConfig = JSON.parse(editor.value);
      if (!parsedConfig || typeof parsedConfig !== "object" || Array.isArray(parsedConfig)) {
        throw new Error("Plugin configuration must be a JSON object");
      }

      const requestConfig = this.deepClone(parsedConfig) as Record<string, unknown>;
      const normalizedServerType = this.normalizeServerType(requestConfig.serverType);
      if (normalizedServerType) {
        requestConfig.serverType = normalizedServerType;
      }

      const response = await this.request(`${API_BASE_PATH}/plugin-config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestConfig)
      });

      const result = await response.json().catch(() => ({}) as Record<string, unknown>);
      if (!response.ok || !result.success) {
        throw new Error(result.error || `Failed to save plugin configuration (${response.status})`);
      }

      this.pluginConfig = this.buildCompletePluginConfig(requestConfig);
      this.updatePluginConfigUI();
      this.showNotification(
        result.message || "Plugin configuration saved. Refresh to apply changes.",
        "success"
      );
    } catch (error: unknown) {
      const err = error as AuthenticatedError;
      this.showNotification(
        err.isUnauthorized
          ? this.authFailureMessage("saving full plugin config")
          : "Error saving full plugin config: " + err.message,
        "error"
      );
    }
  }

  async reloadPluginConfiguration() {
    const loaded = await this.loadPluginConfiguration(true);
    if (loaded) {
      this.updatePluginConfigUI();
      this.showNotification("Plugin configuration reloaded.", "success");
    }
  }

  loadDefaultPluginConfiguration() {
    this.pluginConfig = this.buildCompletePluginConfig({});
    this.updatePluginConfigUI();
    this.showNotification("Loaded schema defaults into editor. Save to apply.", "warning");
  }

  // ── Metrics display ────────────────────────────────────────────────────────

  updateMetricsDisplay(metrics: Record<string, any>) {
    this.updateNetworkQualityDisplay(metrics);
    this.updateBandwidthDisplay(metrics);
    this.updatePathAnalyticsDisplay(metrics);

    const metricsDiv = document.getElementById("metrics");
    if (!metricsDiv) {
      return;
    }

    const isClient = metrics.mode === "client";
    const { stats, status, uptime } = metrics;

    const cryptoErrors = (stats.errorCounts && stats.errorCounts.crypto) || 0;
    const malformedPackets = stats.malformedPackets || 0;

    const hasErrors =
      stats.udpSendErrors > 0 ||
      stats.compressionErrors > 0 ||
      stats.encryptionErrors > 0 ||
      stats.subscriptionErrors > 0 ||
      cryptoErrors > 0 ||
      malformedPackets > 0;

    const protocolVersion = metrics.protocolVersion || 1;
    const protocolLabel = protocolVersion >= 2 ? `v${protocolVersion}` : "v1";

    const metricsGridItems = [
      renderMetricItem("Uptime", uptime.formatted),
      renderMetricItem("Mode", isClient ? "Client" : "Server"),
      renderMetricItemHtml(
        "Protocol",
        `<span class="protocol-badge protocol-${escapeHtml(protocolLabel)}">${escapeHtml(protocolLabel.toUpperCase())}</span>`
      ),
      renderMetricItem(
        "Status",
        status.readyToSend ? "Ready" : "Not Ready",
        status.readyToSend ? "success" : "error"
      ),
      isClient ? renderMetricItem("Buffered Deltas", status.deltasBuffered) : ""
    ].join("");

    const subErrors = stats.subscriptionErrors;
    const subscriptionErrorStat = isClient
      ? renderStatItem("Subscription Errors", subErrors, subErrors > 0)
      : "";

    const statsItems = [
      isClient
        ? renderStatItem("Deltas Sent", stats.deltasSent.toLocaleString())
        : renderStatItem("Deltas Received", stats.deltasReceived.toLocaleString()),
      isClient
        ? renderStatItem("UDP Send Errors", stats.udpSendErrors, stats.udpSendErrors > 0)
        : "",
      isClient ? renderStatItem("UDP Retries", stats.udpRetries) : "",
      renderStatItem("Compression Errors", stats.compressionErrors, stats.compressionErrors > 0),
      renderStatItem("Encryption Errors", stats.encryptionErrors, stats.encryptionErrors > 0),
      subscriptionErrorStat,
      !isClient && stats.duplicatePackets > 0
        ? renderStatItem("Duplicate Packets", stats.duplicatePackets.toLocaleString())
        : "",
      protocolVersion >= 3
        ? renderStatItem("Auth Failures (V3)", cryptoErrors, cryptoErrors > 0)
        : "",
      renderStatItem("Malformed Packets", malformedPackets, malformedPackets > 0)
    ].join("");

    let metricsHtml = `
      <h4>Performance Metrics</h4>
      <div class="metrics-grid">${metricsGridItems}</div>
      <div class="metrics-stats">
        <h5>Transmission Statistics</h5>
        <div class="stats-grid">${statsItems}</div>
      </div>
    `;

    if (isClient && metrics.smartBatching) {
      const sb = metrics.smartBatching;
      const totalSends = sb.earlySends + sb.timerSends;
      const earlyPercent = totalSends > 0 ? Math.round((sb.earlySends / totalSends) * 100) : 0;

      metricsHtml += `
        <div class="metrics-stats">
          <h5>Smart Batching</h5>
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

    if (Array.isArray(metrics.recentErrors) && metrics.recentErrors.length > 0) {
      const errorItems = [...metrics.recentErrors]
        .reverse()
        .map((err) => {
          const timeAgo = Date.now() - err.timestamp;
          const timeStr =
            timeAgo < 60000
              ? `${Math.floor(timeAgo / 1000)}s ago`
              : `${Math.floor(timeAgo / 60000)}m ago`;
          return `
            <div class="recent-error-item">
              <span class="error-category-badge">${this.escapeHtml(err.category)}</span>
              <span class="recent-error-msg">${this.escapeHtml(err.message)}</span>
              <span class="recent-error-time">${this.escapeHtml(timeStr)}</span>
            </div>
          `;
        })
        .join("");
      metricsHtml += `
        <div class="metrics-error">
          <h5>Recent Errors (${metrics.recentErrors.length})</h5>
          <div class="recent-errors-list">${errorItems}</div>
        </div>
      `;
    } else if (metrics.lastError) {
      const timeAgo = metrics.lastError.timeAgo;
      const timeAgoStr =
        timeAgo < 60000
          ? `${Math.floor(timeAgo / 1000)}s ago`
          : `${Math.floor(timeAgo / 60000)}m ago`;

      metricsHtml += `
        <div class="metrics-error">
          <h5>Last Error</h5>
          <div class="error-message">${this.escapeHtml(metrics.lastError.message)}</div>
          <div class="error-time">Occurred ${timeAgoStr}</div>
        </div>
      `;
    } else if (!hasErrors) {
      metricsHtml += `
        <div class="metrics-success">
          <div class="success-message">No errors detected</div>
        </div>
      `;
    }

    metricsDiv.innerHTML = metricsHtml;
  }

  updateNetworkQualityDisplay(metrics: Record<string, any>) {
    const nqDiv = document.getElementById("networkQuality");
    if (!nqDiv || !metrics.networkQuality) {
      return;
    }

    const nq = metrics.networkQuality;
    const isClient = metrics.mode === "client";

    let qualityLabel = "N/A";
    let qualityColor = "#9E9E9E";
    if (nq.linkQuality !== undefined) {
      if (nq.linkQuality >= 90) {
        qualityLabel = "Excellent";
        qualityColor = "#4CAF50";
      } else if (nq.linkQuality >= 70) {
        qualityLabel = "Good";
        qualityColor = "#FFC107";
      } else if (nq.linkQuality >= 50) {
        qualityLabel = "Fair";
        qualityColor = "#FF9800";
      } else {
        qualityLabel = "Poor";
        qualityColor = "#F44336";
      }
    }

    const qualityPct = nq.linkQuality !== undefined ? nq.linkQuality : 0;
    const gaugeAngle = (qualityPct / 100) * 180;
    const radStart = Math.PI;
    const radEnd = radStart + (gaugeAngle * Math.PI) / 180;
    const cx = 50,
      cy = 50,
      r = 40;
    const x1 = cx + r * Math.cos(radStart);
    const y1 = cy + r * Math.sin(radStart);
    const x2 = cx + r * Math.cos(radEnd);
    const y2 = cy + r * Math.sin(radEnd);
    const largeArc = gaugeAngle > 180 ? 1 : 0;

    const gaugeArcPath =
      qualityPct > 0
        ? `<path d="M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} 1 ${x2} ${y2}"
              fill="none" stroke="${qualityColor}" stroke-width="8" stroke-linecap="round"/>`
        : "";

    const gaugeSvg = `
      <svg viewBox="0 0 100 55" class="quality-gauge" preserveAspectRatio="xMidYMid meet">
        <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}"
              fill="none" stroke="#E0E0E0" stroke-width="8" stroke-linecap="round"/>
        ${gaugeArcPath}
        <text x="${cx}" y="${cy - 5}" text-anchor="middle" font-size="16" font-weight="bold" fill="${qualityColor}">
          ${qualityPct}
        </text>
        <text x="${cx}" y="${cy + 8}" text-anchor="middle" font-size="7" fill="#666">
          ${qualityLabel}
        </text>
      </svg>
    `;

    const rttDisplay = nq.rtt !== undefined ? nq.rtt + " ms" : "N/A";
    const jitterDisplay = nq.jitter !== undefined ? nq.jitter + " ms" : "N/A";

    let nqHtml = `
      <div class="network-quality-dashboard">
        <div class="nq-hero">
          <div class="nq-gauge-container">
            ${gaugeSvg}
            <div class="nq-gauge-label">Link Quality</div>
          </div>
          <div class="nq-key-metrics">
            ${renderMetricItem("RTT", rttDisplay, nq.rtt > 500 ? "error" : nq.rtt > 200 ? "warning" : "")}
            ${renderMetricItem("Jitter", jitterDisplay, nq.jitter > 100 ? "error" : nq.jitter > 50 ? "warning" : "")}
          </div>
        </div>

        <div class="nq-details">
          <h5>Reliability Statistics</h5>
          <div class="stats-grid">
    `;

    if (isClient) {
      nqHtml += `
            ${renderStatItem("Retransmissions", (nq.retransmissions || 0).toLocaleString(), nq.retransmissions > 0)}
            ${renderStatItem("Queue Depth", (nq.queueDepth || 0).toLocaleString(), nq.queueDepth > 100)}
      `;
    } else {
      nqHtml += `
            ${renderStatItem("ACKs Sent", (nq.acksSent || 0).toLocaleString())}
            ${renderStatItem("NAKs Sent", (nq.naksSent || 0).toLocaleString(), nq.naksSent > 0)}
      `;
    }

    nqHtml += `
          </div>
        </div>
      </div>
    `;

    nqDiv.innerHTML = nqHtml;
  }

  updateBandwidthDisplay(metrics: Record<string, any>) {
    const bandwidthDiv = document.getElementById("bandwidth");
    if (!bandwidthDiv || !metrics.bandwidth) {
      return;
    }

    const bw = metrics.bandwidth;
    const isClient = metrics.mode === "client";

    const savedBytes = isClient ? bw.bytesOutRaw - bw.bytesOut : bw.bytesInRaw - bw.bytesIn;
    const savedFormatted = this.formatBytes(savedBytes > 0 ? savedBytes : 0);

    let bandwidthStats: string[];
    if (isClient) {
      bandwidthStats = [
        renderBwStat("Total Sent (Compressed)", bw.bytesOutFormatted),
        renderBwStat("Total Raw (Before Compression)", bw.bytesOutRawFormatted),
        renderBwStat("Bandwidth Saved", savedFormatted, true, true),
        renderBwStat("Packets Sent", bw.packetsOut.toLocaleString())
      ];
    } else {
      bandwidthStats = [
        renderBwStat("Total Received (Compressed)", bw.bytesInFormatted),
        renderBwStat("Total Raw (After Decompression)", this.formatBytes(bw.bytesInRaw || 0)),
        renderBwStat("Bandwidth Saved", savedFormatted, true, true),
        renderBwStat("Packets Received", bw.packetsIn.toLocaleString())
      ];
    }

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
          <h5>Bandwidth Details</h5>
          <div class="bandwidth-grid">${bandwidthStats.join("")}</div>
        </div>

        ${this.renderBandwidthChart(bw.history, isClient)}
      </div>
    `;

    bandwidthDiv.innerHTML = bandwidthHtml;
  }

  renderBandwidthChart(
    history: Array<{ rateOut: number; rateIn: number }> | undefined,
    isClient: boolean
  ): string {
    if (!history || history.length < 2) {
      return `
        <div class="bandwidth-chart-placeholder">
          <p>Collecting data for chart... (${history ? history.length : 0}/2 points)</p>
        </div>
      `;
    }

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
        <h5>Rate History (Last ${history.length * intervalSeconds}s)</h5>
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

  updatePathAnalyticsDisplay(metrics: Record<string, any>) {
    const pathDiv = document.getElementById("pathAnalytics");
    if (!pathDiv || !metrics.pathStats) {
      return;
    }

    const paths: Array<{
      path: string;
      updatesPerMinute: number;
      bytesFormatted: string;
      percentage: number;
    }> = metrics.pathStats;

    if (paths.length === 0) {
      pathDiv.innerHTML = `
        <div class="path-analytics-empty">
          <p>No path data collected yet. Data will appear once deltas are transmitted.</p>
        </div>
      `;
      return;
    }

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

    paths.slice(0, 15).forEach((p) => {
      const barWidth = Math.max(p.percentage, 2);
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

  updateCongestionDisplay(data: Record<string, any>) {
    const section = document.getElementById("congestionSection");
    const div = document.getElementById("congestionControl");
    if (!section || !div) {
      return;
    }

    section.style.display = "";

    const enabled = !!data.enabled;
    const manualMode = !!data.manualMode;
    const stateLabel = enabled ? (manualMode ? "manual" : "active") : "disabled";
    const stateClass = enabled ? (manualMode ? "warning" : "success") : "error";
    const modeLabel = manualMode ? "Manual Override" : "Automatic";
    const currentDeltaTimer = data.currentDeltaTimer || 0;
    const nominalDeltaTimer = data.nominalDeltaTimer || 0;

    const html = `
      <div class="v2-dashboard">
        <div class="metrics-grid">
          ${renderMetricItemHtml("State", `<span class="congestion-state ${stateClass}">${stateLabel}</span>`)}
          ${renderMetricItem("Mode", modeLabel)}
          ${renderMetricItem("Current Timer", currentDeltaTimer + " ms")}
          ${renderMetricItem("Nominal Timer", nominalDeltaTimer + " ms")}
        </div>
        <div class="metrics-stats">
          <h5>Congestion Details</h5>
          <div class="stats-grid">
            ${renderStatItem("Min Delta Timer", (data.minDeltaTimer || 0) + " ms")}
            ${renderStatItem("Max Delta Timer", (data.maxDeltaTimer || 0) + " ms")}
            ${renderStatItem("Target RTT", (data.targetRTT || 0) + " ms")}
            ${renderStatItem("Avg RTT", (data.avgRTT !== undefined ? Math.round(data.avgRTT) : 0) + " ms")}
            ${renderStatItem("Avg Packet Loss", (data.avgLoss !== undefined ? (data.avgLoss * 100).toFixed(1) : 0) + "%", data.avgLoss > 0.05)}
          </div>
        </div>
      </div>
    `;

    div.innerHTML = html;
  }

  updateBondingDisplay(data: Record<string, any>) {
    const section = document.getElementById("bondingSection");
    const div = document.getElementById("bondingStatus");
    if (!section || !div) {
      return;
    }

    if (!data.enabled) {
      section.style.display = "none";
      return;
    }

    section.style.display = "";

    const modeLabel = (data.mode || "main-backup").replace(/-/g, " ");
    const activeLink = data.activeLink || "primary";

    let linksHtml = "";
    if (data.links) {
      const linkEntries = Object.entries(data.links) as Array<[string, Record<string, any>]>;
      linksHtml = linkEntries
        .map(([name, link]) => {
          const isActive = name === activeLink;
          const status = (link.status || "unknown").toLowerCase();
          const isUp = status !== "down";
          const aliveClass = isUp ? "success" : "error";
          return `
          <div class="bonding-link ${isActive ? "active" : ""}">
            <div class="link-header">
              <span class="link-name">${this.escapeHtml(name)}</span>
              ${isActive ? '<span class="link-badge active-badge">ACTIVE</span>' : ""}
              <span class="link-badge ${aliveClass}">${this.escapeHtml(status.toUpperCase())}</span>
            </div>
            <div class="link-stats">
              ${renderStatItem("RTT", (link.rtt || 0) + " ms")}
              ${renderStatItem("Packet Loss", ((link.loss || 0) * 100).toFixed(1) + "%")}
            </div>
          </div>
        `;
        })
        .join("");
    }

    const html = `
      <div class="v2-dashboard">
        <div class="metrics-grid">
          ${renderMetricItem("Mode", modeLabel)}
          ${renderMetricItem("Active Link", activeLink)}
        </div>
        <div class="bonding-links">${linksHtml}</div>
        <div style="margin-top: 1rem;">
          <button id="failoverBtn" class="btn btn-secondary">Force Failover</button>
        </div>
      </div>
    `;

    div.innerHTML = html;

    const failoverBtn = document.getElementById("failoverBtn");
    if (failoverBtn) {
      failoverBtn.addEventListener("click", () => this.triggerFailover());
    }
  }

  async triggerFailover() {
    const connId = this.activeConnectionId!;
    const btn = document.getElementById("failoverBtn") as HTMLButtonElement | null;
    if (btn) {
      btn.disabled = true;
    }
    try {
      const response = await this.request(this.bondingFailoverPath(connId), { method: "POST" });
      if (response.ok) {
        const result = await response.json();
        this.showNotification(`Failover complete. Active link: ${result.activeLink}`, "success");
        this.loadMetrics(connId);
      } else {
        const err = await response.json();
        this.showNotification(
          response.status === 401
            ? this.authFailureMessage("triggering failover")
            : "Failover failed: " + (err.error || "Unknown error"),
          "error"
        );
      }
    } catch (error: unknown) {
      const err = error as AuthenticatedError;
      this.showNotification(
        err.isUnauthorized
          ? this.authFailureMessage("triggering failover")
          : "Failover failed: " + err.message,
        "error"
      );
    } finally {
      if (btn) {
        btn.disabled = false;
      }
    }
  }

  updateMonitoringDisplay(data: Record<string, any>) {
    const section = document.getElementById("monitoringSection");
    const div = document.getElementById("monitoringAlerts");
    if (!section || !div) {
      return;
    }

    const hasData = data.alerts || data.packetLoss || data.retransmissions;
    if (!hasData) {
      section.style.display = "none";
      return;
    }

    section.style.display = "";

    let html = '<div class="v2-dashboard">';

    if (data.alerts) {
      const activeAlerts: Record<string, any> = data.alerts.activeAlerts || {};
      const alertEntries = Object.entries(activeAlerts).map(([metric, alert]: [string, any]) => {
        let level = "warning";
        if (typeof alert === "string") {
          level = alert.toLowerCase();
        } else if (alert && typeof alert === "object" && alert.level) {
          level = String(alert.level).toLowerCase();
        }

        if (level === "warn") {
          level = "warning";
        }
        if (level === "alert") {
          level = "critical";
        }
        if (level !== "warning" && level !== "critical") {
          level = "warning";
        }

        return {
          metric,
          level,
          value: alert && typeof alert === "object" ? alert.value : undefined
        };
      });
      const alertCount = alertEntries.length;

      const alertItems = alertEntries
        .map((entry) => {
          const alertValue =
            entry.value !== undefined ? ` (${this.escapeHtml(String(entry.value))})` : "";
          return renderStatItemHtml(
            entry.metric,
            `<span class="alert-level alert-${entry.level}">${this.escapeHtml(entry.level.toUpperCase())}${alertValue}</span>`,
            entry.level === "critical"
          );
        })
        .join("");

      const alertsContent =
        alertCount === 0
          ? '<div class="metrics-success"><div class="success-message">No active alerts</div></div>'
          : `<div class="stats-grid">${alertItems}</div>`;

      html += `
        <div class="monitoring-subsection">
          <h5>Active Alerts</h5>
          ${alertsContent}
        </div>
      `;
    }

    if (data.packetLoss && data.packetLoss.summary) {
      const summary = data.packetLoss.summary;
      html += `
        <div class="monitoring-subsection">
          <h5>Packet Loss</h5>
          <div class="stats-grid">
            ${renderStatItem("Overall Loss Rate", (summary.overallLossRate * 100).toFixed(2) + "%", summary.overallLossRate > 0.05)}
            ${renderStatItem("Max Loss Rate", (summary.maxLossRate * 100).toFixed(2) + "%", summary.maxLossRate > 0.1)}
            ${renderStatItem("Trend", summary.trend || "stable")}
          </div>
        </div>
      `;
    }

    if (data.retransmissions && data.retransmissions.summary) {
      const summary = data.retransmissions.summary;
      html += `
        <div class="monitoring-subsection">
          <h5>Retransmission Rates</h5>
          <div class="stats-grid">
            ${renderStatItem("Current Rate", (summary.currentRate * 100).toFixed(2) + "%", summary.currentRate > 0.05)}
            ${renderStatItem("Average Rate", (summary.avgRate * 100).toFixed(2) + "%")}
            ${renderStatItem("Max Rate", (summary.maxRate * 100).toFixed(2) + "%", summary.maxRate > 0.1)}
          </div>
        </div>
      `;
    }

    html += "</div>";
    div.innerHTML = html;
  }

  // ── Status display ─────────────────────────────────────────────────────────

  updateStatus() {
    const statusDiv = document.getElementById("status");
    if (!statusDiv) {
      return;
    }

    let statusHtml = "<h4>Configuration Status</h4>";

    if (this.deltaTimerConfig) {
      statusHtml += `
        <div class="status-item">
          <strong>Delta Timer:</strong> ${this.escapeHtml(String((this.deltaTimerConfig as Record<string, unknown>).deltaTimer))}ms
          <span class="status-indicator success">Configured</span>
        </div>
      `;
    } else {
      statusHtml += `
        <div class="status-item">
          <strong>Delta Timer:</strong>
          <span class="status-indicator warning">Not configured</span>
        </div>
      `;
    }

    if (this.subscriptionConfig && (this.subscriptionConfig as Record<string, unknown>).subscribe) {
      const cfg = this.subscriptionConfig as Record<string, unknown>;
      const pathCount = (cfg.subscribe as unknown[]).length;
      const escapedContext = this.escapeHtml((cfg.context as string) || "");
      const escapedPaths = (cfg.subscribe as Array<{ path: string }>)
        .map((s) => this.escapeHtml(s.path))
        .join(", ");
      statusHtml += `
        <div class="status-item">
          <strong>Subscriptions:</strong> ${pathCount} path(s) configured
          <span class="status-indicator success">Configured</span>
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
          <span class="status-indicator warning">Not configured</span>
        </div>
      `;
    }

    if (
      this.sentenceFilterConfig &&
      (this.sentenceFilterConfig as Record<string, unknown>).excludedSentences &&
      ((this.sentenceFilterConfig as Record<string, unknown>).excludedSentences as string[])
        .length > 0
    ) {
      const filterCount = (
        (this.sentenceFilterConfig as Record<string, unknown>).excludedSentences as string[]
      ).length;
      const escapedFilters = (
        (this.sentenceFilterConfig as Record<string, unknown>).excludedSentences as string[]
      )
        .map((s) => this.escapeHtml(s))
        .join(", ");
      statusHtml += `
        <div class="status-item">
          <strong>Sentence Filter:</strong> ${filterCount} sentence(s) excluded
          <span class="status-indicator success">Configured</span>
        </div>
        <div class="status-details">
          <strong>Excluded:</strong> ${escapedFilters}
        </div>
      `;
    }

    statusDiv.innerHTML = statusHtml;
  }

  // ── Utility methods ────────────────────────────────────────────────────────

  buildCompletePluginConfig(currentConfig: Record<string, unknown>): Record<string, unknown> {
    const defaults = this.extractSchemaDefaults(this.pluginSchema);
    const merged = this.deepMerge(defaults || {}, currentConfig || {}) as Record<string, unknown>;
    if (Array.isArray(merged.connections)) {
      return merged;
    }
    const normalizedServerType = this.normalizeServerType(merged.serverType);
    merged.serverType = normalizedServerType || "client";
    return merged;
  }

  normalizeServerType(value: unknown): string | undefined {
    if (value === true || value === "server") {
      return "server";
    }
    if (value === false || value === "client") {
      return "client";
    }
    return undefined;
  }

  extractSchemaDefaults(
    schemaNode: Record<string, any> | null
  ): Record<string, unknown> | undefined {
    if (!schemaNode || typeof schemaNode !== "object") {
      return undefined;
    }

    const isObjectNode = schemaNode.type === "object" || !!schemaNode.properties;
    const merged: Record<string, unknown> = {};
    let hasData = false;

    if (isObjectNode && schemaNode.default && this.isPlainObject(schemaNode.default)) {
      Object.assign(merged, this.deepClone(schemaNode.default));
      hasData = true;
    }

    if (schemaNode.properties && this.isPlainObject(schemaNode.properties)) {
      for (const [key, value] of Object.entries(schemaNode.properties)) {
        const childDefaults = this.extractSchemaDefaults(value as Record<string, any>);
        if (childDefaults !== undefined) {
          merged[key] = childDefaults;
          hasData = true;
        } else if (value && (value as Record<string, any>).type === "object") {
          merged[key] = {};
          hasData = true;
        } else if (value && (value as Record<string, any>).type === "string") {
          merged[key] = "";
          hasData = true;
        }
      }
    }

    if (schemaNode.dependencies && this.isPlainObject(schemaNode.dependencies)) {
      for (const dependencyValue of Object.values(schemaNode.dependencies)) {
        const dependencyDefaults = this.extractSchemaDefaults(
          dependencyValue as Record<string, any>
        );
        if (dependencyDefaults && this.isPlainObject(dependencyDefaults)) {
          Object.assign(merged, this.deepMerge(merged, dependencyDefaults));
          hasData = true;
        }
      }
    }

    for (const compositeKey of ["oneOf", "anyOf", "allOf"]) {
      const composite = schemaNode[compositeKey];
      if (!Array.isArray(composite)) {
        continue;
      }

      composite.forEach((item: Record<string, any>) => {
        const itemDefaults = this.extractSchemaDefaults(item);
        if (itemDefaults === undefined) {
          return;
        }

        if (this.isPlainObject(itemDefaults)) {
          Object.assign(merged, this.deepMerge(merged, itemDefaults));
          hasData = true;
          return;
        }

        if (!hasData && schemaNode.default === undefined) {
          return;
        }

        hasData = true;
      });
    }

    if (hasData) {
      return merged;
    }

    if (schemaNode.default !== undefined) {
      return this.deepClone(schemaNode.default) as Record<string, unknown>;
    }

    return undefined;
  }

  isPlainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  deepClone(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.deepClone(item));
    }
    if (this.isPlainObject(value)) {
      const clone: Record<string, unknown> = {};
      for (const [key, childValue] of Object.entries(value)) {
        clone[key] = this.deepClone(childValue);
      }
      return clone;
    }
    return value;
  }

  deepMerge(baseValue: unknown, overrideValue: unknown): unknown {
    if (overrideValue === undefined) {
      return this.deepClone(baseValue);
    }
    if (Array.isArray(overrideValue)) {
      return this.deepClone(overrideValue);
    }

    if (this.isPlainObject(baseValue) && this.isPlainObject(overrideValue)) {
      const merged = this.deepClone(baseValue) as Record<string, unknown>;
      for (const [key, value] of Object.entries(overrideValue)) {
        merged[key] = this.deepMerge((baseValue as Record<string, unknown>)[key], value);
      }
      return merged;
    }

    return this.deepClone(overrideValue);
  }

  formatBytes(bytes: number): string {
    if (!bytes || bytes <= 0) {
      return "0 B";
    }
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
  }

  escapeHtml(text: string): string {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  showNotification(message: string, type = "success") {
    const notification = document.getElementById("notification");
    if (!notification) {
      return;
    }
    if (this._notificationTimer) {
      clearTimeout(this._notificationTimer);
    }
    notification.textContent = message;
    notification.className = `notification ${type} show`;

    this._notificationTimer = setTimeout(() => {
      notification.classList.remove("show");
      this._notificationTimer = null;
    }, NOTIFICATION_TIMEOUT);
  }
}

// Extend Window interface for the global config instance
declare global {
  interface Window {
    dataConnectorConfig: DataConnectorConfig;
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
    if (window.dataConnectorConfig.metricsInterval) {
      clearInterval(window.dataConnectorConfig.metricsInterval);
      window.dataConnectorConfig.metricsInterval = null;
    }
  } else if (!window.dataConnectorConfig.metricsInterval) {
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

export default DataConnectorConfig;
