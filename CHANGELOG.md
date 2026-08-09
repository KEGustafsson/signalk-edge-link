# Changelog

All notable changes to signalk-edge-link are documented here.

## [4.1.0] - 2026-08-09

Correctness release from a full-codebase review. Three independent defects
could each stop a running link delivering data while the plugin still reported
healthy; all are fixed, with regression coverage.

### Fixed — data delivery

- **A client never re-handshook after the peer lost its session.** The HELLO
  handshake latched on first acknowledgement and nothing re-armed it. After a
  server restart (its epoch and replay-guard state gone) or a NAT/CGNAT source-
  port rebind, the server refused every DATA packet and therefore never sent the
  ACK that would have signalled trouble — so the link stayed dead until the
  client process restarted. The client now re-runs the handshake after
  `HELLO_REHANDSHAKE_ACK_IDLE_MS` (30 s) of ACK silence with packets
  outstanding.
- **A full-status replay delivered nothing for the paths it exists to restore.**
  The client's value-dedup and path-throttle state was never cleared, so a
  restarted server asking for a full replay received sentinels it had no
  baseline to expand (and dropped them) plus values the throttle discarded.
  Both are now reset on `FULL_STATUS_REQUEST`.
- **A lost packet could pin the receiver to a stale value indefinitely.**
  Value-dedup marked a value delivered at send time, so any packet that never
  arrived left the two caches disagreeing — and the sender had no reason to send
  an absolute again. The sender now resyncs whenever a queued packet leaves the
  retransmit queue unacknowledged (eviction, abandonment, age expiry) or a send
  throws after dedup, and the receiver ignores absolute values from a sequence
  older than the one that last wrote the path, so reordering cannot roll its
  cache backwards.
- **Server socket recovery built a second pipeline.** A transient interface
  fault left the original pipeline stranded with its sessions, epochs, replay
  guards and armed NAK timers, while its replacement started empty — dropping
  every existing peer back to the un-enforced anti-replay path. Recovery now
  re-attaches the existing pipeline to the new socket.

### Fixed — packaging

- `signalk.appIcon` restored to `./public/icons/icon-72x72.png`. The 4.0.3 fix
  was reverted in 4.0.4 (to a malformed `.icons/...`) and again in 4.0.5 (back
  to the pre-fix `./icons/...`), neither of which shipped a changelog entry at
  the time. `files` publishes `public/`, so the App Store
  listing had fallen back to the monogram icon again.
- `npm audit` now also covers devDependencies that webpack bundles into the
  published `public/` directory — `@rjsf/validator-ajv8` pulls `ajv` and
  `fast-uri` into the shipped browser bundle, where `--omit=dev` could not see
  them. `fast-uri` is pinned to `^3.1.5` to clear three high-severity
  host-confusion advisories that were reaching operators' browsers.

### Fixed — security

- `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN` now takes precedence over the stored
  `managementApiToken`, as the docs and the configuration panel have always
  stated. Previously the stored option won, so the documented rotation
  procedure kept a leaked token live while rejecting its replacement.
- The rate limiter no longer keys on the client-supplied leftmost
  `X-Forwarded-For` entry. Behind a trusted proxy a caller could mint a fresh
  bucket per request, removing the only brake on management-token guessing and
  growing the rate-limit map without bound.
- Management authorization resolves the plugin config once per request. Three
  separate reads meant a config rewrite landing mid-request could satisfy the
  fail-closed probe and then degrade to open access.
- `requireManagementApiToken` now accepts the common truthy spellings
  (`"true"`, `"1"`, `"yes"`, `"on"`) instead of silently reading a hand-written
  string as "off".
- Control-packet source validation works on bonded links again: the real
  datagram source is forwarded instead of a synthesised one, which had made the
  off-path spoofing check pass unconditionally.

### Fixed — observability

- Bandwidth rate gauges no longer read ~0 B/s on a loaded link. Sampling is
  destructive, and both the 1 s pipeline timer and every HTTP scrape called it,
  so a scrape shortly after a tick divided a few milliseconds of traffic. Rates
  are now recomputed at most every 500 ms, and history points are appended on a
  fixed 5 s cadence so the 60-slot buffer really spans the documented 5 minutes.
- Alerts no longer flap. A metric hovering at its threshold produced a
  raise/clear pair every second because an absent active alert bypassed the
  cooldown; escalation to a higher severity is still reported immediately.
- `alert_<metric>` is published for every configured threshold metric, including
  0 when not alerting, so a cleared alert reads as green instead of "No data".
- Source-registry no-op detection works: the per-sample timestamp is excluded
  from the merge hash, so `noops` is no longer permanently 0 and the receive
  path stops reallocating a record per update.
- `updatesPerMinute` is computed over the window a path has actually been
  tracked, not process uptime — a path started a minute ago on a node up for a
  month no longer reports 0.
- `PathLatencyTracker` evicts least-recently-used rather than first-inserted, so
  the busiest paths keep their latency windows.

### Fixed — configuration and UI

- `epochBoundAuth` and `requestFullStatusOnRestart` are recognised as advanced
  settings, so a connection using them opens with the Advanced section expanded
  instead of claiming it is at defaults.
- `connectionId` is part of the connection schema, so connections authored in
  Signal K's built-in plugin UI get one. Renaming such a connection no longer
  fails redacted-secret restore.
- `schemaVersion` survives a save and is stamped by `migrate:config`, instead of
  being declared in the schema and dropped by every write.
- A 403 lockout surfaces the server's recovery instructions rather than
  "HTTP 403: Forbidden", and the delta-timer, sentence-filter and subscription
  cards surface the server's error message instead of a generic failure.
- An empty connection list is rendered as "no connections" instead of leaving
  stale tabs on screen polling dead instance IDs.
- `deltaTimer` is range-checked identically at startup, on file change and via
  the API; a hand-edited out-of-range value is rejected at boot rather than
  accepted and then reverted.

### Fixed — robustness

- `stop()` during client startup can no longer orphan a source-snapshot
  interval, and a stop during bonding initialisation no longer leaks sockets and
  a health-check timer.
- Per-IP session limit evicts that address's least-recently-used session instead
  of refusing the new one, so a client rotating source ports can handshake again
  immediately rather than waiting out the 5-minute idle TTL.
- Anti-replay window pruning is genuinely amortised; it previously scanned the
  whole window on every packet in the steady state.
- Path lookups on the dictionary, precision and throttle maps use own-property
  checks, so a Signal K path named after an `Object.prototype` member cannot
  produce a function or `NaN` on the wire.
- `MetaCache` is bounded like every sibling cache.

### Changed

- Coverage thresholds raised from 60–65% to 72–83%, matching what the suite
  actually delivers, so a real regression fails CI.
- `maxWorkers: 1` moved into the Jest config, so `test:watch` and a bare
  `npx jest` get the same serialisation as `npm test` instead of colliding on
  fixed UDP ports.

### Documentation

- Prometheus scrape config now shows the required bearer token, and the README
  states plainly that every route is protected — there is no open read-only
  subset once a token is set.
- `pathPrecision` and `pathThrottle` documented as exact-path maps, not globs,
  and `pathThrottle`'s example corrected to the rule-object shape the validator
  actually accepts.
- `useValueDedup`, `useCompactDeltas`, `POST /connections/:id/bonding/failover`
  and `GET /monitoring/simulation` documented; `retransmitRate` and
  `alert_<metric>` added to the metrics reference.
- Stale module paths in `AGENTS.md` and `docs/GUIDE.md` updated to the current
  layout.

## [4.0.5] - 2026-08-08

Packaging only. No runtime, protocol, schema or UI change.

### Changed

- Version bump. **Note:** this release also changed `signalk.appIcon` back to
  `./icons/icon-72x72.png`, undoing the 4.0.3 fix. Corrected in 4.1.0.

## [4.0.4] - 2026-08-08

Packaging only. No runtime, protocol, schema or UI change.

### Changed

- Version bump. **Note:** this release changed `signalk.appIcon` to a malformed
  `.icons/icon-72x72.png`. Corrected in 4.1.0.

## [4.0.3] - 2026-08-02

Packaging only. **No runtime, protocol, schema or UI change** — `lib/` and
`public/` are byte-for-byte what 4.0.2 shipped.

### Fixed

- `signalk.appIcon` pointed at `./icons/icon-72x72.png`, a path that has never
  existed in the published tarball (the icon ships at `./public/icons/`). The
  Signal K App Store fetches it from the tarball directly, so the listing
  fell back to the monogram icon. Corrected the path to
  `./public/icons/icon-72x72.png`.
- `signalk.screenshots[0]` referenced a `raw.githubusercontent.com` URL
  instead of a path inside the published package, and the file it pointed at
  (`docs/`) isn't part of the tarball (`files` in `package.json`) anyway.
  Added `docs/assets/edge-plugin-config.jpg` to `files` and changed the entry
  to the relative path `./docs/assets/edge-plugin-config.jpg`, matching how
  the App Store resolves plugin assets.

## [4.0.2] - 2026-08-02

Packaging only. **No runtime, protocol, schema or UI change** — `lib/` and
`public/` are byte-for-byte what 4.0.1 shipped.

### Changed

- `CHANGELOG.md` is now included in the published npm tarball (`files` in
  `package.json`), so it ships alongside the installed plugin instead of only
  being visible on GitHub.
- Added a `signalk.screenshots` entry to `package.json` so the Signal K App
  Store can show a configuration screenshot on the plugin's listing page.

## [4.0.1] - 2026-08-02

Test-suite and documentation only. **No runtime, protocol, schema or UI change**
— `lib/` and `public/` are byte-for-byte what 4.0.0 shipped, so upgrading is
optional and changes nothing on a running link.

The Signal K App Store's "Plugin test suite" indicator reported FAIL for 4.0.0.
The plugin registry runs a plugin's own suite in a network-isolated sandbox,
and two tests could not survive that environment. Both are fixed here.

### Fixed

- **`npm audit` test failed with no network.** The suite audits its runtime
  dependency tree, which needs the npm registry. Offline, `npm audit --json`
  exits non-zero but still prints JSON on stdout — an error envelope rather
  than a report — so it parsed cleanly and then failed the assertion on
  `metadata.vulnerabilities`. A payload without that field is now classified as
  "report unavailable" (warn, don't fail), matching how the suite already
  treated a missing or unparseable report. The audit is also skipped outright
  when the harness marks the run as sandboxed, rather than paying for a lookup
  that cannot succeed.
- **Link-flapping test was timing-fragile.** It sampled link state at fixed
  offsets against a 50 ms/50 ms flap, leaving milliseconds of slack against
  `setTimeout` drift, and failed on a loaded runner. It now polls for each
  transition, treating the timeout as a ceiling on a stall rather than a
  schedule the link must keep.

### Documentation

- `.github/workflows/plugin-test.yml` records that the plugin registry reads
  the `test-command` declared there and runs it sandboxed, so the constraint is
  visible where the command is chosen.
- `.planning/codebase/TESTING.md` gains a section on keeping `npm test`
  hermetic: loopback-only networking, bounded runtime, no wall-clock schedules,
  and self-skipping for tests that genuinely need the network.

## [4.0.0] - 2026-07-31

Fixes every finding from the multi-aspect review in
`.planning/reviews/2026-07-26-code-review.md` (security, protocol reliability,
lifecycle, web UI, test quality, configuration parity, hot-path performance),
plus a series of defects found by running the plugin on a real
client → proxy → server link. Those were almost all in the observability
layer — figures the UI invented rather than measured, and error messages that
named the wrong cause — and they are called out individually below.

**The wire format is unchanged** — the conformance vectors regenerate
byte-identical, so a 4.0.0 peer interoperates with a 3.x peer on the UDP link.
The major bump reflects the behaviour changes below, not a protocol break.

### Breaking changes

Each corrects behaviour that was documented or implied but never actually
implemented. None removes a working feature, and none requires a coordinated
upgrade of both peers.

- **Sender-only options are stripped from SERVER connections on load.**
  `pathFilter`, `pathPrecision`, `pathThrottle`, `brotliQuality`,
  `useValueDedup`, `useCompactDeltas` and `heartbeatInterval` were accepted,
  persisted and rendered in the UI for server connections, but no server code
  path has ever read them — the receiver auto-detects the wire encoding. A
  server that carried them behaves identically after upgrading; they simply
  stop appearing in the configuration form.

  _Why this is breaking:_ an operator who set `pathFilter` on a server
  connection believing it filtered inbound data will now see that setting
  disappear rather than silently do nothing. If you were relying on any of
  these, set them on the **client** (sending) side, which is where they take
  effect.

- **DATA arriving on an unhandshaked source port of an already-handshaked peer
  address is rejected.** This closes a replay bypass (see Security below). A
  conforming client always completes a HELLO handshake before sending DATA, and
  HELLO is now retried with backoff until confirmed, so only replayed or
  spoofed traffic is affected.

  _Why this is breaking:_ a non-conforming sender that transmits DATA without
  ever completing a handshake — or that changes source port mid-stream without
  re-announcing — will now have those packets dropped instead of accepted.
  No first-party client does this.

- **Network-quality fields may be absent, not zero.** `packetLoss`,
  `retransmissions`, `queueDepth`, `retransmitRate` and `activeLink` join
  `rtt`, `jitter` and `linkQuality` in being **omitted** rather than reported
  as `0` (or `"primary"`) when the peer never reported them. A server derives
  these from client telemetry, and a peer that reports some fields and not
  others — an older build, or a value the ingest validator rejected — must not
  have its silence rendered as a measurement. Consumers should treat absence as
  "no data"; a `0` now means a measured zero. `linkQuality` is withheld unless
  all four of its scoring inputs are present, since a substituted zero can only
  inflate the score.
- **`maxNakRounds` moved from the client to the server reliability schema.** It
  is receiver-side, connection validation only ever accepted it in server mode,
  and no client code path read it — so setting it on a client saved
  successfully and did nothing. Existing server configurations are unaffected.

### Added

- **Epoch-bound packet authentication (`epochBoundAuth`, opt-in, default off).**
  Binds each packet's HMAC tag to the connection epoch established in the HELLO
  handshake, so a captured packet only authenticates inside the epoch it was
  sent in.

  This closes the last replay residual. Anti-replay enforcement arms only once
  a peer completes a handshake, so a packet replayed from a source address the
  receiver has never seen lands on a freshly-created guard with epoch 0 — there
  is nothing to enforce against. Keying guards per address closes source-port
  rotation but cannot close source-IP spoofing; epoch binding does, because the
  receiver has no valid epoch to verify such a packet against. It also expires
  captures across a peer restart, since the epoch advances.

  Uses flag bit 5 (`EPOCH_BOUND_AUTH`) and adds no bytes on the wire. The flag
  sits inside the HMAC-covered header, so it cannot be stripped to force a
  downgrade. HELLO is exempt — it is the packet that establishes the epoch.

  **Both ends must enable it and both must run 4.0.0 or later**; an older peer
  computes the tag without the epoch, so every packet would fail
  authentication. Left off by default so mixed fleets keep working during a
  rolling upgrade — enable it once every vessel is on 4.x. Requires
  `authenticatedHeaders` and protocol v3, both enforced by config validation.
  See `docs/protocol-v3-spec.md` §5.1.

- **Observability counters.** `GET /metrics` now exposes, under `stats`:
  `replayedPackets` (datagrams the anti-replay guard refused — the only
  external evidence the mechanism fired), `epochAuthMismatches` and
  `epochAuthPending` (see Security), `fullStatusCascadeFired`,
  `snapshotReplayDeltas`, `processDeltaCalls` and `deltasBufferHighWaterMark`
  (peak outbound buffer depth — the backpressure signal that precedes
  `droppedDeltaBatches`). Several were counted since the beginning and read by
  nothing, which made the conditions they record undiagnosable from outside the
  process.

### Security

- **Anti-replay could be bypassed by rotating the source port.** The per-peer
  replay guard was keyed on `address:port`, so a datagram from an unseen port
  got a fresh guard whose empty window accepted every sequence and whose epoch
  of 0 disabled enforcement outright. A captured DATA datagram could therefore
  be replayed verbatim from any other port — while the legitimate session was
  still live — re-injecting a stale position or depth into the Signal K tree.
  Handshaked source addresses are now tracked, and DATA arriving on an
  unhandshaked port of a known address fails closed. Guards remain per-port so
  multiple clients behind one NAT keep independent sequence windows.
- **With bonding enabled, anti-replay was inert and client telemetry was
  silently dropped.** Bonding was initialised _after_ the first HELLO, so HELLO
  left on the plain socket while all DATA left on the bonding link's port; the
  data-carrying session never handshaked. Bonding is now initialised first, and
  HELLO is re-sent on failover/failback, which move the source port again.
- **Control packets were accepted from any source address, and the NAK source
  doubled as the retransmit destination.** A spoofed NAK naming 256 sequences
  turned a client into a ~290x reflector, and a replayed ACK could suppress
  loss recovery indefinitely. Control packets are now restricted to configured
  peer addresses and always sent to the configured destination.
- **HELLO is retried with exponential backoff** until a control packet confirms
  the handshake. Previously a single lost datagram left the session
  unhandshaked for its lifetime.
- **Bodyless mutating POSTs** (`/capture/start`, `/capture/stop`,
  `/bonding/failover`, `/connections/:id/bonding/failover`) now reject
  cross-site form submissions. Under the documented open-access default, any
  page an operator visited could previously trigger them.
- **An `epochBoundAuth` mismatch reported itself as a key problem.** A receiver
  that requires epoch binding refuses packets from a sender that does not bind,
  and refused them as `"v2 authentication failed: packet tampered or wrong
key"` — sending an operator after a key mismatch that did not exist. The two
  distinct causes are now reported separately, because they point at different
  machines: `EPOCH_BOUND_AUTH flag not set` is a real configuration mismatch
  (counted in `stats.epochAuthMismatches`, logged naming the setting), while
  `requires an established peer epoch` means the sender **is** binding but no
  HELLO has established its epoch yet — the ordinary startup window, which
  clears itself (counted in `stats.epochAuthPending`, logged at debug).
- **The interop direction reported the same condition as a key-format
  mismatch.** When the sender bound an epoch, the receiver did not require
  binding, and the receiver held no epoch for that source, the tag was verified
  against a value the sender never used. That can never match, so it surfaced
  as `"(possible stretchAsciiKey or key-format mismatch between peers)"`. Both
  directions now raise the same specific error; behaviour is unchanged, the
  reported reason is now the real one.
- **`epochBoundAuth` is asymmetric, and this is now documented.** Enforcement
  lives in the receiver: with it on at the sender and off at the receiver the
  link keeps working while providing none of the protection it was enabled for.
  `docs/security.md` carries the four-way table.

### Reliability

- A permanently lost sequence pinned `expectedSeq` for up to 1025 packets:
  frozen cumulative ACK, endless NAK re-emission, and no further RTT samples.
  NAK rounds per sequence are now bounded and the window advances past a gap
  the sender can no longer fill.
- A failed UDP send consumed the sequence number without queueing the packet,
  creating a hole the client could never fill. Packets are now enqueued before
  sending.
- The retransmit queue assumed Map insertion order equals sequence order, which
  concurrent sends and UDP retries violate.
- Loss accounting recorded one sample per retransmitted packet into a 50-slot
  window, so a single burst reported 100% loss and walked the delta timer to
  its 5s ceiling for minutes. One sample per loss event is now recorded.
- The recovery burst defaulted to 500 packets/s against a receiver budget of
  200/s; it is now clamped to half the receiver's budget.
- Retransmit abandonment and receive-side gap abandonment are now counted and
  logged instead of being silent.
- **Jitter was reported as a hard 0 ms on every stable link.** RTT was sampled
  as a `Date.now()` difference, which has whole-millisecond resolution, so on a
  stable link every sample was the same integer, the variance across them was
  exactly 0, and no amount of rounding could recover it. Samples now come from
  a monotonic high-resolution clock (`performance.now()`, stored as `sentAtHr`
  on the queue entry). `originalTimestamp` stays on `Date.now()`, since
  age-based eviction wants wall-clock time.
- **`skipOwnData` stripped everything but RTT from client telemetry.** A server
  therefore saw a real round trip from its client and 0 ms jitter beside it —
  the jitter was never sent, and the receiver substituted 0 for it. The setting
  means "do not forward my own `networking.edgeLink.*` paths as ordinary data",
  which is not what this dedicated, source-labelled telemetry is; the receiver
  consumes it rather than dispatching it, so there is no loop to prevent. The
  whole quality set is now sent.
- **Client telemetry published a seeded `rtt: 0` before any ACK was timed.**
  `metrics.rtt` is seeded to `0`, not undefined, so the peer received a 0 ms
  round trip it could not distinguish from a measured one. `rtt` and `jitter`
  are now omitted until `rttSamples` shows a real sample; a measured zero is
  still sent.
- **Instance-scoped telemetry paths were discarded.** A multi-connection or
  proxy deployment publishes link telemetry under
  `networking.edgeLink.<instanceId>.*`, and the receiver matched only the bare
  prefix — so a proxy's server showed N/A for every network-quality field while
  its client looked healthy. The instance segment is now resolved, and the
  unscoped form still works.
- Late retransmissions arriving after the window advanced were dispatched a
  second time, re-injecting a stale delta.
- Metadata/source-snapshot chunk dedup tracked only the newest envelope, so one
  ordinary UDP reordering permanently dropped a straggling chunk.
- Server-mode socket errors were terminal; a transient interface flap killed
  the listener for the process lifetime. Server mode now recovers with backoff,
  keeping `EADDRINUSE`/`EACCES` fatal.
- **A restarted peer's new sequence stream could be silently dropped.** An
  epoch increase re-baselined the anti-replay window but not the session's
  sequence tracker, so when the peer's fresh random initial sequence landed
  below the previous stream (and within the resync threshold) every packet was
  classified as a late arrival — correctly not re-dispatched, and therefore
  lost. Peer-restart detection now resets the session's sequence and loss state
  too.

### Lifecycle

- `stop()` during an in-flight `start()` could start the remaining instance
  group _after_ teardown, leaving live sockets and timers with no registry
  entry and no way to stop them.
- `start()` ignored an invalid FSM transition and leaked a dedupe-cleanup
  interval on every repeated start.
- `startClient()` allocated timers and sockets after awaits with no shutdown
  guard; keepalive and heartbeat intervals now self-clear if they observe a
  stopped instance.
- The delta timer only set a flag and never flushed, so the tail of a burst sat
  in the buffer until the next inbound delta — indefinitely if the source went
  quiet. This now matches documented behaviour.
- A dead send path reported as _healthy_, because health was inferred from
  status text and "UDP socket not initialized - cannot send data" matched none
  of error/fail/stopped.
- A subscription retry succeeding during socket recovery re-opened the send
  gate, overflowing a buffer that could not drain (50% discarded per overflow).
- A transient read error on `subscription.json` fell back to
  `subscribe: [{path: "*"}]`, which could silently switch a metered link to the
  full Signal K firehose. The fallback now applies only to a genuine ENOENT.

### Web UI

- **Absent network-quality values render as `N/A`, not `0`.** `?? 0` at the
  display layer would have put the invented number straight back on screen one
  layer below the API fix. A reported zero still renders as zero.
- **Monitoring & Alerts showed permanent zeros.** The card read `lossRate` and
  the retransmission counters from the top level of the response, while the
  producers emit `overallLossRate` and place the counters under `summary`. Every
  read resolved to `undefined` and rendered as `0` — a stalled panel rather than
  a visibly broken one. Because every field is optional, TypeScript could not
  catch it; the `MonitoringData` type described the card's assumption rather
  than the API.
- **Rejected control packets are always shown on a client, and count as an
  error.** The counter is the explanation for a client that sends into a void:
  no RTT timed, cumulative ACK frozen, queue depth climbing. It previously had
  no reader at all, and once shown did not feed the card's own verdict, so the
  card could display a red row and "No errors detected" together.
- Switching connection tabs could display the previous connection's config and
  **save those values to the newly-selected connection's file**.
- v3 monitoring, congestion and bonding cards were fetched once and never
  refreshed, so bonding "Active Link", per-link RTT/loss and Active Alerts sat
  frozen while the metrics card advertised a 15s refresh.
- Metrics polling swallowed every failure including 401, leaving a dashboard
  stuck on "Loading metrics…" with no notification.
- Server connections never fetched monitoring data at all, so the alerts card
  could not render.
- `SubscriptionCard` silently discarded per-path `period`/`minPeriod`/`policy`/
  `format` on save, and the JSON editor re-serialized the textarea mid-edit.
- The "Advanced settings" disclosure never engaged, because a materialized
  schema default (`authenticatedHeaders: true`) was read as operator intent.
- Toggling server↔client dropped six common settings.
- Accessibility: connection card headers are keyboard-operable, notifications
  are announced, tabs expose `tablist`/`tab`/`aria-selected`, JSON textareas
  are labelled.

### Configuration and documentation

- **`udpMetaPort` was documented across six files but does not exist in the
  code**, so v1 metadata transport was documented as available while being
  permanently unreachable. Removed; metadata requires v3.
- **`protocolVersion` was documented as defaulting to 3** in `docs/GUIDE.md`
  and in the TypeScript JSDoc, while the schema and runtime use 1 — a user
  following the guide silently got basic v1.
- `heartbeatInterval`'s documented range contradicted the enforced minimum, so
  a doc-following config was rejected on save.
- Seven sender-only options (`pathFilter`, `pathPrecision`, `pathThrottle`,
  `brotliQuality`, `useValueDedup`, `useCompactDeltas`, `heartbeatInterval`)
  were accepted and persisted on server connections that never read them — an
  operator could set `pathFilter` on a server and reasonably believe inbound
  data was filtered. They are now client-only in both schema builders and are
  stripped from server configs on load.
- `brotliQuality` was schema type `number` but validated as an integer, so the
  UI accepted `6.5` and the save failed.
- Documented `brotliQuality`, `pathFilter`, `pathPrecision` and `pathThrottle`,
  which were implemented and rendered in both UIs but documented nowhere.
  `pathPrecision` is lossy and now says so.
- Config migration validated before sanitizing — the inverse of startup order —
  so a legacy `protocolVersion: 2` config carrying v1-only ping fields threw in
  `npm run migrate:config` while loading fine at runtime.
- Removed `samples/v2-with-bonding.json` (removed protocol v2, superseded by
  the v3 equivalent).

### Performance

- The source registry ran a recursive canonicalization, a `JSON.stringify` and
  a SHA-256 per _received update_ — roughly 10us each, ~8% of an ARM gateway
  core at 1000 deltas/s — and discarded essentially all of it.
- The delta sanitizer allocated arrays before its unchanged early-return, on a
  path that runs twice per outbound delta.
- `extractLiveMeta` compiled a RegExp per delta, and `resolveSelfContext` was
  re-resolved (and could log) per delta.

### Tooling

- **`npm audit` now covers runtime dependencies only** (`--omit=dev`). Build and
  test tooling never reaches an operator — the package publishes `lib/` and
  `public/` only — so a dev-tree advisory no longer fails `npm test`. Dev
  advisories remain visible in the non-blocking CI audit job. Also fixed a
  double-count that summed `metadata.total` alongside the severity buckets, and
  an unreachable registry that read as zero vulnerabilities instead of being
  reported.
- Bumped the `js-yaml` override 4.2.0 → 4.3.0; the pin had become the advisory
  it was meant to avoid.

### CLI

- Added a 30s request timeout; a host that accepted but never answered blocked
  the CLI forever.
- `instances show --format=json` printed a one-element array despite
  documenting "print one instance".
- `--limit`/`--page` accepted `12abc` as `12`.

### Tests

- Added a route auth-coverage gate running every registered route's full
  middleware chain: 37 of 43 routes were guarded only by middleware that every
  route-module test stubbed to a pass-through, so removing a guard left the
  suite green.
- Added a real DATA round-trip through the shipped pipelines across six codec
  combinations; the pre-existing "e2e" suites reimplement the wire path.
- Fuzz tests asserted inside `catch` blocks — including the AES-GCM bit-flip
  test — so they passed when the parser stopped throwing at all.
- Added direct coverage for client socket recovery, client control-request
  dispatch, server packet-loss aggregation (including uint32 wraparound), and
  real heartbeat timer behaviour.
- Converted the NAK-timing tests from real sleeps with ~20ms margins to fake
  timers.
- Added a real-socket configuration matrix. Every defect reported from a
  running link was invisible to this suite for one of two reasons: the harness
  erased what broke (in-process suites pipe bytes between pipelines and hand
  the receiver a synthetic `rinfo`, removing DNS and the kernel's view of a
  datagram's source — where the hostname peer check lives), or the assertion
  checked shape rather than justification (`linkQuality` is a number, while the
  number was invented). The new suite binds real UDP sockets, configures peers
  by hostname, varies the options that ship, and asserts `GET /metrics` — the
  JSON the web UI renders — across seven single-hop configurations, the
  telemetry round trip including the cold state where absent must stay absent,
  instance-scoped telemetry as an interop contract, a two-hop proxy chain, and
  an `epochBoundAuth` mismatch asserted on the diagnosis rather than the
  refusal.
- Added a counter-reachability sweep: every numeric counter the registry
  defines must be readable from some endpoint or named as deliberately
  internal. It found eight counters that were defined, incremented, and exposed
  by nothing.
- Added a telemetry contract test pinning that every path the publisher emits
  is either ingested by the receiver or listed as deliberately local, so a new
  metric cannot be silently dropped on the wire.
- Two existing tests had pinned defects as intended behaviour and were
  corrected: one asserted that `skipOwnData` leaves only RTT in client
  telemetry, and one asserted `rtt: 0` for an unmeasured link, contradicting
  the documented response shape.

## [3.1.0] - 2026-07-02

### Fixed

- **Self-context resolution.** `resolveSelfContext` no longer produces a
  double-prefixed `vessels.vessels.urn:...` context on a real server, which
  had caused live `vessels.self` meta to be shipped under a context that
  never matched snapshot cache keys.
- **Async subscription errors no longer pause an instance forever.** The
  `errorCallback` passed to `app.subscriptionmanager.subscribe()` can fire
  asynchronously after `subscribe()` returns; both subscribe call sites now
  share a generation-guarded handler that arms the existing retry loop, with
  escalating backoff (5s → ... → 5min) for persistently erroring
  subscriptions and no interference from torn-down generations.
- **`plugin.start()` rejections are now caught and reported** via
  `app.error` + `setPluginError` instead of surfacing as an unhandled
  promise rejection in the server process.
- Hard failure states (config validation, duplicate ports, no connections,
  startup failure, all-connections-down aggregation) now route through
  `setPluginError`/`setProviderError` so the admin UI reflects plugin
  errors, falling back to `setPluginStatus` on older servers.
- `handleMessage` receiver dispatch now passes `"signalk-edge-link"` as the
  `providerId` instead of `""`, fixing unattributed `skserver-raw` data-log
  lines.
- `reportOutputMessages` now receives the real coalesced delta count so the
  server Dashboard write rate is accurate.
- The v1 pipeline is now constructed with the per-instance `appProxy`,
  matching v2/v3, so its status writes update instance status instead of
  overwriting the plugin-level status line.
- `mergeSourceSnapshot` now detects (once) when `app.signalk.retrieve()`
  stops returning a live tree reference and logs an explicit error instead
  of silently losing `/sources` merges.

## [3.0.0] - 2026-06-26

### Security

- **DATA anti-replay window (v3).** The server now keeps a per-peer sliding
  replay window (high-water mark + recently-seen sequences) that **survives
  session idle expiry and eviction**, closing the replay vector where a captured
  DATA datagram could be re-injected after the live session state was gone. The
  window is reset only on a strictly higher **connection epoch** advertised in
  the client's HMAC-authenticated HELLO, distinguishing a legitimate restart
  from a replayed HELLO. No per-packet wire change (the epoch is an optional
  HELLO field); pre-H3 peers are unaffected. Rejections are counted as
  `replayedPackets`. Cross-epoch replay (~1e-6) and the post-server-restart race
  remain documented residuals — see `docs/security.md`.

### Breaking changes

- **Protocol version 3 is now the default wire format.** v2 peers (running
  signalk-edge-link < 3.0.0) can no longer exchange data with v3 peers unless
  both sides are upgraded. Mixed v1/v3 networks are not supported on the same
  connection — upgrade both ends together.

- **Automatic config coercion:** existing `protocolVersion: 2` connection
  configs are silently coerced to `3` on first start. No manual migration is
  required, but downgrading a peer back to 2.x will require setting
  `protocolVersion: 2` explicitly.

- **`authenticatedHeaders` now defaults to `true` (v3).** DATA/METADATA packet
  headers are authenticated with an HMAC tag by default, preventing on-path
  header tampering (e.g. sequence-number forgery). Two default-configured v3
  peers interoperate automatically. **Both ends must use the same setting** — to
  pair with a peer that cannot enable it, set `authenticatedHeaders: false` on
  both ends (restores the legacy CRC-only header). Adds 16 bytes/packet. See
  `docs/security.md`.

### Architecture

- **React 19 webapp rewrite.** The plugin configuration UI is now a modular
  React component tree (~3 000 lines added, 2 342-line vanilla-TS string
  engine removed). Features: multi-connection tab navigation, live metrics
  polling, subscription / delta-timer / sentence-filter editors, metadata
  streaming controls, bandwidth sparklines, path analytics, congestion-control
  and bonding dashboards.

- **Simplified connection configurator (progressive disclosure).** Each
  connection card now shows only the essential fields (name, mode, address,
  port, encryption key, protocol) by default; compression, reliability,
  bonding, congestion-control and per-path tuning are tucked behind a per-card
  "Advanced settings" toggle. The advanced section auto-expands for connections
  that already use those options, and collapsing it never discards configured
  values. Added an intro guidance line explaining the server/client choice and
  the must-match key/protocol requirement.

- **Layered source tree cutover.** All temporary re-export shims at
  `src/CircularBuffer.ts`, `src/config-io.ts`, `src/constants.ts`,
  `src/config-watcher.ts`, and `src/shared/crypto-constants.ts` have been
  deleted. Callers now import directly from the canonical foundation and
  application layers.

- **Security hardening (phase 6).** Explicit string aliases for protocol
  values, `DecryptError` typed exception, and key-mismatch diagnostics.

### Maintenance

- Fixed stale `publish-packages.yml` comment that incorrectly described the
  trigger as "on every push to main or dev" (actual trigger: `workflow_dispatch`).

### Security hardening

- **Management API:** logs an explicit open-access warning at startup when no
  `managementApiToken` is configured; `POST /plugin-config` now preserves the
  configured token / `requireManagementApiToken` when those fields are omitted
  from a request body (an incomplete write can no longer silently disable auth);
  auth telemetry is no longer exposed on `/status` and `/metrics` in open-access
  mode; config-file route errors no longer disclose absolute filesystem paths.
- **Authenticated packet headers (`authenticatedHeaders`, v3):** binds each
  DATA/METADATA header (type/flags/sequence/length) to the encrypted payload
  with a 16-byte HMAC tag, closing the unauthenticated-header tampering gap.
  Enabled by default (see Breaking changes above); both peers must use the same
  setting. Includes downgrade rejection and end-to-end + proxy relay tests.
- **DATA anti-replay window (v3):** the server keeps a per-peer sliding replay
  window (high-water mark + recently-seen sequences) that **survives session
  idle expiry and eviction**, closing the replay vector where a captured DATA
  datagram could be re-injected after the live session state was gone. The
  window resets only on a strictly higher **connection epoch** advertised in the
  client's HMAC-authenticated HELLO, distinguishing a legitimate restart from a
  replayed HELLO. No per-packet wire change (the epoch is an optional HELLO
  field); pre-H3 peers are unaffected. Rejections are counted as
  `replayedPackets`. Cross-epoch replay (~1e-6) and the post-server-restart race
  remain documented residuals — see `docs/security.md`.
- **Keys:** URL-safe base64 (`base64url`) secret keys are now accepted.

### Reliability

- Reliable server now has a full `stop()` teardown that resets every per-session
  sequence tracker (fixes a NAK-timer/memory leak across restarts).
- Bonding: a minimum dwell on the primary before _soft_ (degradation-driven)
  failover prevents flapping; hard link-down still fails over immediately.
- Client UDP socket recovery retries with exponential backoff instead of giving
  up permanently after a single failure.
- Source-snapshot chunking is O(n) instead of O(n²) on the reconnect path.
- CLI warns when a management token would be sent in cleartext over `http://`.

### Tooling

- CI now enforces the configured Jest coverage threshold; the networked
  `npm audit` check moved out of the blocking unit-test gate into its own job.
- React error boundary around the app and federated config panel; production
  source maps are no longer published; Dependabot now covers GitHub Actions.

## [2.9.0] - 2026-05-29

### Added — Outbound bandwidth optimizations (v2/v3)

Six new opt-in connection fields reduce outbound UDP bandwidth on v2/v3
connections. All are backward-compatible — when unset, behaviour is unchanged.
See the connection schema for field definitions, defaults, and valid ranges.

- **`pathFilter`** — Drop unwanted paths before any other processing
- **`pathThrottle`** — Per-path rate limit and deadband filter
- **`pathPrecision`** — Per-path numeric rounding (lossy)
- **`useValueDedup`** — Skip values unchanged since the last sent packet (peer-matching required)
- **`useCompactDeltas`** — Positional msgpack encoding; eliminates repeated field-name overhead (requires `useMsgpack: true`; peer-matching required)
- **`brotliQuality`** — Tune Brotli compression effort (0–11)

Compounding effects on a high-rate vessel feed (50 paths × 10 Hz): ~30–40%
wire-byte reduction when all six are configured appropriately.

### Notes

- Node.js's zlib does not expose `BROTLI_PARAM_DICTIONARY`, so a shared static Brotli dictionary is not used; per-packet Brotli compression applies only.
- `$source` is attached to the update, not per value, in the Signal K data model.

## [2.8.0] - 2026-05-21

### Fixed

- **Duplicate outbound deltas in proxy chains** (`pipeline.ts`,
  `pipeline-v2-client.ts`, `pipeline-v2-server.ts`, `instance.ts`): When
  edge-link instances were chained (boat → relay → shore), a delta could
  fan out twice because both the live processDelta path and the cache
  replay path emitted the same value. Outbound dedupe now keys on
  `(context, path, $source, timestamp, value-hash)` and drops repeats
  before they hit the UDP send queue.
- **Synchronous cache replay during `subscribe()`** (`pipeline.ts`):
  signalk-server's subscriptionmanager flushes its current cache
  synchronously inside `subscribe()`, which raced with our own snapshot
  replay and produced doubled deltas for every cached path on plugin
  start. The synchronous flush is now suppressed so only our deterministic
  replay path runs.
- **Doubled `processDelta` delivery after restart** (`pipeline.ts`,
  `instance.ts`): Two independent races could each rebind the
  `processDelta` listener twice — once during start/stop overlap, once
  when the flow-diagnostic timer started before the listener was
  attached. Both are now ordered so a failed start cannot leak a timer
  or a second listener.
- **`isServerMode()` startup-ordering bug** (`instance.ts`): The helper
  read from runtime state that was not yet populated when
  signalk-server started the plugin before its own server bind
  completed. It now derives directly from the plugin options so
  server/client mode is correct from the first delta.
- **Boat-side `$source` lost across hops** (`pipeline.ts`,
  `pipeline-v2-server.ts`): Multi-hop chains were rewriting `$source` on
  each hop, hiding the original device. The original boat-side `$source`
  is now preserved verbatim end-to-end.
- **Edge-link-injected values leaked into outbound snapshots**
  (`pipeline-v2-server.ts`): Values the plugin itself wrote back into
  signalk-server (e.g. RTT, link state) were being re-sent in the next
  full snapshot, creating a feedback loop. Those paths are now excluded
  from the outbound snapshot.
- **`FULL_STATUS_REQUEST` not cascading across multi-hop chains**
  (`pipeline-v2-server.ts`, `pipeline-v2-client.ts`): A server restart
  in the middle of a chain only requested a snapshot from its immediate
  upstream peer; downstream peers stayed stale. The request now cascades
  end-to-end and the drain runs again after each hop's snapshot
  arrives.
- **Source attribution + timestamps lost during snapshot replay**
  (`pipeline-v2-server.ts`): FullStatus replay was synthesizing a fresh
  timestamp and a generic `$source`, which broke downstream consumers
  relying on the original metadata. Both are now preserved.
- **Spurious v1-field rejection in HTTP route handlers** (`routes/connections.ts`):
  The connection POST/PUT handlers were validating raw request bodies before
  sanitization, so when the webapp re-submitted a config that still carried
  v1-only fields (`testAddress`, `testPort`, `pingIntervalTime`) on a v2/v3
  connection — the very rejection rule added in 2.5.1 — the request failed
  even though those fields would have been stripped by the sanitizer a step
  later. The route handlers now sanitize before validate, so v1-only fields
  on a v2/v3 body are silently dropped on the HTTP path. The 2.5.1 rejection
  rule in `validateConnectionConfig` is unchanged; it still fires for any
  caller that validates without sanitizing first.

### Security

- **Peer-supplied data hardening** (`pipeline-v2-server.ts`, `packet.ts`,
  `crypto.ts`, schema): Tightened bounds on every field a peer can
  influence — snapshot chunk count, METADATA path lists, source
  registry size, dedupe LRU cap — to prevent a hostile or
  malfunctioning peer from inflating local memory. All limits are
  configurable but default to safe values.
- **v2 CRC-only control frames flagged** (`packet.ts`, schema): v2
  control frames are still CRC-protected rather than HMAC-protected
  (v3 fixed this). The schema now surfaces a deprecation warning when
  a connection is configured for v2, and `parseHeader()` records the
  weaker auth posture in metrics so operators can see the exposure.

### Added

- **CI gate on every PR + push** (`.github/workflows/`): A new workflow
  runs `lint`, `check:ts`, webapp typecheck, `build`, and `test` on
  every PR and on direct pushes. Release-doc drift continues to be
  checked by `check:release-docs` inside the publish workflow.
- **Chunked snapshot replay** (`pipeline-v2-server.ts`): Snapshot
  replay now chunks large state trees so a fresh subscribe on a busy
  boat does not block the event loop or exceed UDP MTU.
- **Per-path `processDelta` counter (opt-in)** (`instance.ts`): When
  `SIGNALK_EDGE_LINK_PROCESS_DELTA_TRACE` is set, the plugin records
  per-path call counts to make hop-inflation issues observable
  without leaving the diagnostic on in production builds.

### Changed

- **Cheaper outbound dedupe** (`pipeline.ts`): The dedupe LRU now uses
  a fixed-size ring + content hash instead of a growing Map keyed on
  full delta JSON. Steady-state memory is bounded and dedupe lookup
  is O(1).

## [2.6.0] - 2026-05-11

### Added

- **Full-values snapshot request on server restart** (`packet.ts`,
  `pipeline-v2-client.ts`, `pipeline-v2-server.ts`): When a v2/v3
  server restarts mid-session, it now emits a `FULL_STATUS_REQUEST`
  control frame and the client responds with a snapshot of every
  currently-known path. This eliminates the "ghost values" window where
  a restarted server reported stale or missing data until each path
  happened to update again.
- **State replay on subscribe and recovery** (`pipeline.ts`): The
  pipeline now replays the current Signal K tree state at subscribe
  time and after socket recovery, so receivers see a consistent
  starting point without waiting for the next live update.

## [2.5.1] - 2026-05-10

### Fixed

- **Lost startup deltas while subscription is pending** (`pipeline.ts`):
  Signal K deltas that arrived between plugin start and the
  subscriptionmanager finishing its first subscribe were being
  silently dropped. They are now buffered and dispatched once the
  subscription is active.
- **Stale `connections` key in flat-config sync** (`config-io.ts`): The
  legacy flat-config `_currentOptions` sync path retained a stale
  `connections` key when a connection was deleted, causing the deleted
  connection to resurrect on next reload.
- **`testAddress` / `testPort` / `pingIntervalTime` accepted on v2/v3
  clients** (`schema`, `routes.ts`): These v1-only fields are now
  rejected on v2/v3 clients with a clear validation error instead of
  silently being ignored.
- **Connections not sanitized before validation at startup**
  (`instance.ts`): A startup config with leftover v1 fields on a v2
  connection failed validation; sanitization now runs first so the
  config loads cleanly.
- **Persistence fallback + stale-version regex** (`config-io.ts`,
  `scripts/check-release-truth.js`): The release-truth check missed
  prerelease suffixes (`-rc.1`, `-beta.0`) and the persistence
  fallback path could write a corrupted file on disk-full conditions.
- **Redacted secret restoration hardening** (`config-io.ts`): When a
  redacted secret round-tripped through the UI, edge cases could
  restore the wrong original value. The restore path now requires
  byte-exact placeholder matching.

### Added

- **Phase 4 + Phase 5 documentation** (`.planning/`, `docs/`): Schema
  parity, webapp type-safety, configuration parity, and the future
  security roadmap are now captured in versioned planning docs and
  linked from `docs/README.md`.
- **Webapp `noImplicitAny`** (`tsconfig.webapp.json`,
  `src/webapp/`): The webapp build now enforces `noImplicitAny`;
  configuration-form change handlers and the configuration panel are
  fully typed.
- **UDP metadata port schema + route + tests** (`schema`, `routes.ts`,
  `__tests__/`): The previously implicit `udpMetaPort` option is now
  schema-validated, exposed via the management routes, and covered by
  parity tests.

## [2.5.0] - 2026-04-28

### Added

- **Source replication over UDP** (`source-registry.ts`,
  `source-replication.ts`, `pipeline-v2-client.ts`,
  `pipeline-v2-server.ts`, `packet.ts`): Client-side `$source`
  identities are now replicated to the server so the receiver sees the
  same provenance (`vessels.self.navigation.position` from
  `gps.0`, `ais.1`, etc.) as the sender, instead of every value
  collapsing into `edge-link`. Snapshot at startup, live diffs after,
  with a debounced registry-size log and a deterministic identity
  hash so re-registrations do not cause spurious updates.
- **Metadata contract alignment**: Source-replication metadata uses an
  empty object (`{}`) for "no metadata" instead of `null`, matching the
  metadata streaming contract from 2.3.0.

### Fixed

- **Source-replication merge timing + no-op hash + API exposure**
  (`source-registry.ts`): A racy merge could overwrite a freshly
  registered source with stale data; the no-op detector now uses a
  content hash so identical re-registrations are skipped; the
  registry API is exposed for tests and the receiver side.
- **Missing source metadata updates** (`pipeline-v2-server.ts`):
  Regression test added — a metadata-only update on an
  already-known source was being dropped.

### Security

- **Harden redacted secret restoration** (`config-io.ts`): Round-tripped
  secrets that did not match the exact redaction placeholder are now
  rejected rather than silently passed through.

## [2.4.1] - 2026-04-27

### Fixed

- **Null/empty placeholder metadata fields** (`metadata.ts`): A
  Signal K source emitting `meta: { units: null, description: "" }`
  was being treated as a metadata change on every delta, causing
  unnecessary METADATA packets. Null and empty placeholders are now
  preserved as explicit clears (renamed sanitizer) but no longer
  trigger spurious diff packets.

## [2.4.0] - 2026-04-25

### Fixed

- **RTT path always forwarded under `skipOwnData`** (`pipeline.ts`):
  When `skipOwnData` was enabled to suppress echoing local writes back
  upstream, it was also suppressing the plugin's own RTT measurement
  path. RTT now always forwards regardless of `skipOwnData`.
- **Plugin selection bug** (`instance.ts`): A config with multiple
  connections could pick the wrong pipeline implementation when the
  first connection was v1 and later ones were v2/v3.

## [2.3.0] - 2026-04-24

### Added

- **Optional metadata streaming** (`metadata.ts`, `packet.ts`, `pipeline.ts`,
  `pipeline-v2-client.ts`, `pipeline-v2-server.ts`, `instance.ts`, schema):
  Signal K path metadata (units, descriptions, zones, display names, ...) can
  now be forwarded to the remote receiver alongside deltas by adding a `meta`
  block to `subscription.json`. Default off, so existing deployments are
  unchanged.
  - Two new packet types: `METADATA` (0x06) on v2/v3 and `META_REQUEST` (0x07)
    so a receiver can demand a fresh snapshot on startup without waiting for
    the next periodic resend.
  - v1 clients transmit meta on a separate `udpMetaPort` with an `"SKM1"`
    magic prefix inside the encrypted payload; existing v1 receivers that
    have not been upgraded ignore the packets.
  - Full snapshot at startup and on socket recovery; live meta changes
    pulled from `updates[].meta[]` and coalesced into a debounced diff
    packet; periodic full resend (default 300 s, configurable 30–86400 s).
  - Diffs computed against a sha1 cache so unchanged meta is never resent;
    `includePathsMatching` regex and `maxPathsPerPacket` chunking for
    bandwidth control.
  - Web UI: new fieldset in the subscription card exposes the meta toggle,
    interval, regex, and packet-size controls.
  - Receiver side: `pipeline-v2-server.ts` decodes METADATA packets and
    re-emits each entry as a Signal K delta with `updates[].meta[]` so the
    local Signal K server picks it up via `app.handleMessage`.

## [2.2.0] - 2026-04-17

### Breaking

- **`parseHeader({ allowUnauthenticatedControl })` removed** (`packet.ts`):
  The option was never used in production code paths and allowed v3 control
  frames to bypass HMAC verification. V3 control packets are now always
  HMAC-verified.

### Added

- **Opt-in ASCII-key stretching with `stretchAsciiKey`** (`crypto.ts`,
  `packet.ts`, `bonding.ts`, `pipeline-v2-*.ts`, schema): A new per-connection
  boolean option `stretchAsciiKey` (default `false`) routes 32-character
  ASCII keys through PBKDF2-SHA256 (600,000 iterations, salt
  `signalk-edge-link-v1`) before they are used as the AES-256-GCM / HMAC key.
  Hex (64-char) and base64 (44-char) keys are unaffected. The derivation is
  deterministic and cached per-process. **Both peers must use the same
  setting** — enabling it on one end and not the other will fail AES-GCM
  authentication on every packet. Treat the flag as part of the key. Default
  is `false` for backwards compatibility; existing deployments are unchanged.

### Security

- **Protocol version pinning** (`pipeline-v2-server.ts`): A v3-configured
  server now rejects any packet whose header advertises a different protocol
  version; a v2-configured server likewise rejects v3 packets. This closes a
  downgrade surface where a MITM could inject forged v2 control frames
  (ACK/NAK/HEARTBEAT/HELLO) — which carry no HMAC tag — at a server that had
  negotiated v3.
- **PBKDF2 stretching available for ASCII keys** (see Added above): when
  enabled, lifts the effective entropy of a 32-char human-typeable ASCII key
  from ~208 bits to the full 256-bit AES strength and makes offline brute-
  force attacks on leaked passphrases significantly more expensive.

### Tests

- New `__tests__/config-watcher.test.js` cases covering the hash-dedupe fast
  path, `readFallback` branch, `state.stopped` guards, watcher-handle
  lifecycle, legacy-file migration, and persistent-storage initialization.
- New `receivePacket – protocol version pin` regression tests in
  `__tests__/pipeline-v2-server.test.js`.
- New `normalizeKey ASCII path` and `encryptBinary / decryptBinary
stretchAsciiKey round-trip` regression tests in `__tests__/crypto.test.js`
  covering the default raw-bytes path, the opt-in PBKDF2 path, and the
  mismatched-flag failure mode.

### Documentation

- `docs/code-quality-report.md` summarises the repository's quality model,
  headline signals (coverage, typing, lint), and open improvement
  opportunities.

---

## [2.1.1]

### Fixed

- **RTT measurement accuracy** (`pipeline-v2-client.ts`): Improved RTT
  measurement with Karn's algorithm — retransmitted packets are now excluded
  from RTT samples to prevent inflated estimates. Added smoothed RTO
  calculation for more stable timeout behaviour on lossy links (PR #106).
- **Stale RTT in congestion control** (`pipeline-v2-client.ts`): Prevented
  stale RTT values from being fed to the congestion control EMA, which could
  cause unnecessary delta timer increases after idle periods (PR #106).
- **Bonding link validation** (`connection-config.ts`): Added validation that
  bonding primary and backup links use different address:port combinations,
  preventing misconfiguration where the same link is used for both.
- **Stop-race in delta flush** (`instance.ts`): Added `state.stopped` guard
  in the `flushDeltaBatch` finally block to prevent scheduling an extra flush
  via `setImmediate` after `stop()` is called.

### Removed

- **Dead `networkSimulator` code** (`types.ts`, `instance.ts`,
  `routes/monitoring.ts`): Removed the `networkSimulator` field from
  `InstanceState` and all references — it was declared but never instantiated.
  The `/monitoring/simulation` endpoint is preserved for API compatibility and
  returns `{ enabled: false }`.

### Tests

- Added `connection-config.test.js` with unit tests for bonding primary/backup
  validation and basic connection config validation.

---

## [2.1.0]

### Highlights

Reliability and UI modernisation release. Fixes an oversized-packet bug in the
sender pipeline, rewrites the plugin configuration panel for broader React
compatibility, and adds comprehensive failover/recovery test coverage.

### Changed

- **PluginConfigurationPanel rewrite**: Rewrote the RJSF-based configuration
  panel for React 19 compatibility; also compatible with React 16. Replaced
  `@signalk/server-admin-ui-dependencies` with standalone `@rjsf/core`,
  `@rjsf/utils`, and `@rjsf/validator-ajv8` (PR #101).
- **React 16 dev dependency**: Development and testing now use React 16 to
  match the Signal K reference plugin environment (PR #101).

### Fixed

- **Oversized UDP packets** (`instance.ts`, `pipeline-v2-server.ts`,
  `pipeline.ts`): The sender now caps each flush batch at
  `state.maxDeltasPerBatch`, and the receiver enforces `MAX_DELTAS_PER_PACKET`
  (500) on inbound packets, truncating and logging excess deltas. This prevents
  MTU-exceeding packets that could be silently dropped by the network (PR #103).

### Tests

- Added 31 component tests for `PluginConfigurationPanel` covering CRUD, mode
  switching, validation, save/load, and error states (PR #101).
- Added comprehensive failover-recovery lifecycle tests for `BondingManager`,
  including 15 additional gap-coverage tests for edge cases (PR #104).
- Added flush batch cap, drain loop, and buffer overflow tests for the sender
  pipeline (PR #103).

---

## [2.0.0]

### Highlights

First stable release of the v2 series. This release promotes the 2.0.0-beta
series (twelve beta iterations) to stable and closes all known reliability,
type-safety, and documentation gaps identified during the pre-release audit.

### Added

- **Protocol v3**: Control-plane authentication with HMAC-SHA256 over the hello
  handshake, preventing unauthenticated nodes from injecting control packets.
- **Connection bonding**: Primary/backup link management with automatic failover,
  health scoring, and configurable RTT/loss thresholds (`src/bonding.ts`).
- **AIMD congestion control**: Additive-increase / multiplicative-decrease delta
  timer adjustment with RTT feedback loop (`src/congestion.ts`).
- **Recovery burst**: Automatic retransmission burst when ACK silence exceeds
  `recoveryAckGapMs` (default 4 s), recovering from extended network outages
  without waiting for explicit NAKs.
- **Comprehensive observability**: Prometheus metrics endpoint, per-path
  statistics, packet-loss heatmaps, alert thresholds, and packet capture
  (`src/monitoring.ts`, `src/packet-capture.ts`).
- **Path dictionary**: Dictionary-based path compression for up to 40 % payload
  reduction on typical Signal K delta streams (`src/pathDictionary.ts`).
- **Smart batching**: Adaptive delta coalescing that learns average delta size
  and maximises UDP frame utilisation without exceeding `MAX_SAFE_UDP_PAYLOAD`.
- **Management REST API**: Token-authenticated endpoints for instance CRUD,
  live metrics, monitoring alerts, and connection health.
- **Brotli + MessagePack**: Optional binary encoding alongside existing zlib
  compression; negotiated per-packet via packet flags.
- **Socket recovery**: Automatic UDP socket recreation on error, with per-worker
  restart and subscription handover to keep data flowing during recovery.
- **Retransmit deduplication**: `getOldestSequences(limit, minRetransmitAge)`
  filter prevents the recovery burst and a concurrent NAK handler from
  double-sending the same sequence within one burst interval.

### Changed

- **Default protocol**: New connections default to v2 (reliable ACK/NAK). v1
  remains available for legacy interop via `protocolVersion: 1`.
- **Configuration schema**: `connections` is now an array of objects; the old
  single-connection flat schema is auto-migrated on first load.
- **Sequence numbers**: 32-bit unsigned with correct wraparound arithmetic
  throughout (serial-space comparisons replace naive subtraction).
- **Error handling**: All `catch` clauses now type `err: unknown` and narrow via
  `instanceof Error`; `as any` casts reduced from ~340 to zero in hot paths.
- **Key validation**: `validateSecretKey` rejects malformed base64 inputs with
  an explicit error instead of silently falling through to the ASCII key path.
- **Rate limiting**: Management API routes enforce per-IP request limits to
  prevent log-flooding and resource exhaustion from misbehaving clients.

### Fixed

- **Timer leak** (`instance.ts`): `clearInterval(state.helloMessageSender)` is
  now called unconditionally before creating a replacement interval, preventing
  timer accumulation if `start()` is ever called more than once on an instance.
- **Telemetry flag** (`pipeline-v2-client.ts`): `telemetrySendInFlight` is now
  reset inside a `try/catch` that also covers the `sendDelta()` call, so a
  synchronous throw can never leave the flag permanently `true`.
- **Socket recovery race** (`instance.ts`): `socketRecoveryInProgress` is set
  atomically at the start of the error handler; `state.stopped` is checked
  inside the recovery `setTimeout` callback before recreating the socket.
- **recoveryDrainTimer teardown** (`pipeline-v2-client.ts`): Timer is cleared
  in `stopMetricsPublishing()` before any other state is torn down, ensuring
  `_runRecoveryBurst()` cannot fire against partially cleaned-up state.
- **Subscription leak** (`instance.ts`): Old unsubscribe handlers are preserved
  in a local variable during re-subscription; they are released only after the
  new subscription is confirmed, and restored on failure so `stop()` can always
  clean up.
- **NaN/Infinity in congestion control**: `_calculatePacketLoss()` result is
  clamped to `[0, 1]` before being passed to `congestionControl.updateMetrics()`.
- **Webpack vulnerability**: Upgraded `copy-webpack-plugin` and
  `jest-environment-jsdom` to resolve two high-severity CVEs (PR #95).
- **API warning noise**: Removed misleading management-API token warning that
  fired even when authentication was correctly configured (PR #94).

### Security

- Protocol v3 hello authentication prevents unauthenticated control packets.
- AES-256-GCM with a 12-byte random IV per packet; no IV reuse across sessions.
- Timing-safe comparison for HMAC verification tags.
- Base64 key decoding validates decoded length and throws on mismatch rather
  than silently using a truncated key.
- Management API enforces token authentication and per-route rate limiting.
