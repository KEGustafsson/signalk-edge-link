# Web UI Guide

Signal K Edge Link has two browser pages:

| Page                    | Where                                                            | Purpose                                                      |
| ----------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------ |
| **Configuration panel** | Signal K Admin → **Server → Plugin Config → Signal K Edge Link** | Create and edit connections. Saving restarts the plugin.     |
| **Runtime dashboard**   | `http://<signalk-host>:3000/plugins/signalk-edge-link/`          | Live metrics, runtime file editors, manual bonding failover. |

Field meanings, defaults and ranges are in [configuration-reference.md](configuration-reference.md); metric definitions are in [metrics.md](metrics.md). The dashboard calls the management API and needs the management token when one is set: see [management-tools.md](management-tools.md).

---

## 1. Configuration panel (Admin → Plugin Config)

### Layout

1. **Intro line:** one connection per link; Server mode receives, Client mode sends; both ends must use the same key and protocol.
2. **Plugin Security Settings:** **Management API Token** (password input; the `SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN` environment variable takes priority) and **Require Management API Token**. Leave the token empty and the box unchecked for open access; with the box checked and no token, every management request gets HTTP 403. See [Top-Level Plugin Fields](configuration-reference.md#top-level-plugin-fields).
3. **Connection cards:** one collapsible card per connection with a **Server** or **Client** badge. Click the header to expand it.
4. **Toolbar:** **+ Add Server**, **+ Add Client**, **Save Configuration** (**Save Changes** while there are edits), and a connection count.

### Server and client cards

The **Operation Mode** field (`serverType`) switches the card between the server and client form. Fields common to both modes keep their values across the switch.

| Field                                             | Server card      | Client card      |
| ------------------------------------------------- | ---------------- | ---------------- |
| Connection Name, UDP Port                         | ✓                | ✓                |
| Encryption Key (password input)                   | ✓                | ✓                |
| Protocol Version (Basic v1 / Advanced v3)         | ✓                | ✓                |
| Server Address (`udpAddress`)                     | —                | ✓                |
| Client-only sending options and tuning            | —                | ✓ (advanced)     |
| `requestFullStatusOnRestart`                      | ✓ (v3, advanced) | —                |
| `reliability`, `fleetSharing`                     | ✓ (v3, advanced) | ✓ (v3, advanced) |
| `congestionControl`, `bonding`, `alertThresholds` | —                | ✓ (v3, advanced) |
| v1 ping monitor fields                            | —                | ✓ (v1, advanced) |

### Advanced settings

A card first shows only the essentials: name, mode, UDP port, key, protocol and, on a client, the server address. **▼ Show advanced settings** reveals the rest.

- The advanced section opens on load for a connection whose advanced fields differ from their defaults.
- Collapsing it does not discard hidden values; they are saved unchanged.
- Version-gated fields are removed automatically so the config passes validation: the v1 ping fields (`testAddress`, `testPort`, `pingIntervalTime`) when a client moves to v3, and `useValueDedup` / `useCompactDeltas` when a connection moves to v1.

### Saving

- **You have unsaved changes.** shows while the form has edits.
- Two server connections on the same UDP port are flagged under the card and block the save.
- A successful save restarts the plugin with the new configuration.

---

## 2. Runtime dashboard (`/plugins/signalk-edge-link/`)

Metrics poll continuously on either peer.

### Connection tabs

With more than one connection, a tab bar shows each connection with:

- a status dot: green (server, or client ready to send), amber (client not ready), red (unhealthy);
- an icon: 🖥 server, 📱 client;
- the connection name and type.

With one connection the tab bar is hidden. A connection whose startup failed keeps its tab with a red dot and is retried in the background (30 s backoff, up to 300 s); the dot turns green once it starts.

### Cards by connection type

Cards marked _(v3)_ appear only for Advanced connections.

| Section                 | Card                       | Client | Server | Shows                                                                                                |
| ----------------------- | -------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------------- |
| Configuration           | Delta Timer Configuration  | ✓      | —      | Edits `delta_timer.json` (send interval, ms).                                                        |
| Configuration           | Subscription Configuration | ✓      | —      | Edits `subscription.json`: context, paths, metadata streaming, JSON editor.                          |
| Configuration           | Sentence Filter            | ✓      | —      | Edits `sentence_filter.json` (NMEA sentences not sent).                                              |
| Operations & Monitoring | Performance Metrics        | ✓      | ✓      | Uptime, status, delta and packet counts, error counters, smart batching (client).                    |
| Operations & Monitoring | Network Quality _(v3)_     | ✓      | ✓      | Link Quality gauge, RTT, jitter, packet loss, retransmit rate, queue depth.                          |
| Operations & Monitoring | Bandwidth Monitor _(v3)_   | ✓      | ✓      | Compression ratio, average packet size, throughput sparklines.                                       |
| Operations & Monitoring | Path Analytics _(v3)_      | ✓      | ✓      | Active path count, categories, per-path table.                                                       |
| Operations & Monitoring | Congestion Control _(v3)_  | ✓      | —      | AIMD state and current delta timer.                                                                  |
| Operations & Monitoring | Connection Bonding _(v3)_  | ✓      | —      | Shown when bonding is enabled: per-link status and a manual failover button.                         |
| Operations & Monitoring | Fleet Sharing _(v3)_       | ✓      | ✓      | Shown once fleet sharing has started on the connection. See below.                                   |
| Operations & Monitoring | Monitoring & Alerts _(v3)_ | ✓      | ✓      | Packet loss, retransmissions, alert thresholds. On a server, only when monitoring data is available. |
| Operations & Monitoring | Status                     | ✓      | —      | Summary of the active delta timer, subscription and sentence filter.                                 |
| Advanced                | Full Plugin Configuration  | ✓      | ✓      | JSON editor over `/plugin-config` for settings without a dedicated card.                             |

The three Configuration cards write the runtime files described in [Runtime Configuration Files](configuration-reference.md#runtime-configuration-files-hot-reload); changes apply without a restart.

**Fleet Sharing card.** On a client: state (`active`, `offered`, `declined`, `not-offered`, `disabled`) with a hint for each, vessels known (received in the last 24 h, kept across restarts), values and metadata received, echo suppressed, duplicates and rejections. On a server: state (`active`, or `disabled` after the connection stops), members, values and bytes sent, slowest member pacing (with an explanation below 100%), retransmits, relayed copies dropped, identity conflicts, replayed HELLOs ignored and refused identities. A vessel reconnecting from a new port also counts as an identity conflict, so that counter is not shown as an error. Field definitions: [metrics.md — Fleet Sharing Metrics](metrics.md#fleet-sharing-metrics).

### Reading `N/A` on the Network Quality card

`N/A` means not measured. A `0` on this card is a measured zero.

- **Client:** RTT and Jitter read `N/A` until the first ACK has been timed, and the gauge says "No round trip measured yet". `N/A` with a climbing Queue Depth means traffic leaves and nothing comes back; check Rejected Control Packets next.
- **Server:** a server measures no latency itself; all network-quality figures come from client telemetry. The card reads `N/A` until the first report arrives, and the gauge says "Awaiting client telemetry".
- Each field is reported separately, so one field can be `N/A` while others have values, for example with a peer on an older version or a field the ingest validator rejected.
- **Link Quality** is shown only when RTT, jitter, packet loss and retransmit rate are all present.

### Reading a relay (proxy) node

A relay runs two connections in one Signal K instance: a server that receives hop 1 and a client that forwards hop 2. It shows two tabs, and each tab describes only its own hop.

```text
  [Vessel]  ──hop 1──►  [ Relay ]  ──hop 2──►  [Shore]
                        server tab   client tab
                        (hop 1)      (hop 2)
```

- **Server tab:** the vessel's link. RTT, jitter and Link Quality come from the vessel's client telemetry and read `N/A` until that client reports.
- **Client tab:** the relay's own link to shore, measured from its own ACKs like any client.
- The hops are independent: separate keys, handshakes and epochs, reliability settings and `epochBoundAuth` values. Each hop's two ends must agree; the two hops need not.
- Both ends of a hop must run 4.0.0 or later for that hop to report RTT and jitter, because a receiver reports what its peer sends.
- With fleet sharing, each tab has its own Fleet Sharing card: the server tab shows the fleet of vessels connected to the relay, the client tab shows the relay's membership in the upstream fleet. Which vessels cross the relay: [Relays](configuration-reference.md#fleet-sharing-advancedv3-only).

A healthy relay shows figures on both tabs. Figures on the client tab and `N/A` on the server tab mean hop 2 works and hop 1 has not reported yet; check the vessel upstream.

Each connection publishes its Signal K paths under `networking.edgeLink.<instanceId>.*`, where the instance ID is the slug of the connection name; this keeps the relay's two connections apart. Path list: [metrics.md — Signal K Paths Published](metrics.md#signal-k-paths-published).

### Verifying a healthy link

- **Client:** Deltas Sent increases; Encryption Errors stays at 0; on v3, Auth Failures (V3) stays at 0.
- **Server:** Deltas Received increases; Encryption Errors and, on v3, Auth Failures (V3) stay at 0.
- **Client, Rejected Control Packets:** should be 0. A non-zero value means ACKs and NAKs are discarded before processing, so no RTT is timed, the cumulative ACK stops advancing and the retransmit queue grows. Check that `udpAddress` resolves to the address the server replies from.
- On v3, Network Quality and Monitoring & Alerts show loss, RTT and retransmissions.

---

## Related docs

- [GUIDE.md — Quick Start](GUIDE.md#5-quick-start--minimal-setup): server and client setup
- [configuration-reference.md](configuration-reference.md): every field
- [metrics.md](metrics.md): the metrics behind the cards
- [management-tools.md](management-tools.md): token setup for the dashboard's API calls
- [troubleshooting.md](troubleshooting.md): symptoms and fixes
