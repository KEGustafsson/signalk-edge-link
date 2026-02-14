# Migration Guide: v1.0 to v2.0

## Overview

Signal K Edge Link v2.0 is a major release that adds production-grade reliability, monitoring, and resilience to UDP data transmission. The v2 protocol is fully backward compatible with v1 deployments.

**Key principle:** v2 is opt-in. Existing v1 deployments continue to work without changes. You can upgrade at your own pace.

## What's New in v2.0

| Feature | v1.0 | v2.0 |
|---------|------|------|
| Packet protocol | Raw encrypted payload | Binary headers with sequence tracking |
| Reliability | Best-effort UDP | ACK/NAK retransmission (>99.9% delivery) |
| Loss detection | None | Per-packet sequence tracking + NAK |
| Congestion control | Manual delta timer | AIMD algorithm (automatic) |
| Connection bonding | Single link | Primary/backup failover |
| Monitoring | Basic bandwidth stats | 30+ metrics, Prometheus, alerts |
| Packet capture | None | pcap export, live WebSocket inspector |
| Network metrics | TCP ping RTT | RTT, jitter, loss, quality score |

## What Changes

| Aspect | v1 | v2 |
|--------|----|----|
| Packet format | `[IV][Encrypted][AuthTag]` | `[Header(15B)][IV][Encrypted][AuthTag]` |
| Packet overhead | 28 bytes | 43 bytes (+15 byte header) |
| Sequence tracking | None | Per-packet sequence numbers |
| Loss detection | None | Gap detection with NAK scheduling |
| Packet types | Data only | DATA, ACK, NAK, HEARTBEAT, HELLO |
| Version detection | N/A | Magic bytes "SK" + version byte |
| Configuration schema | Basic | Extended with congestion, bonding, monitoring |
| Minimum Node.js | 12.0.0 | 14.0.0 |

## What Stays the Same

- AES-256-GCM encryption (same algorithm, same key format)
- Brotli compression (same quality, same pipeline)
- MessagePack serialization (same library)
- Path dictionary encoding (same dictionary, 170+ paths)
- Smart batching logic (same MTU awareness)
- Configuration UI (same web dashboard, extended with new features)
- All v1 API endpoints (same REST interface, plus new endpoints)
- Plugin ID and Signal K integration

## How to Migrate

### Step 1: Update the Plugin

```bash
cd ~/.signalk/node_modules/signalk-edge-link
git pull origin main
npm install
npm run build
```

### Step 2: Run the Configuration Migration Script

A migration script is provided to update v1 configuration files:

```bash
node scripts/migrate-config-v2.js
```

This script:
- Reads your existing v1 configuration
- Adds v2 default settings (congestion control, bonding disabled by default)
- Preserves all your existing settings
- Creates a backup of the original configuration
- Writes the updated configuration

### Step 3: Configure Protocol Version

In the plugin configuration (Admin UI or JSON), set `protocolVersion` to `2`:

```json
{
  "serverType": "client",
  "udpPort": 4446,
  "secretKey": "your-32-character-key-here......",
  "useMsgpack": false,
  "usePathDictionary": true
}
```

**Both client and server must run v2.0.** The server auto-detects v2 packets by magic bytes, but both sides need the v2 software installed.

### Step 4: Verify

1. Restart Signal K on both client and server
2. Check the web dashboard for data flow
3. Verify sequence numbers incrementing in debug logs
4. Check `GET /metrics` endpoint for network quality data
5. Monitor for loss detection messages in debug logs

### Step 5: Enable v2 Features (Optional)

Once basic v2 is working, consider enabling advanced features:

**Dynamic congestion control:**

```json
{
  "congestionControl": {
    "enabled": true,
    "targetRTT": 200,
    "minDeltaTimer": 100,
    "maxDeltaTimer": 5000
  }
}
```

**Connection bonding (requires two network paths):**

```json
{
  "bonding": {
    "enabled": true,
    "mode": "main-backup",
    "primary": {
      "address": "server.example.com",
      "port": 4446,
      "interface": "192.168.1.100"
    },
    "backup": {
      "address": "server.example.com",
      "port": 4447,
      "interface": "10.0.0.100"
    },
    "failover": {
      "rttThreshold": 500,
      "lossThreshold": 0.10,
      "healthCheckInterval": 1000,
      "failbackDelay": 30000
    }
  }
}
```

## Configuration Changes Detail

### New Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `congestionControl.enabled` | boolean | false | Enable AIMD congestion control |
| `congestionControl.targetRTT` | number | 200 | Target RTT threshold (ms) |
| `congestionControl.minDeltaTimer` | number | 100 | Minimum delta timer (ms) |
| `congestionControl.maxDeltaTimer` | number | 5000 | Maximum delta timer (ms) |
| `bonding.enabled` | boolean | false | Enable connection bonding |
| `bonding.mode` | string | "main-backup" | Bonding operating mode |
| `bonding.primary` | object | - | Primary link configuration |
| `bonding.backup` | object | - | Backup link configuration |
| `bonding.failover` | object | - | Failover threshold settings |

### Removed/Changed Fields

No v1 configuration fields have been removed. All existing settings continue to work.

## New API Endpoints

The following endpoints are new in v2.0:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/network-metrics` | Network quality metrics |
| GET | `/congestion` | Congestion control state |
| POST | `/delta-timer` | Manual delta timer override |
| GET | `/bonding` | Bonding state and link health |
| POST | `/bonding/failover` | Manual failover trigger |
| GET | `/monitoring/packet-loss` | Packet loss heatmap |
| GET | `/monitoring/path-latency` | Per-path latency stats |
| GET | `/monitoring/retransmissions` | Retransmission chart data |
| GET | `/monitoring/alerts` | Alert thresholds and state |
| POST | `/monitoring/alerts` | Update alert thresholds |
| GET | `/monitoring/inspector` | Packet inspector stats |
| GET | `/monitoring/simulation` | Network simulation state |
| POST | `/capture/start` | Start packet capture |
| POST | `/capture/stop` | Stop packet capture |
| GET | `/capture/export` | Export pcap file |
| GET | `/prometheus` | Prometheus metrics |

## Rollback

To revert to v1 behavior:

1. Set `protocolVersion` back to `1` (or remove the setting)
2. Disable congestion control: `congestionControl.enabled = false`
3. Disable bonding: `bonding.enabled = false`
4. Restart Signal K

The v1 pipeline is fully preserved and all v1 tests continue to pass. No data loss occurs during rollback.

## Performance Impact

The v2 header adds 15 bytes per packet. For typical packets of 200-1,400 bytes, this is 1-7% overhead. The reliability features (ACK/NAK) add ~190 B/s of control traffic at typical send rates.

### Overhead Summary

| Component | Overhead |
|-----------|----------|
| v2 header | +15 bytes/packet |
| ACK traffic | ~190 bytes/s |
| Health probes (bonding) | ~12 bytes/s per link |
| Monitoring | <0.1 us/operation CPU |
| Memory (monitoring) | ~1 MB bounded buffers |

## Troubleshooting Migration

### "Invalid magic bytes" Error

The server is receiving v1 packets but expecting v2. Ensure both sides run the v2.0 software.

### "CRC mismatch" Error

The packet header was corrupted in transit. This may indicate network issues. The packet is safely discarded and will be retransmitted.

### "Unsupported protocol version" Error

The packet has v2 magic bytes but a different version number. Ensure both sides run the same plugin version.

### Congestion control not adjusting

Check that `congestionControl.enabled` is `true` in the configuration. Verify via `GET /congestion` that the controller is active and not in manual mode.

### Bonding not failing over

Verify both links have valid addresses and ports. Check `GET /bonding` for per-link health status. Ensure the backup server is listening on the configured port.

### High retransmission rate after upgrade

This is normal during the first few minutes as the sequence tracking initializes. If it persists, check network quality via `GET /network-metrics`.
