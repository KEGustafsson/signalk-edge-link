# Plan: Array Schema + Concurrent Multi-Instance Support

**Branch**: `claude/plugin-array-concurrency-plan-u6plY`
**Goal**: Enhance the plugin so a single Signal K plugin installation can run multiple
server and/or client connections simultaneously, each fully isolated, each configured as
an item in an array schema.

---

## 1. Background and Current Limitations

### What works today
- One plugin instance supports **one** connection: either a server OR a client.
- A single shared `state` object in `index.js` holds everything (socket, pipeline,
  timers, metrics, monitoring, file watchers).
- The JSON schema is a flat object with a `serverType` discriminator.
- Config files (`delta_timer.json`, `subscription.json`, `sentence_filter.json`) live
  directly in `app.getDataDirPath()`.
- All Signal K metric paths are under `networking.edgeLink.*` (single namespace).
- All REST API routes (`/metrics`, `/bonding`, `/congestion`, etc.) target the single
  state object.

### What needs to change
- **Schema**: must become an array of connection configs.
- **Lifecycle**: `start()` / `stop()` must manage an array of independent instances.
- **State isolation**: every instance needs its own socket, pipeline, timers, metrics.
- **Config files**: namespaced per instance so two clients do not share the same
  `subscription.json`.
- **Signal K paths**: namespaced per instance so metrics do not collide.
- **REST routes**: must be addressable per instance (and keep a backward-compat alias
  for the first/only instance).
- **Status line**: must aggregate the health of all instances.
- **Backward compat**: an existing flat (non-array) config must continue to work without
  requiring users to migrate manually.

---

## 2. High-Level Architecture

```
plugin.start(options)
  │
  ├─ detect legacy flat config  →  wrap as [options] with instanceId="default"
  │
  └─ options.connections[]
       ├─ createInstance(app, cfg, "conn-0")  →  start()
       ├─ createInstance(app, cfg, "conn-1")  →  start()
       └─ createInstance(app, cfg, "conn-2")  →  start()

instances Map<instanceId, instance>
  each instance owns:
    state, metricsApi, pipeline, socket, timers, watchers, config files
```

All sub-modules (`createPipelineV2Client`, `createPipelineV2Server`,
`createPipeline`, `createRoutes`) already accept `(app, state, metricsApi)` — they
are already parameterised and need **no signature changes**.

---

## 3. Phased Implementation Plan

### Phase 1 — New Schema (array-based)

**File**: `index.js` → `plugin.schema`

#### 1a. Define the connection item schema

Extract all existing properties (`serverType`, `udpPort`, `secretKey`,
`useMsgpack`, `usePathDictionary`, `protocolVersion`, and the `dependencies`
block for server/client-specific settings) into a reusable schema fragment.

Add one new field at the item level:

```json
"name": {
  "type": "string",
  "title": "Connection Name",
  "description": "Human-readable label for this connection (e.g. 'shore-server', 'sat-client')",
  "default": "connection",
  "maxLength": 40
}
```

The `name` value is slugified to produce the `instanceId` (e.g. `"Shore Server"` →
`"shore-server"`). If two items share the same slug, append `-0`, `-1` to
disambiguate.

#### 1b. Wrap in array schema

```json
{
  "type": "object",
  "title": "SignalK Edge Link",
  "properties": {
    "connections": {
      "type": "array",
      "title": "Connections",
      "description": "Add one item per server or client connection",
      "minItems": 1,
      "items": { <connection item schema> }
    }
  },
  "required": ["connections"]
}
```

#### 1c. Backward-compat detection

In `plugin.start()`, before iterating:

```js
const connectionList = Array.isArray(options.connections)
  ? options.connections
  : [{ ...options, name: "default" }];   // legacy flat config
```

This means existing deployments need **zero config changes**.

---

### Phase 2 — Instance Factory (`lib/instance.js`)

Create a new file `lib/instance.js` that encapsulates everything currently spread
across the top portion of `index.js`.

#### 2a. Function signature

```js
function createInstance(app, options, instanceId) {
  // returns { start, stop, getState, getMetrics, getId }
}
module.exports = { createInstance };
```

#### 2b. What goes inside

Move the following from `index.js` into `createInstance`:

| Current location in `index.js` | Moves to instance |
|---|---|
| `const state = { ... }` (the big object) | `const state = { ...instanceDefaults, instanceId }` |
| `createMetrics()` | per-instance call |
| `createPipeline(app, state, metricsApi)` | per-instance call |
| `scheduleDeltaTimer()` | per-instance closure |
| `createDebouncedConfigHandler(...)` | per-instance closure |
| `handleDeltaTimerChange`, `handleSubscriptionChange`, `handleSentenceFilterChange` | per-instance |
| `createWatcherWithRecovery(...)` | per-instance |
| `setupConfigWatchers()` | per-instance |
| `initializePersistentStorage()` | per-instance, uses namespaced path |
| `filterOutboundDelta(delta)` | per-instance (filter by this instance's plugin.id label) |
| `handlePingSuccess(...)` | per-instance |
| `publishRtt(rttMs)` | per-instance |
| Server mode startup block (`options.serverType === "server"`) | `instance.start()` |
| Client mode startup block (`else` branch) | `instance.start()` |
| `plugin.stop()` body | `instance.stop()` |

#### 2c. Per-instance state additions

Add two new fields to the state object:

```js
const state = {
  instanceId,          // string: slug derived from name (e.g. "shore-server")
  instanceName,        // string: human-readable (e.g. "Shore Server")
  instanceStatus: "",  // latest status string for this instance
  ...existingFields
};
```

#### 2d. Per-instance `setStatus` wrapper

Each instance publishes its own status. The coordinator aggregates (see Phase 4).

```js
function instanceSetStatus(msg) {
  state.instanceStatus = msg;
  // Coordinator will call app.setPluginStatus() with aggregated string
  if (onStatusChange) onStatusChange(instanceId, msg);
}
```

---

### Phase 3 — Config File Namespacing

**Current** (shared, single instance):
```
{dataDir}/delta_timer.json
{dataDir}/subscription.json
{dataDir}/sentence_filter.json
```

**New** (per-instance):
```
{dataDir}/instances/{instanceId}/delta_timer.json
{dataDir}/instances/{instanceId}/subscription.json
{dataDir}/instances/{instanceId}/sentence_filter.json
```

#### 3a. `initializePersistentStorage` change

```js
async function initializePersistentStorage() {
  const instanceDir = join(app.getDataDirPath(), "instances", instanceId);
  await fs.mkdir(instanceDir, { recursive: true });
  state.deltaTimerFile  = join(instanceDir, "delta_timer.json");
  state.subscriptionFile = join(instanceDir, "subscription.json");
  state.sentenceFilterFile = join(instanceDir, "sentence_filter.json");
  // ... rest same as before
}
```

#### 3b. Migration for legacy single instance

On first start after upgrade, if `instanceId === "default"` and a root-level
`delta_timer.json` exists but the instance-level one does not, copy the root-level
files into `instances/default/` automatically, then log a one-time migration notice.

```js
async function migrateLegacyConfigFiles() {
  if (instanceId !== "default") return;
  const legacyFiles = ["delta_timer.json", "subscription.json", "sentence_filter.json"];
  for (const file of legacyFiles) {
    const legacy = join(app.getDataDirPath(), file);
    const target = join(app.getDataDirPath(), "instances", "default", file);
    const legacyExists = await fs.access(legacy).then(() => true).catch(() => false);
    const targetExists = await fs.access(target).then(() => true).catch(() => false);
    if (legacyExists && !targetExists) {
      await fs.copyFile(legacy, target);
      app.debug(`[instance:default] Migrated legacy ${file} to instances/default/`);
    }
  }
}
```

---

### Phase 4 — Plugin Coordinator (new `index.js` structure)

`index.js` becomes a thin coordinator. Only what is truly global stays here:

```
index.js responsibilities after refactor:
  - plugin.id / plugin.name / plugin.description
  - plugin.schema (array schema)
  - plugin.registerWithRouter → coordinator routes + per-instance routes
  - plugin.start(options):
      parse connections array (or wrap legacy)
      validate no duplicate ports (server instances on same port → error)
      for each cfg: createInstance(app, cfg, slugify(cfg.name))
      store in instances Map
      start each instance
      set up status aggregation callback
  - plugin.stop():
      stop all instances
      clear instances Map
  - status aggregation:
      collect instanceStatus from all instances
      call app.setPluginStatus(aggregated)
```

#### 4a. Port collision detection (server mode)

Before starting any instance, scan for duplicate server ports:

```js
const serverPorts = connectionList
  .filter(c => c.serverType === "server")
  .map(c => c.udpPort);
const duplicates = serverPorts.filter((p, i) => serverPorts.indexOf(p) !== i);
if (duplicates.length > 0) {
  app.error(`Duplicate server ports detected: ${duplicates.join(", ")}. Each server must use a unique port.`);
  return;
}
```

#### 4b. Status aggregation

```js
function updateAggregatedStatus() {
  const total = instances.size;
  const statuses = [...instances.values()].map(inst => inst.getStatus());
  const healthy = statuses.filter(s => s.healthy).length;
  if (healthy === total) {
    app.setPluginStatus(`${total} connection(s) active`);
  } else {
    const details = [...instances.values()]
      .filter(inst => !inst.getStatus().healthy)
      .map(inst => `${inst.getId()}: ${inst.getStatus().text}`)
      .join("; ");
    app.setPluginStatus(`${healthy}/${total} active — ${details}`);
  }
}
```

---

### Phase 5 — REST API Routes Redesign (`lib/routes.js`)

#### 5a. New route structure

```
Existing (kept for backward compat, maps to first instance or instance "default"):
  GET  /metrics
  GET  /network-metrics
  GET  /paths
  GET  /monitoring/alerts
  ...

New per-instance routes:
  GET  /connections                              list all instances + status
  GET  /connections/:id/metrics
  GET  /connections/:id/network-metrics
  GET  /connections/:id/paths
  GET  /connections/:id/monitoring/alerts
  GET  /connections/:id/packet-loss
  GET  /connections/:id/retransmissions
  GET  /connections/:id/path-latency
  GET  /connections/:id/congestion
  GET  /connections/:id/bonding
  POST /connections/:id/bonding/failover
  GET  /connections/:id/config/:filename
  POST /connections/:id/config/:filename
  GET  /connections/:id/inspector
  GET  /connections/:id/capture
  GET  /connections/:id/prometheus
  GET  /connections/:id/delta-timer
```

#### 5b. `createRoutes` signature change

```js
// current:
function createRoutes(app, state, metricsApi, pluginRef)

// new:
function createRoutes(app, instanceRegistry, pluginRef)
// instanceRegistry = { getAll(), get(id), getFirst() }
```

The `instanceRegistry.getFirst()` powers the backward-compat root-level routes.
Per-instance routes call `instanceRegistry.get(req.params.id)` and 404 if not found.

#### 5c. `GET /connections` response

```json
[
  {
    "id": "shore-server",
    "name": "Shore Server",
    "type": "server",
    "port": 4446,
    "protocol": 2,
    "status": "Server listening on port 4446",
    "healthy": true
  },
  {
    "id": "sat-client",
    "name": "Sat Client",
    "type": "client",
    "server": "satcom.example.com:4446",
    "protocol": 2,
    "status": "Connected",
    "healthy": true
  }
]
```

---

### Phase 6 — Signal K Path Namespacing (`lib/metrics-publisher.js`)

Currently all metrics publish to `networking.edgeLink.*`. With multiple instances,
each instance must publish to its own namespace.

#### 6a. `MetricsPublisher` gets an `instanceId` config option

```js
class MetricsPublisher {
  constructor(app, config = {}) {
    this.prefix = config.instanceId
      ? `networking.edgeLink.${config.instanceId}`
      : "networking.edgeLink";
    // ... rest unchanged
  }
}
```

All `push({ path: "networking.edgeLink.rtt", ... })` calls become
`push({ path: `${this.prefix}.rtt`, ... })`.

Affected paths (full list):
- `networking.edgeLink.rtt` → `networking.edgeLink.{id}.rtt`
- `networking.edgeLink.jitter`
- `networking.edgeLink.packetLoss`
- `networking.edgeLink.linkQuality`
- `networking.edgeLink.retransmissions`
- `networking.edgeLink.queueDepth`
- `networking.edgeLink.deltasSent`
- `networking.edgeLink.deltasReceived`
- `networking.edgeLink.bandwidth.rateOut`
- `networking.edgeLink.bandwidth.rateIn`
- `networking.edgeLink.bandwidth.compressionRatio`
- `networking.edgeLink.remoteClient.*` (server side)

Also update `publishRtt()` in `index.js` (will move to instance factory):
- `networking.modem.rtt` stays as-is (single system metric, not per-instance).

#### 6b. Alert/notification namespacing (`lib/monitoring.js`, `lib/bonding.js`)

`AlertManager` and `BondingManager` publish Signal K notifications under
`notifications.signalk-edge-link.*`. Namespace these too:

```
notifications.signalk-edge-link.{instanceId}.lossAlert
notifications.signalk-edge-link.{instanceId}.bondingFailover
```

Pass `instanceId` into these constructors.

---

### Phase 7 — Feedback Filter Update (`filterOutboundDelta`)

The existing filter blocks paths starting with `networking.edgeLink.` and
`notifications.signalk-edge-link.`. Since all instances still publish under those
prefixes (just deeper), the existing filter is sufficient — no change needed.

---

### Phase 8 — Pipeline V2 Server: Multi-Client Tracking

Currently `pipeline-v2-server.js` tracks ACK state for a single client:

```js
let lastClientAddr = null;
let lastClientPort = null;
```

When a second client connects to the same server port, this overwrites the first
client's address. For **a single server port**, supporting multiple clients
simultaneously requires per-client ACK state.

#### 8a. Per-client session map in `pipeline-v2-server.js`

```js
// Replace single-client vars with a Map keyed by "addr:port"
const clientSessions = new Map();
// { [key]: { addr, port, sequenceTracker, lastAckSeq, lastNakSent, ... } }
```

For each incoming packet, look up or create the session by `${rinfo.address}:${rinfo.port}`.

ACK/NAK replies are sent back to the specific client's address/port.

Idle sessions are expired after a configurable TTL (default: 5 minutes without any
packet from that client).

#### 8b. Session expiry

```js
function expireIdleSessions(ttlMs = 300000) {
  const now = Date.now();
  for (const [key, session] of clientSessions) {
    if (now - session.lastPacketTime > ttlMs) {
      session.sequenceTracker.reset();
      clientSessions.delete(key);
      app.debug(`[v2-server] Session expired: ${key}`);
    }
  }
}
// Run every 60 seconds via setInterval stored in state
```

#### 8c. Metrics per client session

Server metrics are currently global. With multiple clients, track per-client:

```js
session.metrics = {
  packetsReceived: 0,
  lostPackets: 0,
  acksSent: 0,
  naksSent: 0,
  lastRtt: 0
};
```

The REST API `GET /connections/:id/network-metrics` for a server returns an array
of connected client sessions.

---

### Phase 9 — Webapp UI Update (`src/webapp/index.js` + React panel)

#### 9a. React config panel (`src/components/PluginConfigurationPanel.jsx`)

Replace the flat form with an array editor:
- Render a list of connection cards (collapsed/expanded)
- "Add Connection" button appends a new item with defaults
- "Remove" button removes an item (with confirmation if started)
- Each card shows: name, type badge (SERVER/CLIENT), port, protocol version badge
- Error indicators if validation fails (duplicate ports, missing secretKey, etc.)

#### 9b. Webapp status page (`src/webapp/index.js`)

Replace single-instance panel with tabbed/accordion layout:
- Tab bar or accordion with one tab per connection
- Tab title shows: name + status dot (green/red/yellow)
- Selecting a tab loads metrics/config for that instance via `/connections/:id/...`
- A "Summary" tab shows all instances in a table

---

### Phase 10 — Tests

#### 10a. Update existing tests

All unit tests that instantiate sub-modules directly are unaffected (they already
pass `state` and `metricsApi` directly).

Tests that call `plugin.start(options)` (integration tests) need updating:
- Wrap the flat options in `{ connections: [options] }` OR keep legacy path coverage.

#### 10b. New tests

**`__tests__/instance.test.js`**:
- Create two client instances, verify each has independent state
- Create two server instances on different ports, verify both bind
- Start then stop one instance, verify other continues
- Verify duplicate server port detection

**`__tests__/multi-instance-integration.test.js`**:
- Two clients sending to one server (two independent logical flows via v1/v2)
- One server + one client in same process (loopback scenario)
- Config file namespacing (instance A's subscription.json ≠ instance B's)

**`__tests__/v2/multi-client-server.test.js`**:
- Multiple clients connecting to one v2 server instance
- Verify per-client session map (ACK sent back to correct client addr)
- Session expiry for idle clients

**`__tests__/schema-compat.test.js`**:
- Legacy flat config wrapped correctly into `connections[0]`
- Array config with 3 items parsed correctly
- instanceId slugification (spaces → hyphens, collision disambiguation)

---

## 4. File Change Summary

| File | Change Type | Description |
|---|---|---|
| `index.js` | **Major refactor** | Becomes thin coordinator; most logic moves to `lib/instance.js` |
| `lib/instance.js` | **New file** | Instance factory with isolated state, lifecycle, config watchers |
| `lib/routes.js` | **Major refactor** | Add per-instance routing; accepts instance registry |
| `lib/metrics-publisher.js` | **Modify** | Add `instanceId` prefix support to all published paths |
| `lib/pipeline-v2-server.js` | **Modify** | Replace single-client ACK state with per-client session Map + expiry |
| `lib/monitoring.js` | **Modify** | Pass `instanceId` to `AlertManager` for namespaced notifications |
| `lib/bonding.js` | **Modify** | Pass `instanceId` for namespaced failover notifications |
| `src/components/PluginConfigurationPanel.jsx` | **Major refactor** | Array editor UI |
| `src/webapp/index.js` | **Major refactor** | Tabbed/accordion multi-instance UI |
| `__tests__/instance.test.js` | **New file** | Instance isolation tests |
| `__tests__/multi-instance-integration.test.js` | **New file** | Multi-instance integration tests |
| `__tests__/v2/multi-client-server.test.js` | **New file** | Multi-client v2 server tests |
| `__tests__/schema-compat.test.js` | **New file** | Schema backward compat tests |
| Existing `__tests__/*.test.js` | **Minor updates** | Wrap options in `{ connections: [...] }` where needed |

---

## 5. Backward Compatibility Contract

1. **No config migration required** for existing single-instance deployments.
2. Legacy flat `options` object (with `options.serverType` at root) is automatically
   wrapped as `[{ ...options, name: "default" }]`.
3. All existing REST API routes (`/metrics`, `/bonding`, etc.) continue to work,
   resolving to the `"default"` instance (or first instance if no default exists).
4. Config files in `{dataDir}/` root are migrated on first start to
   `{dataDir}/instances/default/` automatically (copy, not move, so rollback is safe).
5. Signal K paths `networking.edgeLink.*` (without instance prefix) are aliased from
   `networking.edgeLink.default.*` for the default instance so existing dashboards
   keep working.

---

## 6. Sequencing / Implementation Order

1. **Phase 2** (instance factory) — core isolation building block; nothing else can
   proceed without it.
2. **Phase 3** (config namespacing) — required before instance factory is usable.
3. **Phase 4** (coordinator) — wire everything together in `index.js`.
4. **Phase 1** (schema) — update schema once coordinator logic is in place.
5. **Phase 5** (routes) — update after coordinator exposes instance registry.
6. **Phase 6** (SK path namespacing) — update `metrics-publisher.js` and related.
7. **Phase 8** (multi-client server) — isolated change to `pipeline-v2-server.js`.
8. **Phase 7** (feedback filter) — verify no changes needed (confirm).
9. **Phase 10** (tests) — write/update all tests.
10. **Phase 9** (UI) — update webapp and React panel last.

---

## 7. Key Constraints and Risks

| Risk | Mitigation |
|---|---|
| **Port binding race**: two server instances start concurrently and both try the same port | Pre-flight port collision check in coordinator before starting any instance |
| **Memory growth**: N instances × monitoring data structures | Each `PacketLossTracker` uses ~2 KB; `PathLatencyTracker` ~10 KB; safe for N ≤ 20 instances |
| **Signal K path explosion**: many instances emit many paths | Namespace all paths; dashboard UIs query per-instance |
| **File watcher storms**: N clients each watch 3 files = 3N watchers | Node.js supports hundreds of watchers; no issue for N ≤ 20 |
| **Subscription callback cross-talk**: instance A's delta handler fires for instance B's data | Each instance has its own `state.unsubscribes` array; subscriptions are per-instance and independent |
| **Feedback filter gap**: multi-client metrics from `networking.edgeLink.conn-A.*` could be forwarded by conn-B | Extend `filterOutboundDelta` to block `networking.edgeLink.*` at all depths (already done) |
| **UI complexity**: editing an array of complex objects is hard in RJSF | Use RJSF's native array support (`type: "array", items: {...}`) which renders Add/Remove buttons automatically |
| **Breaking change to routes.js signature** | Keep `createRoutes(app, state, metricsApi, pluginRef)` signature working by wrapping in shim if needed |
