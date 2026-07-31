# Multi-Aspect Code Review — 2026-07-26

Review of `signalk-edge-link` v3.1.0 at commit `de6aa24`, covering security, protocol
reliability, application lifecycle, web UI, test quality, configuration parity, and
hot-path performance.

Findings are ordered by severity. Each one names the file and line so it can be
checked independently. "Verified" marks a finding reproduced by executing the code;
the rest were confirmed by reading the implementation and its tests.

> Line numbers refer to the code _as reviewed_ at `de6aa24` and will not match
> later revisions. The value of this document is the description of each defect
> and why it mattered, not its position in the tree.

Note on labels: findings are numbered C/H/M/L by severity. The codebase's own "H3"
refers to its anti-replay hardening phase, not to a finding in this document.

---

## Critical

### C1. Anti-replay is keyed on the peer's source port, so rotating ports defeats it

`src/transport/pipeline/reliable-server/data-handler.ts:232`,
`src/transport/pipeline/reliable-server/context.ts:185`

The per-peer replay guard is looked up by `` `${rinfo.address}:${rinfo.port}` ``. Both the
key and the enforcement gate are attacker-controlled: a datagram from an unseen source
port allocates a fresh guard whose window is empty (so `accept()` reports the sequence
as new) and whose `epoch` is `0` — and `epoch === 0` short-circuits enforcement outright:

```ts
const guard = getReplayGuard(ctx, `${rinfo.address}:${rinfo.port}`);
const fresh = guard.window.accept(parsed.sequence >>> 0);
if (fresh || guard.epoch === 0) return false; // false = not a replay, keep processing
```

`getOrCreateSession` (`sessions.ts:46`) is keyed the same way, so the per-session
sequence tracker also starts clean and treats the packet as in-order.

An attacker who captures one DATA datagram can resend it verbatim from any other source
port. No key is needed — the AES-GCM tag stays valid on a byte-identical copy — and it
works **while the legitimate session is still live**, so the documented idle-expiry
mitigation does not apply. The replayed delta is decrypted and re-injected through
`app.handleMessage`, i.e. a stale position or depth enters a navigation system.

**Verified.** Driving `receivePacket` directly: after a legitimate `HELLO(epoch=1000)` and
`DATA(seq=500)`, replaying the identical datagram from `10.0.0.5:61234` and
`203.0.113.9:40000` produced `handleMessage` **3 calls** (expected 1) and
`replayedPackets: 1` — only the same-port replay was caught. Three separate guards were
created.

The doc comment at `data-handler.ts:215` claims "a captured DATA datagram cannot be
replayed after the live session is gone", and `docs/security.md:82` rates DATA replay
protection "Strong (v3)". Neither holds. `.planning/codebase/CONCERNS.md` does not list
this as an accepted risk.

Existing coverage misses it because `__tests__/v2/replay-protection.test.js:19` uses a
single fixed client port for every case — including its otherwise-thorough replayed-HELLO
test.

**Fix.** Key `replayGuards` by source IP only, so port rotation no longer mints fresh
state. Make `epoch === 0` fail closed once any guard for that IP has completed a
handshake. Longer term, bind the connection epoch into the packet's authenticated data
(AES-GCM AAD or the DATA header HMAC) so a captured packet is only valid within its epoch.

### C2. With bonding enabled, HELLO leaves on the wrong socket — disabling replay protection and all client telemetry

`src/app/connection/start-client.ts:169` vs `:184`,
`src/transport/pipeline/reliable-client/lifecycle.ts:35-45`

`setupReliableClient` sends HELLO before it initialises bonding:

```ts
await v2.sendHello(...);     // line 169 — mut.bondingManager is still null
...
await initBonding(ctx, v2);  // line 184 — creates the primary/backup link sockets
```

`udpSendAsync` routes through the bonding socket only once `mut.bondingManager` is set,
falling back to `state.socketUdp` otherwise. So HELLO departs from `state.socketUdp`'s
ephemeral port, while every subsequent DATA departs from the bonding primary's port.
Because the server keys both sessions and replay guards on address:port, the session that
actually carries data never receives the HELLO. Consequences for that session:

- `guard.epoch` stays `0`, so `rejectReplayedDataPacket` returns `false` unconditionally —
  **anti-replay is inert on the entire data path whenever bonding is on**, independently
  of C1.
- `clientId` / `sourceClientInstanceId` stay `null`, so `peerIdentified` is false and all
  client telemetry (rtt, jitter, packetLoss, retransmissions, queueDepth, activeLink) is
  silently dropped at `reliable-server/telemetry.ts:170`.
- Source attribution falls back to `"unknown"` (`data-handler.ts:155`).

The keepalive cannot repair it: `keepalive-manager.ts:78` re-sends HELLO only after
`helloInterval` (60 s) of total send idleness, which an actively-sending client never
reaches.

The same defect applies on failover. `bonding.ts:621-631` exposes `onFailover`/`onFailback`,
but grepping `src/` shows **no backend handler is ever registered** — the only matches are
an unrelated React prop. Switching to the backup link changes the source port again.

Bonding is opt-in (`start-client.ts:119`), so this is scoped to deployments that enable it.

**Fix.** Move `sendHello` after `initBonding`, and register `onFailover`/`onFailback`
handlers that re-send HELLO on the newly active link.

---

## High

### H1. Control packets are accepted from any source and the source becomes the send target

`src/transport/pipeline/reliable-client/control-packets.ts:64`,
`src/transport/pipeline/reliable-client/reliability.ts:222, 266`

`handleControlPacket` never compares `rinfo` against the configured peer, and the NAK's
source address is passed straight through as the retransmit destination:

```ts
await receiveNAK(ctx, parsed, rinfo.address, rinfo.port);   // control-packets.ts:64
await udpSendAsync(ctx, retransmitPacket, udpAddress, udpPort);  // reliability.ts:266
mut.lastAckRinfo = rinfo ? { address: rinfo.address, port: rinfo.port } : ...;  // :222
```

Control packets are HMAC-authenticated, but the tag covers only `header[0..13)` plus
payload — no timestamp, no nonce, no peer binding, and there is no replay window on the
control plane. A captured ACK/NAK therefore stays valid indefinitely.

- **Amplified reflection.** A NAK carrying up to `MAX_NAK_SEQUENCES_PER_PACKET` (256)
  sequences is ~1 KB; the client answers with up to 256 full-size retransmits to the
  spoofed source — roughly 290×.
- **Sustained reflection.** A replayed ACK sets `lastAckRinfo` and arms the recovery
  drain (100 packets per 200 ms) toward an attacker-chosen address.
- **Recovery suppression.** `mut.lastAckAt = now` on every accepted ACK, so a low-rate
  replay keeps `ackGapMs` below the recovery threshold forever, disabling loss recovery —
  silent, unrecovered data loss.

`docs/security.md:92` claims the HMAC "closes" the forged-NAK vector; replay reaches the
same effect without forgery.

**Fix.** Drop control packets whose source does not match the configured peer or active
bonding link; never derive a send destination from `rinfo`; add epoch + counter to the
authenticated bytes with a small per-peer control replay window.

### H2. A permanently-lost sequence freezes the cumulative ACK and triggers an unbounded NAK loop

`src/transport/reliability/sequence.ts:165-207, 284-319`,
`src/transport/pipeline/reliable-server/sessions.ts:246`

`expectedSeq` advances only on an exact in-order match or via `_resync` (gap >
`maxGapTracking` = 1024). `_processAhead` never advances it, and `_scheduleNAK`'s timer
deletes its own map entry when it fires, so the next ahead-packet re-arms it.

Once a sequence is lost beyond recovery (the client already spent `maxRetransmits`), for
the next **1025 packets** the server re-NAKs it every `nakTimeout` (100 ms), emits a frozen
`ackSeq` forever, and — because `receiveACK` can no longer find the acked sequence in the
queue — **stops taking RTT samples entirely**, freezing `avgRTT` and the congestion
controller's inputs. At 1 packet/second that is roughly 17 minutes per hole.

**Fix.** Bound the stall: track a per-gap deadline, declare the sequence permanently lost,
advance `expectedSeq` past it, and cap NAK re-arms per sequence.

### H3. A failed UDP send burns the sequence number without queueing the packet

`src/transport/pipeline/reliable-client/delta-sender.ts:302-311`

```ts
const { seq, packet } = await buildDataPacket(...);   // advances the sequence
await udpSendAsync(ctx, packet, udpAddress, udpPort); // throws
metrics.deltasSent++;
recordDataSend(ctx, seq, packet, ...);                // the enqueue lives here
```

On EMSGSIZE, ENETUNREACH, ENOBUFS after retries, a closed socket, or the 5 s send
timeout, the sequence is consumed but the packet is neither sent nor enqueued. The server
sees a hole the client is structurally incapable of filling, which feeds directly into
H2 — a NAK storm and frozen ACK per failed send. ENOBUFS on a saturated cellular or
satellite uplink makes this routine.

**Fix.** Enqueue before sending, so a NAK can actually recover the packet.

### H4. 37 of 43 management routes have their auth guard stubbed out in every test

`__tests__/routes.control.test.js:55, 75` and the same pattern in
`routes.metrics.test.js:65`, `routes.monitoring.test.js:64`,
`routes.config-validation.test.js:75`

Six routes call `authorizeManagement` inline; the other 37 — including
`POST /bonding/failover` and `POST /config` — are guarded only by
`managementAuthMiddleware(action)`. Every test for those routes both stubs the middleware
to a pass-through **and** resolves the handler via `route.handlers.at(-1)`, skipping
middleware entirely.

Deleting the auth middleware from a route registration therefore leaves the whole suite
green while the endpoint becomes unauthenticated. `routes.auth-guard.test.js` is a good
file but only ever exercises `GET /status`.

**Fix.** Add a registration-shape test that enumerates every route from
`registerWithRouter` and asserts each carries an auth guard, against a frozen allowlist of
intentionally-public paths.

### H5. The "end-to-end" suites reimplement the pipeline instead of testing it

`__tests__/integration/e2e-pipeline.test.js:148-247`, `__tests__/full-pipeline.test.js:12-67`

Both define private `compress → encrypt → buildDataPacket` helpers and never call
`src/transport/pipeline/v1.ts` or `reliable-client/delta-sender.ts`. Inverting the real
sender to encrypt-then-compress, changing the brotli parameters, or dropping the
`compressed` flag would leave these tests green while every deployed peer stops decoding.

The conformance vectors pin header framing but are built around a fixed payload buffer, so
the compress/encrypt/flag ordering inside the real pipeline has no golden pin either.

**Fix.** Feed `sendDelta`'s captured socket bytes into a real server `receivePacket` and
assert the delta reaches `app.handleMessage`. `__tests__/v2/meta-end-to-end.test.js:67`
already does exactly this for METADATA.

### H6. Fuzz tests swallow their own assertions, including the AES-GCM integrity check

`__tests__/v2/fuzz-packet-parser.test.js:74-88, 90-103, 165-185, 214-230`

```js
try {
  parser.parseHeader(corrupted);
} catch (e) {
  expect(e.message).toMatch(/CRC/i);
}
```

If CRC validation were removed, `parseHeader` returns normally, no assertion runs, and the
test passes. The worst instance is the AES-GCM bit-flip test, whose comment reasons that a
non-throwing case means "corruption was in unused padding — acceptable". AES-GCM has no
unused padding; every bit flip in `[IV][ct][tag]` must fail authentication. If
`decryptBinary` stopped calling `setAuthTag`, all 100 iterations pass silently.

**Fix.** Hoist the assertions out of the `catch` blocks: `expect(() => ...).toThrow(...)`.

### H7. `stop()` during an in-flight `start()` leaves unreachable live instances

`src/app/connection-manager/start.ts:149-162`, `src/app/connection-manager.ts:119-123`

`startAllInstances` snapshots the instance list once, then awaits the server group and the
client group in sequence. `manager.stop()` is synchronous — it stops what is in the map and
clears it. A `stop()` landing during the server-group await means the **client group is
started after the plugin was stopped**: `Stopped → Starting` is a legal transition, so
`state.stopped` is reset and every downstream guard reopens.

The result is a client that subscribes to the Signal K bus, binds a UDP socket, and streams
deltas over the WAN indefinitely while holding no registry entry — no `stop()`, no route,
and no restart can reach it. Nothing in `instance.test.js` or `index.test.js` exercises
stop-during-start.

Compounding this, `lifecycle-ops.ts:57` discards the return value of
`lifecycle.transition("Starting", ...)`, and `:67` re-arms `dedupeCleanupTimer` via
`setInterval` without clearing the previous handle — so repeated starts leak a 1 s interval
each time, turning an orphan into an unbounded one.

**Fix.** Add a monotonic `startGeneration` captured in `start()` and bumped in `stop()`;
bail out of `startAllInstances` when it changes. Check the transition result. Clear the
timer before reassigning.

### H8. `startClient()` allocates timers and sockets after its awaits with no shutdown guard

`src/app/connection/start-client.ts:236-276`

There is an `isShuttingDown()` check at line 237 and another at 267, with five awaits in
between and no check among them. A `stop()` in any of those windows still creates: the
keepalive interval (whose callback checks only `state.readyToSend`, never `state.stopped`),
a dgram socket, the metrics-publishing and congestion intervals, a 25 s heartbeat interval
that **actively sends UDP and never checks stopped state**, the source-snapshot interval,
and a `BondingManager` with two sockets plus a health-check interval — created after
`teardownPipelines` already ran, so `state.pipeline.stop()` can never reach it.

**Fix.** Re-check `lifecycle.isShuttingDown()` after every await, and have the catch/finally
path call `stop(ctx)` when the lifecycle left `Starting` mid-flight.

---

## Medium

### M1. `npm audit` gates the required CI lane, contradicting the workflow's own design

`__tests__/npm-audit.test.js`, `.github/workflows/ci.yml:100-106`

The workflow comments state the audit is "kept out of the required `ci` gate so a
newly-published advisory or registry/network hiccup cannot block merges", and it defines a
separate `continue-on-error` job for it. But the test also lives in the default Jest suite,
so `npm run verify` — the required gate — runs it. The branch is red right now for
advisories in `eslint`, `ts-jest`/istanbul, `@rjsf/validator-ajv8` → `ajv` → `fast-uri`, and
`css-loader` → `postcss`. None are in the runtime dependency tree.

Two secondary defects in the same file:

- **The `js-yaml` override is now the vulnerability.** `package.json` pins
  `"js-yaml": "4.2.0"`; the advisory range is `>=4.0.0 <4.3.0`. The pin actively blocks
  the transitive fix.
- **The total is double-counted.** `metadata.vulnerabilities` includes its own `total` key,
  so `Object.values(meta).reduce(...)` at line 35 sums it twice — the run reports `14` for
  7 advisories.

The claimed offline resilience is also weak: empty stdout parses to `{}`, which reads as
zero vulnerabilities and passes vacuously.

**Fix.** Move the audit out of the unit suite into the scheduled job; bump or drop the
`js-yaml` override; if the test stays, sum only the severity keys and assert a report was
actually obtained.

### M2. Switching connection tabs can write one connection's config into another

`src/webapp/components/cards/DeltaTimerCard.tsx:18`,
`src/webapp/components/cards/SubscriptionCard.tsx:70`

`ClientDashboard.loadConfigs` sets state to `null` when a load fails, but two cards ignore
a null config and keep their previous internal state:

```ts
useEffect(() => { if (config) setValue(config.deltaTimer); }, [config]);   // DeltaTimerCard
useEffect(() => { if (!config) return; ... }, [config]);                   // SubscriptionCard
```

Switch from client A to client B; if B's config request returns 503 (plugin still
initialising), 404, 401, or 429, the cards keep displaying A's values under B's tab — and
clicking Save POSTs A's values into B's config file. `SentenceFilterCard.tsx:18` handles
this correctly (`config?.excludedSentences ?? ""`) and is the model for the fix.

**Fix.** Reset all six state slices when `connId` changes, or key the component
(`<ClientDashboard key={activeId} />`), and make the child effects reset on `config === null`.

### M3. v3 monitoring, congestion, and bonding cards never refresh

`src/webapp/components/ClientDashboard.tsx:90-132`

The effect's dependencies are `[connId, metrics?.protocolVersion, request, authMessage,
onNotify]`. `protocolVersion` is constant after the first poll and the rest are stable
callbacks, so this runs once per connection selection. Bonding "Active Link", per-link RTT
and loss, the current delta timer, and Active Alerts are frozen at page-load values while
`MetricsCard` advertises "auto-refreshes every 15 seconds". After a real failover the
operator still sees the primary as active; `handleFailover` even toasts "Failover complete.
Active link: backup" while the card underneath still shows primary.

**Fix.** Drive these loads off the same poll tick, and re-fetch bonding after a successful
failover.

### M4. The delta timer never flushes — it only sets a flag

`src/domain/delta-batcher.ts:69-79`

```ts
state.deltaTimer = setTimeout(() => {
  if (state.stopped) return;
  state.timer = true;
  ctx.scheduleDeltaTimer();
}, state.deltaTimerTime);
```

The callback never calls `flushDeltaBatch`. Every flush is producer-driven from
`processDelta`, so whatever remains in `state.deltas` when the delta stream goes quiet sits
there until the next inbound delta — indefinitely if the source stops publishing.
`docs/GUIDE.md:145` documents the opposite ("OR until deltaTimer fires"), and
`__tests__/domain/delta-batcher.test.js:196` only asserts the flag flips, never that a send
occurs.

**Fix.** Have the timer callback invoke `flushDeltaBatch()` when `state.deltas.length > 0`.

### M5. Send-failure statuses are classified as healthy

`src/app/connection/build-context.ts:184-193`

Health is inferred from message text:
`Boolean(msg && !msg.toLowerCase().match(/error|fail|stopped/))`. Both pipelines call
`setStatus("UDP socket not initialized - cannot send data")` with no `healthyOverride`, and
that string matches none of the three keywords — so `isHealthy` becomes **true**.
`updateAggregatedStatus` then counts the instance as healthy and reports "N connections
active" while nothing is being transmitted.

**Fix.** Pass `healthyOverride: false` at those call sites and make health an explicit
required argument rather than a text heuristic.

### M6. Subscription retry re-opens sending while the socket is still down

`src/domain/subscription-manager.ts:293-297`

`runSubscriptionRetry` sets `readyToSend = true` and replays the values snapshot without
checking `socketRecoveryInProgress` or the lifecycle state. If a subscription retry
succeeds during socket recovery, the entire Signal K tree is pumped into `state.deltas`
while `flushDeltaBatch` is still blocked — the buffer hits `MAX_DELTAS_BUFFER_SIZE` (1000)
and `enforceBufferCap` discards **50% per overflow**. Data loss plus a false-healthy status.

**Fix.** Gate the `readyToSend = true` and replay on `ctx.lifecycle.canSend()`.

### M7. A transient read error on `subscription.json` silently subscribes to everything

`src/domain/subscription-manager.ts:471-479`, `src/foundation/config-reload.ts:64-67`

The handler's `readFallback` is `{ context: "*", subscribe: [{ path: "*" }] }`, and when a
fallback is defined the read is `readFile(...).catch(() => null)`. Any error — ENOENT during
an editor's delete-then-create, EACCES, EIO on a flaky SD card — is swallowed and the
wildcard subscription is applied and hash-committed. `createWatcher` fires `onChange` on
`rename`, exactly the event such writes produce. On a metered satellite link this silently
switches the vessel to the full firehose, with no log distinguishing "missing" from
"fallback".

**Fix.** Apply the fallback only on ENOENT at first initialisation; on any other error, log
at `app.error` and keep the previous subscription.

### M8. Loss accounting conflates retransmissions with loss, collapsing throughput for minutes

`src/transport/pipeline/reliable-client/reliability.ts:24-32, 131, 271`

`lossWindow` is a 50-slot buffer holding one `false` per sent packet and one `true` per
retransmitted packet. A fade that drops 60 packets out of ~5000 (1.2% real loss) produces
60 `true` pushes into a 50-slot window — `calculatePacketLoss()` returns **1.0**. The
congestion controller sees severe congestion and walks the delta timer up to its 5000 ms
ceiling; recovery needs ~21 clean updates plus ~31 further 5 s steps. That is roughly three
minutes of near-minimum throughput per loss burst, with the dashboard reading 100% loss.

**Fix.** Keep loss and retransmit rate as separate signals; push at most one `true` per loss
event, or compute `retransmits / sends`.

### M9. Recovery bursts exceed the server's own rate limit

`src/transport/pipeline/reliable-client/context.ts:112-114`,
`src/transport/pipeline/reliable-server/data-handler.ts:56-69`

Defaults of 100 packets per 200 ms give **500 packets/sec**, against a server limit of 200
packets/sec per session counted before decrypt. The server discards ~60%, which suppresses
the very ACKs that would end the burst, which keeps `ackGapMs` high. `parseACKPayloadFull`
already decodes a `receiveWindow` field, but `receiveACK` calls `parseACKPayload` and the
value is never used — there is no flow control today.

**Fix.** Pace the burst from the congestion controller and cap it below the server's
per-session budget.

### M10. `udpMetaPort` is documented across six files but does not exist in the code

`grep -rn udpMetaPort src/` returns nothing. It is presented as a configurable setting in
`docs/configuration-reference.md:26`, `docs/GUIDE.md:369, 551, 736`,
`docs/protocol-v3.md:43`, `docs/protocol-v3-spec.md:257`, and `docs/api-reference.md:416`.
Because the key is absent from `VALID_CONNECTION_KEYS`, `sanitizeConnectionConfig` strips
it on every load, so **v1 metadata transport is permanently unreachable**.
`__tests__/config-docs-parity.test.js:33` even asserts the field must _not_ appear in the
documented JSON schema — the prose docs were never updated to match.

**Fix.** Remove it from the six doc locations and state that metadata transport requires v3.

### M11. `protocolVersion` default is documented three different ways

The schema (`connection-schema.ts:178`), `docs/configuration-reference.md:30`, and
`docs/configuration-schema.json` all say `1`, matching runtime behaviour
(`start-client.ts:257` takes the v1 branch when unset). But `docs/GUIDE.md:554` says `3` and
`src/foundation/types/config.ts:150` documents "Default 3".

This is the single most consequential default — it decides whether an operator gets
reliability, bonding, metrics, and metadata at all. A user following GUIDE.md omits the
field expecting reliable v3 and silently gets basic v1.

**Fix.** Correct `GUIDE.md:554` and the `config.ts:150` JSDoc to `1`.

### M12. Server mode accepts six sender-only options that no server path reads

`pathFilter`, `pathPrecision`, `pathThrottle`, `brotliQuality`, `useValueDedup`, and
`useCompactDeltas` sit in `commonConnectionProperties`, so both schema builders render them
in server mode and `sanitizeConnectionConfig` keeps them. Every consumer is client-side; the
receiver auto-detects the wire format instead (`data-handler.ts:178, 190` call `decodeDelta`
and `undedupDelta` unconditionally). An operator who sets
`pathFilter: {allow:["navigation.*"]}` on a server connection will reasonably believe
inbound data is filtered. It is not. `heartbeatInterval` is likewise retained on server
configs while the other client-only fields are stripped.

**Fix.** Move the six into the client branch of both schema builders and add them to the
server-mode strip/reject lists.

### M13. Hot-path: SHA-256 plus recursive canonicalisation per received update, ~100% discarded

`src/domain/source-registry.ts:315-356`

`upsertSingleUpdate` runs for every update of every received delta. Per update it performs a
full recursive canonicalisation with sorted keys at each level, a `JSON.stringify`, a
`crypto.createHash("sha256")`, and ~9 `chooseValue` comparisons each doing two more
`JSON.stringify` calls. It then compares the hash and — in the overwhelmingly common case,
since an instrument's identity is constant for the life of the link — discards all of it.

Measured at roughly **9.9 µs per received update**: ~1% of an x86 core at 1000 deltas/s,
and closer to 8% on a Pi-class ARM gateway. `crypto.createHash` dominates; OpenSSL context
setup is ~6 µs regardless of input size. The code's own comment calls this "a
content-addressable dedup hash, not a security boundary".

**Fix.** Add a cheap pre-check on `$source`/`source`/`timestamp` before hashing; replace
SHA-256 with a non-cryptographic rolling hash; add a `===` fast path in `chooseValue` for
the primitive fields.

### M14. Every outbound delta is sanitized twice

`src/app/connection/process-delta.ts:136` sanitizes each delta and pushes the sanitized
result into `state.deltas`; `reliable-client/delta-sender.ts:111` then re-sanitizes the
whole batch. The second pass is not free even when nothing changes —
`sanitizeUpdateForSignalK` allocates a fresh `values` array per update and a fresh
`sanitizedUpdates` array per delta _before_ the unchanged early-return. At 500 deltas/s
that is ~1000 wasted array allocations per second plus a full redundant traversal.

**Fix.** Drop the second call on the reliable client path (keep it for v1 and server ingest,
where input is untrusted), or tag the batch as pre-sanitized.

---

## Low

### L1. Client socket recovery is 38% function-covered

`src/app/connection/socket-recovery.ts` — 61% statements, 42% branches, 38% functions.
`recoverClientSocket`, `scheduleRetry`, `resumeAfterRecovery`, and `dropSocket` have no
direct tests. This is the code that keeps a link alive across a NIC flap, and the untested
parts include the exponential backoff and the two `isShuttingDown()` guards that stop a
recovery timer from resurrecting a stopped connection.

### L2. `startHeartbeat` tests cannot detect a missing timer

`__tests__/pipeline-v2-client.test.js:157-171` asserts only `typeof hb.stop === "function"`.
If the interval were never armed, or `stop()` never called `clearInterval`, both tests pass
— meaning a dead NAT keepalive or a timer leak on every socket recovery. The block 40 lines
above gets this exactly right for congestion control using `jest.getTimerCount()`.

### L3. Server-mode socket errors are terminal

`src/app/connection/start-server.ts:17-36` closes the socket and sets an error status with
no recovery loop, unlike client mode. A transient `ENETDOWN` from an interface flap
permanently kills the listener for the process lifetime.

### L4. State-changing POST routes lack the `requireJson` gate

`POST /capture/start`, `/capture/stop`, `/bonding/failover`,
`/connections/:id/bonding/failover`, and `DELETE /instances/:id` omit `requireJson`, whose
content-type requirement forces a CORS preflight. Combined with the documented fail-open
default, a page an operator visits can issue a simple-form POST at the LAN address and
enable packet capture or force a failover. Separately, `requireJson` runs _before_
`authorizeManagement` on the `/instances` routes, so unauthenticated callers get 415 rather
than 401.

### L5. Retransmit abandonment is silent

`src/transport/reliability/retransmit-queue.ts:187-191` deletes an entry at
`maxRetransmits` with no metric and no log. This is unrecoverable data loss and it is what
manufactures the permanent hole in H2. `receiveNAK` logs only the retransmitted count, so a
NAK for 60 sequences that returns 0 looks identical to a no-op.

### L6. Metadata chunks are lost to ordinary reordering

`src/transport/pipeline/reliable-server/metadata.ts:104-140` tracks a single `lastEnvSeq`.
Chunk arrival order 5.0, 5.1, 6.0, 5.2 — one reordering, normal on a bonded or multi-hop
path — causes chunk 5.2 to be dropped as stale. Recovery depends on the next periodic
snapshot.

### L7. Late retransmits past the reorder window are re-injected

`sequence.ts:141-158` classifies a packet older than `maxOutOfOrder` (100) as a late
arrival with `duplicate: false`, and `trackDataSequence` only stops on `duplicate`, so the
delta is dispatched twice. The replay window usually masks this — except when
`guard.epoch === 0`, which is exactly the C2 and lost-HELLO case.

### L8. HELLO is sent once with no retry

`reliable-client/lifecycle.ts:101-120` swallows its own send error; there is no ACK, retry,
or backoff. On a link that drops the first datagram, `guard.epoch` stays 0 for the session's
life and the replay window is inert, with no operator signal.

### L9. Advanced-settings disclosure never engages

`PluginConfigurationPanel.tsx:295-297` treats any `ADVANCED_BOOL_KEYS` entry equal to `true`
as advanced, and `authenticatedHeaders` has schema `default: true`
(`connection-schema.ts:75`), which `getDefaultFormState` materialises on every load. So
every connection opens with the full ~30-field advanced form, contradicting the function's
own doc comment. Not caught because `__tests__/PluginConfigurationPanel.test.js:43` mocks
`getDefaultFormState` to a pass-through, so the test asserting "hides advanced fields by
default" passes while production does the opposite.

### L10. Metrics polling swallows every error

`src/webapp/hooks/useMetricsPolling.ts:25-28` drops all non-2xx and catches everything
including the 401 `ApiError`; `useConnections.ts:20-25` then fabricates a `_legacy`
connection on any failure. With a wrong token, a 429, or a stopped plugin, the operator gets
a fully-rendered dashboard whose metrics card reads "Loading metrics…" indefinitely, with no
notification.

### L11. `SubscriptionCard` destroys per-path subscription options

`cards/SubscriptionCard.tsx:26, 41` reduces each entry to `{ path }`, discarding `period`,
`minPeriod`, `policy`, and `format` — all honoured by
`subscription-manager.ts:267`. Opening the card and clicking Save with no changes silently
strips them. The JSON editor compounds this: the 300 ms parse at `:80-101` re-serializes the
textarea, moving the caret and dropping anything `buildJson` does not emit.

### L12. Migration validates before sanitizing, inverting startup order

`src/scripts/migrate-config.ts:50` validates then sanitizes; startup does the reverse
(`connection-manager/start.ts:83, 86`). A legacy v2 config carrying `testAddress`/`testPort`
throws in `npm run migrate:config` but loads fine at startup — and the repo still ships
`samples/v2-with-bonding.json` at `protocolVersion: 2`. Migration is otherwise idempotent
and lossless (verified).

### L13. Additional configuration parity gaps

- `brotliQuality`, `pathFilter`, `pathPrecision`, `pathThrottle` are implemented, validated,
  and rendered in both UIs but documented nowhere, though
  `docs/configuration-reference.md:3` bills itself as complete. `pathPrecision` is lossy and
  carries no warning.
- `heartbeatInterval`'s documented range (1000–120000 in both
  `configuration-reference.md:44` and `GUIDE.md:568`) contradicts the enforced minimum of
  5000 — a doc-following config is rejected on save.
- `configuration-reference.md:318` documents a rule ("Basic/v1 clients must not include
  `heartbeatInterval`") that is not enforced.
- `src/foundation/types/config.ts` JSDoc contradicts the schema on five defaults, most
  dangerously `authenticatedHeaders` ("Default false" vs schema `true`); `pingIntervalTime`
  is documented in ms when it is minutes.
- `brotliQuality` is `type: "number"` in the schema but requires an integer at validation,
  so the UI accepts `6.5` and the save fails.
- Toggling server↔client in the UI drops six common settings, because `SHARED_FIELDS`
  (`PluginConfigurationPanel.tsx:242`) is hand-maintained.

### L14. CLI has no request timeout

`src/bin/edge-link-cli.ts:265-297` never calls `req.setTimeout`, so a hung server leaves the
CLI blocked indefinitely. Minor adjacent issues: `instances show` prints a one-element array
in JSON mode despite documenting "Print one instance"; `parsePositiveInt` accepts `12abc` as
`12`; a `--token` value is visible in the process list.

### L15. Documentation and planning drift

`.planning/codebase/CONCERNS.md` cites `docs/code-review-2026-04-29.md` and
`docs/code-quality-report.md` as evidence — neither exists. Its `last_mapped_commit` is
`a75c933` and it still describes the package as version 2.5.0 (now 3.1.0) and flags
architecture-doc filename drift that has since been fixed. Three docs reference
`docs/pr-records/`, which does not exist; `docs-existence.test.js` only validates
`docs/*.md` links from README, so directory references are unguarded. `check-release-truth.js`
applies its stale-version scan to `GUIDE.md` and `docs/README.md` but not
`docs/api-reference.md`, which carries the same marker.

### L16. Real-timer races in the test suite

`__tests__/v2/sequence.test.js:189, 207-211, 236, 278-282` run NAK-timeout logic on wall
clock with ~20 ms margins; a >60 ms event-loop stall flips the assertion. Similar sleeps in
`feedback-filter.test.js:66`, `index.test.js:383`, `integration-pipe.test.js:607`,
`config.test.js:62`. The same file already uses `jest.useFakeTimers()` at `:565`. No
fixed-port binds or cross-file shared state were found, so `--runInBand` is not load-bearing
for correctness — the sleeps are the flake source.

---

## Verified sound

Worth recording, because several of these were plausible failure candidates:

- **Nonce/IV uniqueness** — fresh `randomBytes(12)` per `encryptBinary`; no counter- or
  epoch-derived nonce anywhere, so reconnects, socket recovery, and epoch resets cannot
  cause reuse.
- **Decompression bombs** — `maxOutputLength: MAX_DECOMPRESSED_SIZE` is passed at all three
  decompress sites before any parse.
- **Packet parser bounds** — every read is inside the validated 15-byte header;
  `payloadLength` is compared against actual bytes and never used to size an allocation.
- **uint32 serial arithmetic** — `_isAhead`/`_isBehind`, `ReplayWindow.accept`, and
  `acknowledgeRange` all use correct half-range comparison, with genuine wraparound tests.
- **Token comparison** — SHA-256 both sides then `timingSafeEqual`, length-safe.
- **Fail-closed management auth** — `resolveAuthOptions().readError` returns 503; the
  persisted-config fallback survives `stop()`; `managementApiToken` is preserved across every
  save path.
- **Path traversal** — `getConfigFilePath` is a closed switch; `req.params.filename` never
  reaches the filesystem.
- **Secret leakage** — no `secretKey`/`managementApiToken` in any log or metric; config
  routes redact both; packet capture stores only ciphertext; Prometheus label escaping is
  correct (backslash, then newline, then quote).
- **XSS and browser tokens** — no `dangerouslySetInnerHTML`, `innerHTML`, `eval`, or
  `new Function` in the webapp; the token is header-only and `includeTokenInQuery` defaults
  to false.
- **Protocol version negotiation** — nothing to downgrade: supported versions is `{3}`, and
  a cleared `AUTHENTICATED_HEADER` flag is rejected rather than falling back.
- **Protocol spec fidelity** — `docs/protocol-v3-spec.md` matches
  `src/codec/packet/constants.ts` exactly on magic bytes, header offsets, all eight packet
  types, all five flag bits, and the CRC range (bytes 0–12, verified in both builder and
  parser).
- **Conformance vectors** — genuinely strong. They rebuild from source and compare
  byte-for-byte against a committed golden file, cover 7 flag combinations × DATA/METADATA,
  all six control packet types, HMAC tags, and pin PBKDF2 iterations via a frozen AEAD
  ciphertext. CI regenerates and diffs, so silent regeneration cannot slip through.
- **Bounded caches and teardown** — source registry (LRU+TTL), value dedup (10 000 LRU),
  bandwidth history, recent errors, latency tracker, packet capture; server session teardown
  clears per-session NAK timers on both idle expiry and `stopServer`; `BondingManager.stop()`
  clears timers, sockets, and buffers; the config watcher debounces at 300 ms.
- **Layering** — no upward imports from `foundation/`, `codec/`, or `domain/` into `app/`,
  `transport/`, or `routes/`. Exactly one import cycle exists
  (`reliable-client/lifecycle → control-packets → reliability → lifecycle`).

## Suggested order of work

1. C1 and C2 — replay protection is not delivering what the docs promise.
2. H1 — reflection and recovery suppression share the same root cause as C1.
3. H4 and H6 — cheap test fixes that stop the next auth or integrity regression shipping green.
4. H2, H3 — the ARQ stall pair; H3 is a two-line reorder that removes one of H2's triggers.
5. H7, H8 — lifecycle races, before they compound into orphaned sockets in the field.
6. M1 — get CI green so a red run means something again.
7. M10–M12 and L13 — configuration and documentation parity.
8. M13, M14 — hot-path cost, once correctness is settled.
