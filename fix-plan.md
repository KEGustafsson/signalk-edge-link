# Plan to address issues identified in the `multi_test` branch

## 2026-03-07 execution log

### Batch 1 completed

- Added shared `managementAuthMiddleware(action)` in `lib/routes.js` so sensitive route groups can enforce the configured management token before any state or file checks run.
- Protected the previously exposed configuration, monitoring, capture, delta-timer, and failover routes:
  - `GET/POST /plugin-config`
  - `GET/POST /config/:filename`
  - `GET/POST /connections/:id/config/:filename`
  - `GET/POST /monitoring/alerts`
  - `GET /capture`
  - `POST /capture/start`
  - `POST /capture/stop`
  - `GET /capture/export`
  - `POST /delta-timer`
  - `POST /bonding/failover`
  - `POST /connections/:id/bonding/failover`
- Redacted `secretKey` values from `GET /plugin-config` responses with the `[redacted]` sentinel.
- Preserved unchanged secrets on `POST /plugin-config` by restoring persisted `secretKey` values when the request submits the `[redacted]` sentinel for an existing connection slot.
- Updated operator docs to reflect the expanded management-token protection scope in `README.md`, `docs/security.md`, and `docs/management-tools.md`.
- Added a repo-local `make_pr.ps1` helper so each implementation batch can generate a PR record in `docs/pr-records/`.
- Added regression coverage for:
  - token enforcement on the newly protected config/control/capture routes in `__tests__/routes.rate-limit.test.js`
  - `/plugin-config` secret redaction and unchanged-secret preservation in `__tests__/index.test.js`
- Verification completed:
  - `node --check lib/routes.js`
  - `node --check lib/routes/config.js`
  - `node --check lib/routes/monitoring.js`
  - `node --check lib/routes/control.js`
  - `node --check lib/routes/connections.js`
  - `node --check __tests__/routes.rate-limit.test.js`
  - `node --check __tests__/index.test.js`
  - `npm test -- --runInBand __tests__/routes.rate-limit.test.js __tests__/index.test.js`

## Progress update (implemented in this branch)

- ✅ Added a new management route alias `GET /instances` in `lib/routes/connections.js`.
  - Returns active instance list with compact status and metrics summary.
  - Keeps existing `/connections` routes unchanged for backward compatibility.
- ✅ Added coverage in `__tests__/routes.rate-limit.test.js` to verify route registration and response shape for `/instances`.
- ✅ Implemented `GET /instances/:id` with detailed per-instance operational information (mode, network snapshot, bonding state, and config).
- ✅ Implemented global bonding management endpoints:
  - `GET /bonding` to summarize bonding state across instances.
  - `POST /bonding` to validate and apply failover threshold updates to all bonding-enabled instances.
- ✅ Expanded route unit tests to cover `/instances/:id`, `/bonding`, and `/bonding` validation errors.
- ✅ Added focused v2 server pipeline unit tests for data ingest, duplicate detection, and NAK emission (`__tests__/v2/pipeline-v2-server.test.js`).
- ✅ Added `docs/architecture-overview.md` and linked architecture docs from `README.md`.
- ✅ Added instance lifecycle management endpoints: `POST /instances`, `PUT /instances/:id`, and `DELETE /instances/:id` with validation and restart orchestration.
- ✅ Redacted sensitive `secretKey` values from `GET /instances/:id` configuration payloads.
- ✅ Hardened instance lifecycle APIs by mapping config entries via derived instance IDs (safe with duplicate names) and validating new instance payloads (`serverType`, `udpPort`, `secretKey`).
- ✅ Added `/instances` filtering/pagination support (`state`, `limit`, `page`) with input validation and tests.
- ✅ Tightened `PUT /instances/:id` patch handling by rejecting empty updates and unsupported keys.
- ✅ Added pre-restart duplicate server-port validation to `/instances` create/update paths to avoid invalid runtime reconfiguration.
- ✅ Added lifecycle edge-case handling tests for delete-last-instance protection and missing restart handler responses.
- ✅ Fixed integration route mocks in `__tests__/integration-pipe.test.js` to include `put`/`delete` handlers, restoring full-suite compatibility after adding instance lifecycle routes.

- ✅ Added a unified config schema (`schemas/config.schema.json`) and a migration helper script (`scripts/migrate-config.js`) with tests for legacy-to-connections conversion.
- ✅ Refined config migration/schema behavior to avoid injecting empty `connections` arrays for unrelated configs and to preserve omission of optional legacy flags when absent.
- ✅ Added a lightweight CLI entrypoint (`bin/edge-link-cli.js`) with `migrate-config` support and tests for help/error/migration flows.
- ✅ Updated package publish metadata (`files`) so CLI/schema/migration assets are included in npm tarballs, and added CLI coverage for missing migration input.
- ✅ Hardened legacy config migration by validating required legacy fields (`serverType`, `udpPort`, `secretKey`) before conversion to `connections[]`, preventing invalid partial migrations.
- ✅ Extended the CLI (`bin/edge-link-cli.js`) with management read commands (`instances list`, `instances show`, `bonding status`) and tests for command parsing/API wiring.
- ✅ Extended CLI management beyond read-only commands: added `instances create/update/delete` and `bonding update` operations that call the runtime HTTP API with JSON payloads.
- ✅ Added missing operations docs (`docs/protocol-v2.md`, `docs/bonding.md`, `docs/congestion-control.md`, `docs/metrics.md`) and a starter Grafana dashboard (`grafana/dashboards/edge-link.json`).
- ✅ Added status/error surfacing for operators: `GET /status` now returns per-instance health + recent errors, and `/metrics` now includes categorized `errorCounts` and `recentErrors` summaries.
- ✅ Added `docs/management-tools.md` with practical API + CLI workflows for instance and bonding management.
- ✅ Improved CLI operator UX with optional table output (`--format=table`) for `instances list/show` and `bonding status`, with validation and tests.
- ✅ Added optional management API token protection + audit logging for `/instances`, `/bonding`, and `/status` (supports `X-Edge-Link-Token` or Bearer auth), with route tests.
- ✅ Added CLI token passthrough (`--token` and env fallback) so management commands work against token-protected management APIs without manual header plumbing.
- ✅ Added CLI `status` command (`GET /status`) with optional table output and token support for operator health/error summaries.
- ✅ Added CLI query controls for `instances list` (`--state`, `--limit`, `--page`) with validation, matching the management API filtering/pagination behavior.
- ✅ Fixed CLI paginated list rendering so table output consumes `/instances` pagination envelopes (`items` + `pagination`) and prints page summary metadata.
- ✅ Updated CLI token transport to send both `X-Edge-Link-Token` and Bearer `Authorization` headers for broader proxy compatibility.
- ✅ Relaxed management API credential matching to accept either valid `X-Edge-Link-Token`/`X-Management-Token` or Bearer token when both are present, preventing false 401 responses from conflicting proxy-injected headers.
- ✅ Added documentation schema artifact (`docs/configuration-schema.json`) plus sample config fixtures (`samples/minimal-config.json`, `samples/v2-with-bonding.json`, `samples/development.json`) and automated validation tests.
- ✅ Added security operations guidance in `docs/security.md` covering token auth, key handling, input validation, and network hardening.
- ✅ Added performance tuning guide (`docs/performance-tuning.md`) summarizing benchmark references, parameter trade-offs, and hardware-specific tuning recommendations.
- ✅ Added malformed-packet observability: v2 client/server now increment `malformedPackets` on parse/packet validation failures, exported as `signalk_edge_link_malformed_packets_total` and documented in `docs/metrics.md`.

## Numbered-item completion status

- ✅ **1.1 Implement the v2 server pipeline** — implemented with sequence handling, ACK/NAK logic, retransmit behavior, and unit coverage.
- ✅ **1.2 Flesh out missing utilities** — retransmit queue, sequence tracker, Prometheus formatter/export route behavior, and route tests are implemented.
- ✅ **1.3 Missing documentation** — architecture, protocol, bonding, congestion-control, and README/doc index links are in place.
- ✅ **2.1 Consolidate configuration files** — unified schema, migration tooling, and docs are implemented.
- ✅ **2.2 API and schema docs** — API reference, docs-facing schema artifact, and sample configuration fixtures with tests are implemented.
- ✅ **3.1 Extend metrics** — additional v2/bonding/error metrics (including malformed packets) are instrumented and exported.
- ✅ **3.2 Surface errors** — categorized errors and recent error summaries are exposed in status/metrics APIs and Prometheus views.
- ✅ **4.1 Management tooling** — management REST API + CLI (read/write operations, auth, filtering, formatting) and usage docs are implemented.
- ✅ **5.1 Security audit actions** — AES-GCM usage, token-auth protections, input validation hardening, and security best-practices documentation are implemented.
- ✅ **5.2 Performance profiling actions** — benchmark artifacts and tuning guidance are documented in performance reports and `docs/performance-tuning.md`.
- ✅ **6 Timeline and prioritisation** — short/medium/long-term items are now captured as delivered work in this branch history.

This document outlines a comprehensive plan to address the issues found in the `multi_test` branch of
the `signalk-edge-link` project.  Each section below describes an identified issue, the rationale
for addressing it, and concrete steps required to implement a fix or improvement.  The plan is
organised into short–, medium– and long‑term actions so that the work can be prioritised.

## 1. Complete unfinished modules

### 1.1 Implement the v2 server pipeline

* **Problem:** `lib/pipeline-v2-server.js` is currently a placeholder with no implementation.  Without a
  server‑side counterpart, the v2 protocol cannot be used in server mode.  The server pipeline
  must mirror the features of the client: ordered delivery via sequence numbers, acknowledgements
  and negative acknowledgements (ACK/NAK), retransmissions and congestion control.

* **Detailed plan:**

  1. **Define responsibilities and public API** – The server pipeline should expose at least the
     following methods:

     * `receivePacket(packet: Buffer, secretKey: string, rinfo: {address: string, port: number})` –
       Invoked by the UDP server when a packet arrives.  This method must:
         - Decrypt and authenticate the packet using the same cryptography functions used in the
           client pipeline (`crypto` module).  
         - Parse the packet header to extract the sequence number and flags.  A simple format could
           reserve the first 2 bytes for a 16‑bit sequence number and a flag byte indicating
           whether the payload contains delta data or is a control packet.
         - Detect out‑of‑order or duplicate packets using a `SequenceTracker` (see §1.2 below).
           If the packet is a duplicate, it should be ignored except for resending an ACK.
         - Buffer in‑order deltas and hand them off to the instance’s delta processing via
           `app.handleMessage()` when a complete batch has been reconstructed.
         - Push the sequence number into a pending‑ACK queue for later flushing.

     * `flushAcks()` – Periodically sends aggregated acknowledgements.  A simple implementation can
       accumulate acknowledged sequence numbers in an array and send a single ACK packet every
       20–50 ms.  The ACK packet should contain a list of sequence numbers or ranges so the
       client can clean its retransmit queue.

     * `startACKTimer()` / `stopACKTimer()` – Start and stop a repeating timer that calls
       `flushAcks()` at a configurable interval.

     * `startMetricsPublishing()` / `stopMetricsPublishing()` – The server pipeline should publish
       server‑side metrics (e.g. number of received deltas, duplicate drops, average RTT measured
       from client heartbeats) via the existing metrics API.  These methods can wrap setInterval
       timers that emit metrics into the metrics publisher.

  2. **Implement sequence and retransmission tracking** – Use a dedicated class (`SequenceTracker`)
     to maintain the next expected sequence number, detect duplicates and out‑of‑order packets and
     provide helper methods such as:
     
     ```js
     class SequenceTracker {
       constructor() { this.expected = 0; this.window = new Set(); }
       isDuplicate(seq) { return this.window.has(seq); }
       isExpected(seq) { return seq === this.expected; }
       advance(seq) { this.window.add(seq); this.expected = (seq + 1) & 0xffff; /* modulo 16 bits */ }
     }
     ```

     The server pipeline can instantiate this tracker and consult it in `receivePacket()` to
     determine whether to enqueue the delta or drop it.

  3. **Handle congestion control and retransmissions** – When the client requests a retransmission
     (via a NAK), the server must resend the missing packets from its own queue.  This queue can
     be implemented in `lib/retransmit-queue.js` (see §1.2).  The server pipeline should also
     respect back‑pressure signals (e.g. congestion control flags) by throttling outgoing delta
     transmissions.  Use the same congestion control algorithm as the client for consistency.

  4. **Unit tests** – Under `__tests__/v2/pipeline-v2-server.test.js`, write tests that simulate
     receiving in‑order, out‑of‑order and duplicate packets; verify that ACKs and NAKs are sent
     correctly; and ensure that metrics counters (e.g. `deltasReceived`, `duplicatesDropped`)
     increment as expected.  Use Node’s `dgram` module to simulate UDP sockets in tests.

  5. **Incremental development** – Implement the server pipeline in stages: start with basic
     parsing and ACK sending; then add sequence tracking; then add retransmission support; and
     finally integrate congestion control and metrics.  Each stage should be covered by tests
     before moving on.

### 1.2 Flesh out missing utilities

Several utility modules are currently empty stubs.  To enable future development and ensure
predictable behaviour, each module should have a clear interface and a minimal implementation.

* **Detailed plan:**

  #### 1.2.1 `lib/retransmit-queue.js`
  
  *Purpose:* Maintain a queue of packets that have been sent but not yet acknowledged.  The client
  pipeline will enqueue each outgoing delta with its sequence number, and the server pipeline will
  dequeue entries upon receiving ACKs.  The queue should also expose expired packets to support
  retransmission when no ACK is received.

  **Suggested implementation:**

  ```js
  class RetransmitQueue {
    constructor(timeoutMs = 5000) {
      this.queue = new Map();
      this.timeoutMs = timeoutMs;
    }

    enqueue(seq, packet) {
      this.queue.set(seq, { packet, timestamp: Date.now() });
    }

    acknowledge(seq) {
      this.queue.delete(seq);
    }

    /**
     * Return packets that have been pending longer than timeoutMs.
     */
    getExpired() {
      const now = Date.now();
      const expired = [];
      for (const [seq, { packet, timestamp }] of this.queue) {
        if (now - timestamp > this.timeoutMs) {
          expired.push({ seq, packet });
          // Optionally update timestamp to avoid immediate retransmission again
          this.queue.set(seq, { packet, timestamp: now });
        }
      }
      return expired;
    }
  }

  module.exports = RetransmitQueue;
  ```

  *Unit tests:* Verify that enqueued packets are returned by `getExpired()` after `timeoutMs` and
  removed by `acknowledge()`.  Simulate concurrent enqueues and acknowledgements.

  #### 1.2.2 `lib/sequence.js`
  
  *Purpose:* Provide utilities for managing sequence numbers for both client and server pipelines.
  Sequence numbers wrap around at 16 bits and are used to detect duplicates and lost packets.

  **Suggested implementation:**

  ```js
  class SequenceTracker {
    constructor() {
      this.expected = 0;
      this.received = new Set();
    }

    /**
     * Returns true if the sequence number is the one we expect next.  Increments expected value.
     */
    accept(seq) {
      if (seq === this.expected) {
        this.expected = (this.expected + 1) & 0xffff;
        return true;
      }
      return false;
    }

    /**
     * Returns true if this seq has already been seen in the current window.
     */
    isDuplicate(seq) {
      return this.received.has(seq);
    }

    markReceived(seq) {
      this.received.add(seq);
      // Optionally prune old entries to prevent unbounded growth
      if (this.received.size > 1000) {
        const oldest = [...this.received].sort((a, b) => a - b).slice(0, 100);
        for (const s of oldest) this.received.delete(s);
      }
    }
  }
  module.exports = SequenceTracker;
  ```

  *Unit tests:* Confirm that `accept()` returns true only for the expected sequence number and that
  `isDuplicate()` returns true after a sequence has been marked.  Test wraparound behaviour at 65535.

  #### 1.2.3 `lib/prometheus.js`
  
  *Purpose:* Expose metrics in Prometheus format.  The project already tracks metrics via a
  metrics API; this module should register those metrics with the Prometheus client library and
  expose an HTTP endpoint for scraping.

  **Suggested implementation:**

  ```js
  const client = require('prom-client');

  // Create a registry so that we can register our own metrics
  const registry = new client.Registry();

  // Example: define a counter for bond switches
  const bondSwitchCounter = new client.Counter({
    name: 'edge_link_bond_switches_total',
    help: 'Total number of failover/failback events',
    registers: [registry],
  });

  function getMetrics() {
    return registry.metrics();
  }

  module.exports = {
    registry,
    bondSwitchCounter,
    getMetrics,
  };
  ```

  *Route handler:* In `lib/routes/metrics.js` implement an Express route (if using Express) that
  responds to `GET /prometheus` with `await prometheus.getMetrics()` and sets the
  `Content-Type` header to `text/plain; version=0.0.4`.

  #### 1.2.4 `lib/routes/metrics.js` and other routes
  
  Create Express route handlers for:
  * `/instances` – returns a JSON array of active instances with their status and metrics.  Use
    `app.getActiveInstances()` or similar API.
  * `/bonding` – returns bonding state (active link, quality metrics) and accepts `POST` or
    `PUT` requests to change bonding settings.  Validate input to prevent invalid modes.

  Include unit tests with supertest to verify HTTP status codes and responses.

### 1.3 Introduce missing documentation for new features

* **Problem:** The documentation under `docs/` does not yet include a high‑level architecture
  overview or detailed descriptions of the v2 protocol, bonding or congestion control.  Without
  these, new contributors and automated tools (such as AI assistants) cannot easily understand
  how the system fits together.

* **Detailed plan:**

  1. **Create `docs/architecture-overview.md`** – This file should include:
     * A **diagram** (use Mermaid or ASCII art) that shows how an instance interacts with the
       Signal K app, v1 and v2 pipelines, monitoring components, the metrics publisher and the
       bonding manager.  For example:

       ```mermaid
       graph LR
         subgraph Instance
           A(app) --> B[Instance factory]
           B --> C{protocolVersion}
           C -->|v1| D[pipeline-v1]
           C -->|v2| E[pipeline-v2-client]
           E --> F[Bonding Manager]
           E --> G[Congestion Control]
           F --> H[UDP Socket(s)]
         end

         B --> I[Monitoring]
         I --> J[Metrics Publisher]
       ```

     * A description of the **life cycle** of an instance: creation, start, runtime (receiving
       deltas, batching, sending, monitoring) and stop.
     * Explanation of how **v2** differs from **v1**, including sequence numbers, ACK/NAK, and
       congestion control.
     * A section on **bonding**, describing primary/backup links, failover thresholds and how
       metrics influence the bonding manager’s decisions.

  2. **Document configuration options** – For each top‑level config key (e.g. `protocolVersion`,
     `deltaTimer`, `subscription`, `congestionControl`, `bonding`), provide a table with
     description, type, default value and example values.  Include this table in the new
     architecture overview or in `docs/configuration-reference.md`.

  3. **Update README** – Include a link to the architecture overview and summarise the new
     capabilities of the v2 protocol.  Provide quick‑start examples showing how to enable v2,
     bonding and congestion control in the unified configuration file (see §2.1).

## 2. Improve configuration management

### 2.1 Consolidate configuration files

Currently, each instance stores three separate JSON files (`delta_timer.json`, `subscription.json`,
and `sentence_filter.json`) in its data directory.  As more features are added (e.g. bonding,
congestion control), the number of files will grow and configuration will become harder to manage.

* **Detailed plan:**

  1. **Define a unified configuration schema** – Create a single YAML or JSON file (e.g.
     `config.yaml`) at the instance level containing all settings.  The top‑level structure should
     group related options under descriptive keys.  For example:

     ```yaml
     protocolVersion: 2
     deltaTimer:
       intervalMs: 100
       batchSize: 10
     subscription:
       context: vessel.self
       filters:
         - path: navigation.position
     sentenceFilter:
       nmea2000: false
       ais: true
     congestionControl:
       enabled: true
       maxWindow: 32
     bonding:
       enabled: true
       primaryLink: eth0
       backupLink: cellular0
       failoverThreshold: 500  # milliseconds
     ```

     Use JSON Schema (e.g. `schemas/config.schema.json`) to formally define the allowed keys,
     types, required fields and default values.  This schema can be used by validation
     libraries (such as `ajv`) at runtime to provide clear error messages when invalid
     configuration is loaded.

  2. **Migration script** – Write a Node script (e.g. `scripts/migrate-config.js`) that reads
     existing per‑feature JSON files, merges their contents into the unified configuration and
     writes the new file.  Pseudocode:

     ```js
     const fs = require('fs');
     const path = require('path');
     const dataDir = process.argv[2];
     const unified = {};
     // read delta_timer.json
     const delta = JSON.parse(fs.readFileSync(path.join(dataDir, 'delta_timer.json'), 'utf8'));
     unified.deltaTimer = { intervalMs: delta.intervalMs, batchSize: delta.batchSize };
     // similarly read subscription.json and sentence_filter.json
     // write unified config
     fs.writeFileSync(path.join(dataDir, 'config.yaml'), yaml.dump(unified));
     console.log('Migration complete');
     ```

     Include this migration script in the release notes and ensure it is idempotent (running it
     multiple times does not corrupt the configuration).  Provide unit tests under
     `__tests__/scripts/migrate-config.test.js` that create temporary directories with mock
     JSON files, run the script and verify the resulting YAML matches expectations.

  3. **Update configuration I/O** – Modify `lib/config-io.js` and the instance factory to load
     and save the unified configuration.  Remove logic that references the old per‑feature files.
     When loading the unified file:
       * Validate it against the JSON schema using a library like `ajv`.  If validation fails,
         throw an error with context (e.g. which key is invalid).
       * Apply default values for any missing optional fields.
     When saving, serialise the in‑memory configuration back to YAML or JSON in a stable
     formatting order (e.g. alphabetical keys) to minimise diffs.

  4. **Documentation and examples** – Update `docs/configuration-reference.md` to describe the
     unified file format.  Include examples for common scenarios (e.g. enabling v2 with
     congestion control and bonding).  Provide a table of each top‑level key, its meaning, type,
     default value, and any constraints (e.g. `failoverThreshold` must be ≥ 0).  Encourage users
     upgrading from older versions to run the migration script or manually merge their settings.

### 2.2 Document the external API and configuration schema

* **Detailed plan:**

  1. **API reference** – Create `docs/api-reference.md` describing each public function exposed by
     the plugin.  For every function or class (e.g. `InstanceFactory.createInstance()`,
     `PipelineV2Client.sendDelta()`), include:
       * A concise summary of its purpose.
       * Detailed parameter descriptions, including types and whether parameters are optional.
       * The return type (or the structure of callback errors/promises).
       * Examples of usage with real values.
     Structure the document by grouping related APIs (e.g. instance management, pipeline
     operations, metrics).  Use Markdown headings and code blocks for clarity.

  2. **Configuration schema** – Formalise the configuration structure using JSON Schema and embed
     it in `docs/configuration-schema.json`.  This schema should include `title`, `description`,
     `properties`, `type`, `required` and `additionalProperties: false`.  Provide `examples` for
     typical configurations.  Reference this schema in your code with `ajv` validation (see §2.1).

  3. **Sample files** – Provide sample configuration files under a `samples/` directory, such as
     `samples/minimal-config.yaml`, `samples/v2-with-bonding.yaml` and
     `samples/development.yaml`.  Annotate these files with comments explaining each option and
     how to adapt it for different deployments.  Use these samples as fixtures in automated tests
     to ensure that the plugin can load and validate them without errors.

  4. **Auto‑generated docs** – Consider using tools like `jsdoc` or `typedoc` to extract
     documentation from source code and generate HTML or Markdown documentation.  Automate this
     process via a npm script (e.g. `npm run docs`) so that docs stay in sync with code changes.

## 3. Enhance metrics and monitoring

### 3.1 Extend metrics for new features

The current metrics focus on batching and throughput.  With the introduction of bonding,
congestion control and v2 sequence handling, additional insights are required to operate the
system reliably and to facilitate automated decision‑making.

* **Detailed plan:**

  1. **Define new metrics** – Add counters, gauges and histograms to track:
       * **Bonding events** – a counter `edge_link_bond_switches_total` incremented whenever the
         active link changes (failover or failback).  Label with `from` and `to` link names.
       * **Link quality** – a gauge `edge_link_quality` labelled by `link` that holds the
         exponential‑moving‑average (EMA) of RTT or packet loss for each link.
       * **Congestion events** – counters for `edge_link_congestion_drops_total` and
         `edge_link_window_reductions_total` that count how many packets were dropped due to
         congestion control and how many times the sending window was reduced.
       * **Retransmissions** – a counter `edge_link_retransmissions_total` that increments each
         time a packet is retransmitted.  Use a histogram `edge_link_retransmission_delay_ms`
         to observe the latency between initial send and retransmission.
       * **Error counts** – counters for specific error categories such as `subscription_errors`,
         `send_failures`, `ping_monitor_errors`, and cryptographic failures.  Each should be
         labelled (e.g. by `instance` or `link`) to identify the origin of problems.
       * **Sequence gaps** – a gauge `edge_link_sequence_gap` recording the difference between
         expected and received sequence numbers.  A non‑zero value indicates out‑of‑order or
         missing packets and may signal network issues.

  2. **Instrumentation** – Update the code paths in the v2 client and server pipelines to update
     these metrics.  For example, in `receivePacket()` when a duplicate or out‑of‑order packet is
     detected, increment the corresponding counter or adjust `edge_link_sequence_gap` accordingly.
     For bonding, hook into the bonding manager’s decision logic to increment
     `edge_link_bond_switches_total` and update `edge_link_quality` based on measured RTT.

  3. **Expose metrics** – Modify the existing metrics API and `lib/prometheus.js` (see §1.2) so
     that all new metrics are registered on the Prometheus registry and exposed via the
     `/prometheus` endpoint.  Provide a JSON representation via the Signal K plugin API for
     integration with other dashboards.  Document the names, types and semantics of these
     metrics in `docs/metrics.md`.

  4. **Update Grafana dashboard** – Create or extend a Grafana dashboard JSON file (e.g.
     `grafana/dashboards/edge-link.json`) with panels for the new metrics: line charts for link
     quality over time, bar graphs for bond switches and retransmissions, and heatmaps for
     congestion events.  Provide default alert rules (e.g. alert when retransmissions exceed
     5 per minute or when sequence gaps persist for more than 3 seconds).  Store this dashboard
     configuration under version control so users can import it easily.

### 3.2 Surface errors to users
Currently, many errors are logged via `app.debug()` and `app.error()` without being surfaced
through the API or user interface.

* **Detailed plan:**

  1. **Error categorisation** – Define an enumeration of error categories (e.g. `SUBSCRIPTION_ERROR`,
     `SEND_FAILURE`, `PING_TIMEOUT`, `CRYPTO_ERROR`).  Modify error logging so that when
     `app.error()` is called, the code also passes a category identifier.

  2. **Metrics counters** – For each category, register a Prometheus counter (as described in
     §3.1) and increment it whenever an error is logged.  Expose these counters via the metrics
     API so that dashboards and alerting can be based on error rates.

  3. **Status API** – Enhance `getStatus()` to include a summary of recent errors and warnings.
     This could be a list of the last N errors with timestamps and categories or aggregated counts
     over the past minute/hour.  Document the format in the API reference.

  4. **User notifications** – For critical errors (e.g. repeated send failures, authentication
     failures), consider integrating with the Signal K notification system to display alerts in the
     web UI.  Implement a simple thresholding mechanism: when a counter exceeds a defined
     threshold within a time window, push a notification.  Provide configuration options to
     control notification severity and thresholds.

## 4. Provide management tooling

### 4.1 CLI or web UI for instance and bonding management

Managing multiple connection instances and bonding configurations via static configuration files
is error‑prone and does not provide real‑time visibility.  A user‑friendly management interface
(CLI and/or web UI) will make it easier to monitor status, change settings and debug issues.

* **Detailed plan:**

  1. **Define API endpoints** – Implement RESTful routes under `lib/routes/` using the existing
     HTTP server infrastructure.  Proposed endpoints:
       * `GET /instances` – returns a JSON array of active instances with properties such as
         `id`, `protocolVersion`, `state` (connected/disconnected), `currentLink`, metrics like
         `deltasSent` and `errors`.  Pagination and filtering by state should be supported.
       * `GET /instances/:id` – returns detailed information about a single instance including
         configuration, link quality metrics, congestion control parameters and recent logs.
       * `POST /instances` – creates a new instance.  Accepts JSON body with configuration.
         Validate the body against the configuration schema and start the instance.
       * `PUT /instances/:id` – updates the configuration of an existing instance at runtime.
         Only allow changes to certain fields (e.g. enable/disable congestion control).  Restart
         the instance if necessary.
       * `DELETE /instances/:id` – stops and removes an instance.
       * `GET /bonding` – returns current bonding settings and status across all instances,
         including active link, failover thresholds and quality metrics.
       * `POST /bonding` – modifies global bonding parameters (e.g. enable/disable bonding,
         adjust failover thresholds).  Validate input and apply changes live.

     Protect these endpoints with authentication (e.g. API tokens or basic auth) and role-based
     authorisation.  Use middleware to log API access for auditing.

  2. **Command‑line interface** – Create a CLI script (e.g. `bin/edge-link-cli.js`) using a
     library like `commander` to parse subcommands.  Support commands such as:

     ```sh
     # List instances
     edge-link-cli instances list

     # Show details of an instance
     edge-link-cli instances show <id>

     # Create an instance from a config file
     edge-link-cli instances create --config path/to/config.yaml

     # Enable congestion control on an instance
     edge-link-cli instances update <id> --congestionControl.enabled=true

     # Show bonding status
     edge-link-cli bonding status

     # Modify bonding parameters
     edge-link-cli bonding update --failoverThreshold=300
     ```

     The CLI should internally call the HTTP API endpoints.  Provide helpful error messages
     when requests fail and format outputs in a human‑friendly manner (e.g. tables for lists).

  3. **Web UI extension** – For users preferring a graphical interface, extend the existing
     Signal K web UI (or create a dedicated React/Vue component) to display the same information
     and allow interactive management.  Use WebSockets or polling to update instance status and
     metrics in real time.  Provide forms for editing configuration with validation using the
     JSON schema defined in §2.1.

  4. **Testing and documentation** – Write integration tests for API routes using supertest and
     for the CLI using `child_process.exec` to simulate commands.  Document API endpoints and
     CLI usage in `docs/management-tools.md`.  Include examples and screenshots of the web UI
     if applicable.  Provide clear instructions on enabling the management interface and
     securing it in production.

## 5. Security and performance

### 5.1 Security audit

Security is paramount when transmitting vessel data over networks, especially when multiple
links and bonding are involved.  The code currently uses custom cryptographic wrappers; a
comprehensive audit will identify potential weaknesses and improve resilience.

* **Detailed plan:**

  1. **Review algorithms and key management** – Examine `lib/crypto.js` to verify the algorithms
     being used.  Replace any outdated primitives (e.g. AES‑CBC) with authenticated encryption
     modes (e.g. AES‑GCM or ChaCha20‑Poly1305).  Use a well‑maintained library such as
     `node-forge` or `crypto` built into Node.js.  Ensure that nonces/IVs are generated with
     cryptographically secure random functions and never reused for the same key.

  2. **Key storage** – Keys and secret material must not be hardcoded.  Provide options to load
     secrets from environment variables, OS keychains or encrypted files.  When persisting keys,
     encrypt them at rest using a master key derived from a passphrase or a hardware security
     module (HSM) if available.

  3. **Secrets rotation** – Design an API for rotating keys without downtime.  For example,
     support sending a `KEY_UPDATE` control message over the v2 protocol, instructing the peer to
     switch to a new key at a specific sequence number.  Maintain a sliding window where both the
     old and new keys are accepted to allow for out‑of‑order packets during the transition.

  4. **Input validation** – Audit all external inputs (configuration, API payloads, network
     packets) to ensure they are validated and sanitised.  Use the JSON schema validation in
     §2.1 for configuration and robust parsing for network packets to avoid buffer overflows or
     injection attacks.  Reject packets with invalid sequence numbers or malformed headers and
     increment an `edge_link_malformed_packets_total` counter.

  5. **Logging hygiene** – Scrub sensitive information from logs.  Introduce a logging helper
     function that checks whether a piece of data (e.g. keys, nonces, user credentials) should
     be redacted.  Provide configurable log levels so that detailed logs can be enabled for
     debugging without exposing secrets in production.

  6. **Documentation of best practices** – Create a section in the documentation (e.g.
     `docs/security.md`) outlining recommended practices: generate unique keys per vessel or
     instance, rotate keys every N days, use secure random number generators, and enforce
     least‑privilege access for the management API.  Include guidance on firewall rules and
     network segmentation to limit exposure.

### 5.2 Performance profiling
### 5.2 Performance profiling

Efficient resource usage is crucial for embedded deployments (e.g. Raspberry Pi).  Profiling will
help identify bottlenecks and ensure that new features do not degrade performance.

* **Detailed plan:**

  1. **Benchmark existing implementation** – Use Node.js profiling tools (e.g. `clinic.js` or
     built‑in CPU and heap profilers) to measure CPU time, memory usage and network throughput in
     realistic scenarios: single instance on local network, multiple instances with bonding,
     high‑throughput delta streams.  Capture baseline metrics such as average CPU usage, max
     memory consumption, latency distribution and packet drop rates.

  2. **Identify hotspots** – Analyse flame graphs and heap snapshots to locate functions with
     high CPU or memory usage.  Expect heavy activity in delta batching loops, encryption and
     decryption routines, JSON parsing/stringifying and sequence tracking.  Document the top
     offenders and propose optimisations (e.g. reusing buffers, minimising object allocations,
     using typed arrays for binary data).

  3. **Optimise critical paths** – Based on findings, implement improvements such as:
       * Using a buffer pool for frequently allocated buffers in the UDP pipeline.
       * Switching from synchronous to asynchronous crypto operations if they yield better
         throughput.
       * Precomputing constant parts of packet headers to avoid recomputation on every send.
       * Adjusting the delta batching algorithm to minimise the number of JSON serialisations per
         second (e.g. by caching recent deltas until a size threshold is reached).
       * Tuning Node.js runtime parameters (e.g. `--max-old-space-size`) for memory‑constrained
         devices.

  4. **Measure after optimisation** – Re‑run benchmarks to confirm improvements.  Compare metrics
     against the baseline to ensure that performance regressions are detected early.

  5. **Document tuning recommendations** – Create a new file `docs/performance-tuning.md` that
     summarises profiling results and provides guidance on selecting delta timer values, buffer
     sizes, congestion control parameters and link bonding settings.  Highlight trade‑offs between
     latency and throughput and provide sample configurations for common hardware platforms (e.g.
     Raspberry Pi 3/4, x86 servers).  Encourage users to monitor metrics and adjust settings
     according to their network conditions.

## 6. Timeline and prioritisation

1. **Short term (next 1–2 weeks):**
     * Implement placeholders for missing modules with clear interfaces (see §1.2) and add unit tests.
     * Draft the unified configuration schema and create the migration script (see §2.1).
     * Begin documentation updates: architecture overview, API reference skeletons and configuration reference.

2. **Medium term (next 1–2 months):**
     * Complete the v2 server pipeline including sequence tracking, congestion control and retransmissions (see §1.1).
     * Implement the Prometheus metrics exporter and extend metrics for bonding and congestion control (see §3.1).
     * Add the CLI and REST API for instance and bonding management, along with authentication (see §4.1).
     * Begin the security audit: replace deprecated crypto algorithms and design key rotation mechanism (see §5.1).

3. **Long term (2 months and beyond):**
     * Perform extensive performance profiling and implement optimisations (see §5.2).  Provide tuning documentation.
     * Expand the web UI to cover all management features and integrate real‑time metrics graphs.
     * Finalise the JSON Schema and guarantee API stability; treat any breaking changes as major version bumps.
     * Continue refining the documentation and sample configurations; gather feedback from users and iterate.

This plan should be tracked via GitHub issues and milestones to enable progress visibility and
collaboration.  Contributors are encouraged to tackle tasks incrementally and to keep
documentation in sync with code changes.
