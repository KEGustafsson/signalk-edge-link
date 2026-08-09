# Web UI Guide

Signal K Edge Link ships two browser surfaces, both built as a React component
tree (rewritten in 3.0.0):

| Surface                 | Where                                                            | Purpose                                  |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------------- |
| **Configuration panel** | Signal K Admin → **Server → Plugin Config → Signal K Edge Link** | Create and edit connections; save config |
| **Runtime dashboard**   | `http://<signalk-host>:3000/plugins/signalk-edge-link/`          | Live metrics and per-connection controls |

The configuration panel writes the plugin config (and restarts the plugin on
save). The runtime dashboard is read-mostly: it polls live metrics and exposes a
few runtime controls (delta timer, subscriptions, manual failover).

> **Note.** This guide describes the UI layout and behavior to orient new users.
> Specific field names, card titles, and which panels appear are part of an
> evolving UI — for the current, authoritative list, consult the running UI
> itself, [configuration-reference.md](configuration-reference.md) for config
> fields, and [metrics.md](metrics.md) for metric names. Treat the enumerations
> below as illustrative of the structure, not an exhaustive contract.

---

## 1. Configuration panel (Admin → Plugin Config)

This is where you define connections. The panel is embedded into the Signal K
admin page; it is not the same surface as the runtime dashboard.

### Layout

1. **Intro line** — reminds you to add one connection per link, pick Server
   (receive) or Client (send) mode, and that **both ends must use the same
   encryption key and protocol**.
2. **Plugin Security Settings** — applies to the whole plugin, not a single
   connection:
   - **Management API Token** — shared secret protecting the management API
     endpoints. Strongly recommended for production. Can also be set via the
     `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN` environment variable, which takes
     precedence over this field when both are set — so a token can be rotated
     by changing the environment and restarting. Leave both empty for open
     access.
   - **Require Management API Token** — when checked, management requests are
     rejected if no token is configured (fail-closed). When unchecked, requests
     are allowed when no token is set (open access).
3. **Connection cards** — one collapsible card per connection, each tagged with
   a **Server** or **Client** badge. Click the header to expand/collapse.
4. **Toolbar** — **+ Add Server**, **+ Add Client**, and **Save**, plus a live
   count (e.g. "2 connections · 1 server, 1 client").

### Server vs Client cards

Switching the **Connection Type** (`serverType`) field reshapes the form;
shared fields (name, port, key, key-stretch, protocol, authenticated headers)
are preserved across the switch.

| Field                             | Server card  | Client card    |
| --------------------------------- | ------------ | -------------- |
| Connection Name                   | ✓            | ✓              |
| Server Address (`udpAddress`)     | —            | ✓              |
| UDP Port                          | ✓            | ✓              |
| Encryption Key                    | ✓            | ✓              |
| Protocol (Basic v1 / Advanced v3) | ✓            | ✓              |
| `requestFullStatusOnRestart`      | ✓ (advanced) | —              |
| v1 ping-monitor fields            | —            | ✓ (Basic only) |

The encryption key field is a password input; the helper text accepts a
32-character ASCII, 64-character hex, or base64 key.

### Progressive disclosure: "Advanced settings"

By default each card shows only the essentials. A **▼ Show advanced settings**
toggle at the bottom of the card reveals compression, reliability, bonding,
congestion control, alert thresholds, and per-path tuning (precision, throttle,
path filter). Notes on the behavior:

- The advanced section **auto-expands on load** for any connection that already
  uses an advanced option, so deliberately configured settings are never hidden
  from you.
- Collapsing advanced settings **never discards** the values underneath — only
  the visible fields are managed; hidden advanced values are preserved on save.
- Version-gated fields are kept consistent automatically: the v1-only ping
  fields (`testAddress`, `testPort`, `pingIntervalTime`) are dropped when a
  client moves to v3, and the v3-only codec flags (`useValueDedup`,
  `useCompactDeltas`) are dropped on a downgrade to v1 — so a config edited in
  the UI can't carry a stale flag the backend validator would reject.

### Saving

- An **"You have unsaved changes"** banner appears while the form is dirty.
- **Duplicate server ports** are flagged inline and block the save — each server
  connection needs a unique UDP port.
- On a successful save the plugin restarts to apply the new configuration.

---

## 2. Runtime dashboard (`/plugins/signalk-edge-link/`)

Open this on either peer to watch the link live. Metrics poll continuously and
the connection list refreshes with them.

### Connection tabs

When more than one connection is configured, a **tab bar** appears at the top.
Each tab shows:

- a **status dot** — green (healthy / ready to send), amber (client not yet
  ready), or red (unhealthy),
- an **icon** — 🖥 for a server, 📱 for a client,
- the connection **name** and **type**.

With a single connection the tab bar is hidden and that connection is shown
directly. Selecting a tab swaps the dashboard to that connection.

### What you see depends on type and protocol

The dashboard renders a **Server** or **Client** layout based on the active
connection's type, and the richer cards only appear for **Advanced (v3)**
connections. A **Basic (v1)** connection shows just the core metrics (and, on a
client, the Status summary).

#### Client dashboard

Grouped into three sections:

**Configuration** (client-side transmission controls, hot-reloaded):

- **Delta Timer Configuration** — how often deltas are collected and sent (ms).
- **Subscription Configuration** — context and the list of Signal K paths to
  subscribe to, plus metadata-streaming controls (snapshot interval, an optional
  include-paths regex, and max paths per packet) and a JSON editor.
- **Sentence Filter** — NMEA sentences to exclude from transmission to save
  bandwidth.

**Operations & Monitoring:**

- **Performance Metrics** — deltas sent/received, packet counts, error counters
  (always shown).
- **Network Quality** _(v3)_ — a link-quality score gauge and health indicators.
- **Bandwidth Monitor** _(v3)_ — compression ratio, average packet size, and
  throughput sparklines.
- **Path Analytics** _(v3)_ — active path count, categories, and a per-path
  table.
- **Congestion Control** _(v3)_ — AIMD state and delta-timer auto-adjustment.
- **Connection Bonding** _(v3)_ — per-link status and a **manual failover**
  button (primary ↔ backup).
- **Monitoring & Alerts** _(v3)_ — packet loss, retransmission tracking, and
  alert thresholds.
- **Status** — summarizes the active delta timer, subscription, and sentence
  filter.

**Advanced:**

- **Full Plugin Configuration** — a JSON editor over `/plugin-config` for
  parameters not surfaced as dedicated cards.

#### Server dashboard

Servers receive rather than transmit, so they omit the client-only transmission
controls (delta timer, subscriptions, sentence filter) and the client-only
congestion/bonding cards:

**Operations & Monitoring:**

- **Performance Metrics** (always shown).
- **Network Quality**, **Bandwidth Monitor**, **Path Analytics** _(v3)_.
- **Monitoring & Alerts** _(v3, when monitoring data is available)_.

**Advanced:**

- **Full Plugin Configuration** (JSON editor).

### Reading `N/A` on the Network Quality card

`N/A` means **not measured**, and it is deliberately not shown as `0`. The two
are different states and conflating them hid real faults: an unmeasured link
scored a perfect 100 ("Excellent") because zero RTT, zero jitter and zero loss
look ideal to the scoring function — so a client sending into a void with a
growing retransmit queue displayed as the healthiest link on the dashboard.

- **On a client**, `RTT` and `Jitter` read `N/A` until the first ACK has been
  timed. `N/A` beside a climbing `Queue Depth` is the signature of traffic
  leaving and nothing coming back — check `Rejected Control Packets` next.
- **On a server**, every network-quality figure arrives as client telemetry,
  because a server measures no latency of its own. The card reads `N/A` until
  the first telemetry report lands, and the gauge says which of the two reasons
  applies rather than only showing a dash.
- **A field can be `N/A` while its neighbours are populated.** Each is reported
  independently, so a peer running an older build — or one field the ingest
  validator rejected — shows as absent instead of being invented.
- **`Link Quality` is withheld unless all four of its inputs are present**
  (RTT, jitter, packet loss, retransmit rate), since substituting a zero for a
  missing input can only inflate the score.

A `0` on this card is a measured zero and can be trusted as one.

### Reading a relay (proxy) node

A relay runs **two connections in one Signal K instance** — a server that
receives the upstream hop and a client that forwards the downstream one — so it
shows **two tabs**, and each dashboard describes **only its own hop**. Reading
one tab and expecting it to describe the whole chain is the most common source
of confusion here.

```text
  [Vessel]  ──hop 1──►  [ Relay ]  ──hop 2──►  [Shore]
                        server tab   client tab
                        (hop 1)      (hop 2)
```

- The **server tab** shows the vessel's link. Its RTT, jitter and link quality
  all arrive as **telemetry from the vessel's client** — the relay measures no
  latency of its own on that hop — so they read `N/A` until that client reports.
- The **client tab** shows the relay's own link to shore, measured locally from
  its own ACKs, exactly like any other client.
- The two hops are **independent**: separate keys, separate handshakes and
  epochs, separate reliability settings, and separate `epochBoundAuth` values.
  Each hop must agree with itself; the hops need not agree with each other.
- Both ends of **each hop** must run 4.0.0+ before that hop reports RTT and
  jitter, since a receiver never computes them — it reports what its peer sends.

So a healthy relay normally shows populated figures on **both** tabs. Figures on
the client tab with `N/A` on the server tab means hop 2 is fine and hop 1 has
not reported yet — look upstream at the vessel, not at the relay.

When a connection has an instance ID configured, its Signal K paths are
namespaced `networking.edgeLink.<instanceId>.*`, which is how the two
connections on a relay stay distinct. See
[metrics.md](metrics.md) for the full path list.

### Verifying a healthy link

On the **client**, confirm `Deltas Sent` is increasing and encryption errors
stay at `0`; on the **server**, confirm `Deltas Received` is increasing and
decryption errors stay at `0`. For v3 links, the Network Quality and Monitoring
& Alerts cards give you loss, RTT, and retransmission detail.

`Rejected Control Packets` on a client should read `0`. A non-zero value means
ACKs and NAKs are being discarded before they are processed, so no RTT can be
timed, the cumulative ACK freezes and the retransmit queue grows without bound
— check that `udpAddress` names the host the server actually replies from.

---

## Related docs

- [GUIDE.md §5 Quick Start](GUIDE.md) — step-by-step server/client setup
- [configuration-reference.md](configuration-reference.md) — every field, by role
- [metrics.md](metrics.md) — the metrics behind the dashboard cards
- [management-tools.md](management-tools.md) — the API the dashboard calls and
  its token auth
