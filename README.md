# Signal K Edge Link

Secure, reliable UDP data transmission between Signal K servers with advanced bandwidth optimization, automatic failover, and comprehensive monitoring.

[![Tests](https://img.shields.io/badge/tests-743%2B%20passed-brightgreen)](https://github.com/KEGustafsson/signalk-edge-link)
[![Version](https://img.shields.io/badge/version-2.0.0-blue)](https://github.com/KEGustafsson/signalk-edge-link)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen)](https://nodejs.org/)

![Data Connector Concept](https://raw.githubusercontent.com/KEGustafsson/signalk-edge-link/refs/heads/main/doc/dataconnectorconcept.jpg)

**Create a digital twin of your vessel in the cloud.** Signal K Edge Link sends vessel data from an onboard Signal K server to a remote cloud server using UDP — designed for challenging network conditions where TCP struggles, such as cellular network edge areas with intermittent connectivity. Data is queued and transmitted when the network allows, keeping latency low and bandwidth usage minimal. All traffic is encrypted and outbound-only, requiring no open inbound ports on the vessel. Simple to configure, efficient to run.

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
  - [Installation](#installation)
  - [Quick Start](#quick-start)
- [Configuration](#configuration)
  - [Server Mode](#server-mode-receiver)
  - [Client Mode](#client-mode-sender)
  - [Web Dashboard](#web-dashboard)
  - [Configuration Files](#configuration-files)
- [Network Monitoring](#network-monitoring)
- [Performance](#performance)
  - [Bandwidth Comparison](#bandwidth-comparison)
  - [Smart Batching](#smart-batching)
  - [Optimization Tips](#optimization-tips)
- [Security](#security)
  - [Encryption](#encryption)
  - [Secret Key Requirements](#secret-key-requirements)
  - [Best Practices](#best-practices)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
  - [Architecture](#architecture)
  - [Project Structure](#project-structure)
  - [Build Commands](#build-commands)
  - [Testing](#testing)
  - [Technical Reference](#technical-reference)
  - [Contributing](#contributing)
- [License](#license)

---

## Overview

Signal K Edge Link is a Signal K Node Server plugin that enables real-time data sharing between vessels or shore stations over UDP. It combines AES-256-GCM authenticated encryption with Brotli compression to deliver secure, bandwidth-efficient transmission — achieving up to **97% bandwidth reduction** compared to raw data.

**Key capabilities:**

| Feature | Description |
|---------|-------------|
| Encrypted transport | AES-256-GCM authenticated encryption with per-message unique IV |
| Brotli compression | Quality-10 compression with 85–97% reduction on typical data |
| Binary protocol | Zero JSON overhead in the wire format |
| Path dictionary | 170+ Signal K paths mapped to numeric IDs (10–20% savings) |
| MessagePack | Optional binary serialization (15–25% additional savings) |
| Smart batching | Adaptive packet sizing that prevents UDP fragmentation |
| v2 protocol | Binary packet headers with ACK/NAK retransmission (>99.9% delivery) |
| Congestion control | AIMD algorithm auto-adjusts send rate based on network conditions |
| Connection bonding | Primary/backup failover between LTE and satellite links |
| Monitoring | 30+ metrics, Prometheus export, alerts, packet capture |
| Sentence filtering | Exclude NMEA sentences (GSV, GSA, etc.) to reduce bandwidth |
| Network monitoring | RTT, jitter, packet loss, link quality score |
| Web dashboard | Real-time bandwidth, compression, and path analytics |
| Hot-reload config | Configuration files reload automatically on change |

---

## Getting Started

### Installation

```bash
cd ~/.signalk/node_modules/
git clone https://github.com/KEGustafsson/signalk-edge-link.git
cd signalk-edge-link
npm install
npm run build
```

Restart your Signal K server after installation.

### Quick Start

1. Open **Admin UI → Plugin Config → Signal K Edge Link**
2. Choose an operation mode:
   - **Server** — receives data from remote clients
   - **Client** — sends data to a remote server
3. Set the **UDP port** (must match between client and server)
4. Enter a **32-character encryption key** (must be identical on both ends)
5. For client mode, enter the **server IP address**
6. Enable the plugin and verify data flow in the web dashboard

> **Tip:** Start with the default settings. Enable path dictionary and MessagePack later for additional bandwidth savings.

---

## Configuration

The plugin provides a custom React-based configuration UI that dynamically adapts to the selected operation mode, showing only relevant settings.

**Access:** Admin UI → Plugin Config → Signal K Edge Link

### Server Mode (Receiver)

| Setting | Description |
|---------|-------------|
| Operation Mode | Server/Client selector |
| UDP Port | Port to listen on (1024–65535) |
| Encryption Key | 32-character secret key |
| MessagePack | Enable binary serialization |
| Path Dictionary | Enable path encoding |

### Client Mode (Sender)

| Setting | Description |
|---------|-------------|
| Operation Mode | Server/Client selector |
| UDP Port | Port to send to |
| Encryption Key | 32-character secret key (must match server) |
| Destination Address | Server IP or hostname |
| Heartbeat Interval | Keep-alive message frequency (seconds) |
| Connectivity Test Target | Address to ping for network monitoring |
| Connectivity Test Port | Port to test (80, 443, etc.) |
| Check Interval | How often to test connectivity (minutes) |
| MessagePack | Enable binary serialization |
| Path Dictionary | Enable path encoding |

Additional client settings are available in the web dashboard:
- **Delta timer** — collection interval (100–10000 ms)
- **Subscription paths** — Signal K paths to transmit
- **Sentence filter** — NMEA sentences to exclude (e.g., `GSV, GSA, VTG`)

### Web Dashboard

**Access:** `http://[signalk-server]:3000/plugins/signalk-edge-link`

The dashboard provides real-time monitoring and configuration controls.

**Client mode:**
- Delta timer and subscription management
- Sentence filter configuration
- Upload/download bandwidth with compression ratio
- Bandwidth savings display (actual bytes saved)
- Path analytics with per-path data volume breakdown
- Performance metrics (errors, uptime, deltas sent)
- Rate history chart (last 150 seconds)

**Server mode:**
- Download bandwidth and packet rate
- Bandwidth savings display
- Incoming path analytics
- Performance metrics (deltas received, errors)
- Compression effectiveness tracking

### Configuration Files

These JSON files are stored in the plugin data directory and support hot-reload — changes take effect automatically without restarting.

| File | Purpose | Default |
|------|---------|---------|
| `delta_timer.json` | Collection interval in ms | `{"deltaTimer": 1000}` |
| `subscription.json` | Signal K paths to subscribe | `{"context": "*", "subscribe": [...]}` |
| `sentence_filter.json` | NMEA sentences to exclude | `{"sentences": []}` |

### API Endpoints

All endpoints are rate-limited to 20 requests per minute per IP.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/plugins/signalk-edge-link/config/:filename` | Read a configuration file |
| POST | `/plugins/signalk-edge-link/config/:filename` | Update a configuration file |
| GET | `/plugins/signalk-edge-link/metrics` | Real-time statistics and performance data |
| GET | `/plugins/signalk-edge-link/paths` | Path dictionary information |
| GET | `/plugins/signalk-edge-link/plugin-config` | Current plugin configuration |
| POST | `/plugins/signalk-edge-link/plugin-config` | Update plugin configuration |
| GET | `/plugins/signalk-edge-link/plugin-schema` | Plugin schema definition |

---

## Network Monitoring

In client mode, the plugin measures **Round Trip Time (RTT)** using TCP ping to monitor connectivity and latency.

**How it works:**
1. TCP ping is sent to the configured test address and port at the configured interval
2. RTT is published to local Signal K at `networking.modem.rtt` (value in seconds)
3. If subscribed, RTT data is transmitted to the remote server with other data

**To enable RTT transmission:** Add `networking.modem.rtt` to your subscription paths.

**Use cases:**
- Monitor cellular or satellite modem latency
- Track connection quality over time
- Trigger alerts on high latency
- Analyze network performance trends

---

## Performance

### Bandwidth Comparison

![Data Rate Comparison](https://raw.githubusercontent.com/KEGustafsson/signalk-edge-link/refs/heads/main/doc/datarate.jpg)

| Mode | Bandwidth | Reduction vs. WebSocket |
|------|-----------|------------------------|
| 1000 ms collection | ~44.1 kb/s | ~70% |
| 100 ms collection | ~107.7 kb/s | ~28% |
| WebSocket real-time | ~149.5 kb/s | — |

Typical compression results on Signal K data:

```
Original: 19,293 bytes → Encrypted + Compressed: 622 bytes (96.78% reduction)
```

### Smart Batching

The plugin uses adaptive smart batching to keep UDP packets under the MTU limit (1400 bytes), preventing fragmentation that can cause data loss.

1. **Rolling average** — tracks bytes-per-delta using exponential smoothing
2. **Dynamic batch sizing** — calculates optimal deltas per packet based on recent sizes
3. **Early send trigger** — sends immediately when a batch reaches the predicted size limit
4. **Self-learning** — continuously adapts as data patterns change

```
Example: Initial estimate 5 deltas/batch → After learning: 11 deltas/batch
         All packets stay well under 1400 bytes
```

### Optimization Tips

For the best bandwidth efficiency:

1. **Increase delta timer** — 1000 ms gives optimal compression; lower values increase bandwidth
2. **Enable path dictionary** — saves 10–20% by replacing path strings with numeric IDs
3. **Enable MessagePack** — saves 15–25% with binary serialization
4. **Filter NMEA sentences** — exclude GSV, GSA, VTG to remove unnecessary data
5. **Review subscriptions** — subscribe only to paths you need

---

## Security

### Encryption

All data is encrypted with **AES-256-GCM**, providing authenticated encryption in a single operation.

| Property | Detail |
|----------|--------|
| Algorithm | AES-256-GCM |
| IV | 12 bytes, unique per message |
| Auth tag | 16 bytes, tamper detection |
| Wire format | `[IV (12 bytes)][Encrypted Data][Auth Tag (16 bytes)]` |
| Overhead | 28 bytes per packet |

**Security features:**
- Tamper detection — any modification causes decryption failure
- Rate-limited API endpoints (20 req/min/IP)
- Input validation on all parameters
- Key entropy checking — rejects weak keys
- XSS protection in the web UI
- Stateless UDP — no session state to compromise

### Secret Key Requirements

- Exactly **32 characters** (256 bits)
- Minimum **8 unique characters**
- Must match on both client and server

Generate a secure key:

```bash
openssl rand -base64 32 | cut -c1-32
```

**Valid examples:**
```
Abc123!@#XYZ456$%^uvw789&*()pqr0
K9#mP2$nQ7@rS4%tU6^vW8*xY3!zA5&
abcdefgh12345678901234567890abcd
```

**Invalid examples:**
```
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa   # All same character
abababababababababababababababab   # Insufficient diversity
MySecretKey123                     # Too short
```

### Best Practices

1. Use strong, randomly generated keys (`openssl rand` recommended)
2. Never commit keys to version control
3. Rotate keys periodically (every 6–12 months)
4. Monitor logs for decryption failures (may indicate attacks or key mismatch)
5. Restrict UDP access with firewall rules to known IP addresses
6. Test configuration in a safe environment before production deployment

---

## Troubleshooting

### Plugin Not Loading

- Verify `npm install` completed successfully
- Check Signal K server logs for errors
- Ensure plugin directory is `~/.signalk/node_modules/signalk-edge-link`
- Verify Node.js version ≥ 14.0.0

### Web UI Not Accessible

- Run `npm run build` to generate UI files
- Verify `public/` directory exists with built files
- Clear browser cache and refresh

### No Data Transmission

**Client side:**
1. Confirm encryption keys match on both ends
2. Verify UDP port and destination address
3. Check firewall allows UDP traffic on the configured port
4. Confirm subscription paths are valid Signal K paths
5. Verify delta timer is running (check metrics in web dashboard)

**Server side:**
1. Verify UDP port is not blocked by firewall
2. Confirm encryption key matches the client
3. Check Signal K logs for decryption errors
4. Verify client is sending data (check client metrics)

**Common error messages:**

| Message | Cause |
|---------|-------|
| `Unsupported state or unable to authenticate data` | Mismatched encryption keys |
| `Invalid packet size` | Corrupted data or network issues |
| `Secret key must be exactly 32 characters` | Invalid key length |

### Poor Performance

- Increase delta timer for better compression (1000 ms recommended)
- Enable path dictionary and MessagePack
- Filter unnecessary NMEA sentences
- Check network latency with the ping monitor
- Monitor CPU usage (Brotli compression at quality 10 is CPU-intensive)

### Debug Logging

Enable in Signal K plugin settings to see:
- Connection monitor status and ping results
- Configuration file changes (automatic reload)
- Delta transmission statistics
- Compression ratios and packet sizes
- Error messages with full context

---

## Development

### Architecture

**Data pipeline:**

```
Client (Sender):
  Signal K Deltas → Filter → [Path Encode] → [MessagePack] → Brotli → AES-256-GCM → UDP

Server (Receiver):
  UDP → AES-256-GCM → Brotli → [MessagePack] → [Path Decode] → Signal K
```

The plugin core is decomposed into focused modules:

| Module | Responsibility |
|--------|---------------|
| `index.js` | Plugin entry point, shared state, file watchers, lifecycle |
| `lib/constants.js` | Shared constants and batch size calculation |
| `lib/CircularBuffer.js` | Fixed-size circular buffer for O(1) metrics history |
| `lib/crypto.js` | AES-256-GCM encryption and decryption |
| `lib/metrics.js` | Bandwidth tracking, path analytics, error recording |
| `lib/pathDictionary.js` | Signal K path encoding (170+ paths) |
| `lib/pipeline.js` | v1: compress → encrypt → send / receive → decrypt → decompress |
| `lib/packet.js` | v2: binary packet protocol (headers, CRC16, types) |
| `lib/sequence.js` | v2: sequence tracking and loss detection |
| `lib/retransmit-queue.js` | v2: packet retransmission queue |
| `lib/pipeline-factory.js` | v2: pipeline version selector |
| `lib/pipeline-v2-client.js` | v2: client pipeline with packet building |
| `lib/pipeline-v2-server.js` | v2: server pipeline with packet parsing |
| `lib/congestion.js` | v2: AIMD congestion control algorithm |
| `lib/bonding.js` | v2: connection bonding with failover |
| `lib/monitoring.js` | v2: packet loss, latency, alerts |
| `lib/packet-capture.js` | v2: pcap export and live inspection |
| `lib/metrics-publisher.js` | v2: Signal K metrics publishing |
| `lib/prometheus.js` | v2: Prometheus metrics export |
| `lib/routes.js` | HTTP route handlers, rate limiting, config file I/O |

Modules are wired together via factory functions that receive a shared `state` object by reference, enabling cross-module state access without globals.

### Project Structure

```
signalk-edge-link/
├── index.js                    # Plugin entry, state, watchers, lifecycle
├── lib/
│   ├── CircularBuffer.js       # Fixed-size circular buffer
│   ├── constants.js            # Shared constants and utilities
│   ├── crypto.js               # AES-256-GCM encryption module
│   ├── metrics.js              # Metrics, bandwidth, path analytics
│   ├── pathDictionary.js       # Signal K path encoding (170+ paths)
│   ├── pipeline.js             # v1 pack/unpack pipeline
│   ├── packet.js               # v2 binary packet protocol
│   ├── sequence.js             # v2 sequence tracking
│   ├── pipeline-factory.js     # v2 pipeline version selector
│   ├── pipeline-v2-client.js   # v2 client pipeline
│   ├── pipeline-v2-server.js   # v2 server pipeline
│   └── routes.js               # HTTP routes and rate limiting
├── src/
│   ├── webapp/
│   │   ├── index.js            # Web dashboard (vanilla JS)
│   │   └── styles.css
│   └── components/
│       └── PluginConfigurationPanel.jsx  # React config panel
├── __tests__/                  # 743+ tests across 23 files
│   ├── crypto.test.js
│   ├── pathDictionary.test.js
│   ├── compression.test.js
│   ├── full-pipeline.test.js
│   ├── smartBatching.test.js
│   ├── config.test.js
│   ├── index.test.js
│   ├── webapp.test.js
│   ├── integration-pipe.test.js
│   └── v2/                     # v2 protocol tests (14 files)
│       ├── packet.test.js
│       ├── sequence.test.js
│       ├── bonding.test.js
│       ├── congestion.test.js
│       ├── monitoring.test.js
│       └── ...
├── test/
│   ├── integration/            # v2 integration tests
│   ├── benchmarks/             # Performance benchmarks
│   └── network-simulator.js    # Network condition simulator
├── scripts/
│   └── migrate-config-v2.js    # v1 → v2 config migration tool
├── docs/                       # Documentation
│   ├── protocol-v2-spec.md     # v2 protocol specification
│   ├── api-reference.md        # REST API reference
│   ├── configuration-reference.md  # Full config reference
│   ├── troubleshooting.md      # Troubleshooting guide
│   ├── migration/
│   │   └── v1-to-v2.md         # Migration guide
│   └── performance/            # Performance results
├── grafana-dashboard.json      # Pre-built Grafana dashboard
└── public/                     # Built UI files (generated)
```

### Build Commands

```bash
npm run dev            # Development build with watch mode
npm run build          # Production build
npm test               # Run all tests
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Generate coverage report
npm run lint           # Check code style
npm run lint:fix       # Auto-fix linting issues
npm run format         # Format code with Prettier
npm run test:v2        # Run v2 protocol tests only
npm run test:integration  # Run integration tests only
```

### Testing

The test suite covers all critical paths with 743+ tests across 27 files:

| Test file | Scope |
|-----------|-------|
| `crypto.test.js` | Encryption, decryption, key validation |
| `pathDictionary.test.js` | Path encoding and decoding |
| `compression.test.js` | Brotli compression effectiveness |
| `full-pipeline.test.js` | End-to-end compression + encryption round-trip |
| `smartBatching.test.js` | Rolling average, batch limits, size verification |
| `config.test.js` | Configuration file creation, loading, hot-reload |
| `index.test.js` | Plugin lifecycle, schema validation |
| `webapp.test.js` | Web UI metrics and API endpoints |
| `integration-pipe.test.js` | Full input → backend → frontend data flow |
| `v2/packet.test.js` | v2 packet building, parsing, CRC16, all types |
| `v2/sequence.test.js` | Sequence tracking, gap detection, NAK scheduling |
| `v2/bonding.test.js` | Connection bonding, failover/failback |
| `v2/congestion.test.js` | AIMD congestion control algorithm |
| `v2/monitoring.test.js` | Packet loss, latency, retransmission tracking |
| `v2/prometheus.test.js` | Prometheus metrics export |
| `integration/pipeline-v2-e2e.test.js` | v2 pipeline end-to-end round-trips |
| `integration/system-validation.test.js` | Full system validation |

Run a specific test suite:

```bash
npm test -- crypto.test.js
npm test -- full-pipeline.test.js
npm test -- --coverage
```

### Technical Reference

**v1 Packet format:**

```
[IV (12 bytes)][Encrypted Data][Auth Tag (16 bytes)]
Total overhead: 28 bytes per packet
```

**v2 Packet format:**

```
[Magic 2B][Ver 1B][Type 1B][Flags 1B][Seq 4B][Len 4B][CRC16 2B][Payload...]
Total header: 15 bytes + 28 bytes encryption overhead = 43 bytes per packet
```

See [Protocol v2 Specification](docs/protocol-v2-spec.md) for details.

### Documentation

| Document | Description |
|----------|-------------|
| [Protocol v2 Specification](docs/protocol-v2-spec.md) | Complete binary protocol specification |
| [API Reference](docs/api-reference.md) | REST API endpoint documentation |
| [Configuration Reference](docs/configuration-reference.md) | All settings with defaults and ranges |
| [Migration Guide](docs/migration/v1-to-v2.md) | Upgrading from v1 to v2 |
| [Troubleshooting](docs/troubleshooting.md) | Common issues and solutions |
| [CHANGELOG](CHANGELOG.md) | Release history and changes |

**Compression pipeline (detailed):**

```
Client side:
  JSON.stringify(delta)           → Serialization
  → [pathDictionary.encode()]     → Optional: numeric path IDs
  → [msgpack.encode()]            → Optional: binary format
  → brotli.compress(quality=10)   → Maximum compression
  → encryptBinary(key)            → AES-256-GCM
  → UDP send

Server side:
  UDP receive
  → decryptBinary(key)            → Verify + decrypt
  → brotli.decompress()
  → [msgpack.decode()]
  → [pathDictionary.decode()]
  → JSON.parse()
  → Signal K handleMessage()
```

**Smart batching constants:**

| Constant | Value | Purpose |
|----------|-------|---------|
| Safety margin | 85% | Target 85% of MTU (1190 bytes effective) |
| Smoothing factor | 0.2 | Rolling average weight (20% new, 80% old) |
| Initial estimate | 200 bytes | Starting bytes-per-delta assumption |
| Min deltas | 1 | Always send at least 1 delta |
| Max deltas | 50 | Cap to prevent excessive batching latency |

**Performance characteristics:**

| Metric | Value |
|--------|-------|
| Compression ratio | 85–97% on typical Signal K data (21.6x at 50 deltas/batch) |
| Full pipeline latency (p99) | 2.07 ms (serialize → compress → encrypt → decrypt) |
| Throughput | 10–100 Hz update rates |
| Delivery rate @ 5% loss | >99.9% with ACK/NAK retransmission |
| Dual-link failover time | <2 seconds |
| Memory | Constant O(1) with bounded circular buffers |

### Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/name`
3. Make changes and add tests
4. Run `npm test` and `npm run lint` (all must pass)
5. Run `npm run build` (must succeed)
6. Commit with clear messages using conventional format
7. Submit a pull request

**Requirements for all contributions:**
- All tests pass
- No ESLint errors or warnings
- Code formatted with Prettier
- Test coverage for new features
- README updated if adding features

**Commit message format:**

```
type: description

Types: feat, fix, docs, style, refactor, perf, test, chore
```

---

## License

MIT License — Copyright (c) 2024 Karl-Erik Gustafsson

See [LICENSE](LICENSE) file for details.
