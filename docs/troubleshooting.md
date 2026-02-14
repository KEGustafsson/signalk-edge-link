# Signal K Edge Link v2.0 - Troubleshooting Guide

## Quick Diagnostic Checklist

Before diving into specific issues, check these common items:

1. **Both sides running same version?** Client and server must both be on v2.0
2. **Encryption keys match?** Must be identical 32-character strings
3. **UDP port open?** Firewall must allow UDP traffic on configured port
4. **Plugin enabled?** Check Admin UI > Plugin Config
5. **Node.js >= 14.0.0?** Run `node --version` to verify

## Installation Issues

### Plugin Not Loading

**Symptoms:** Plugin doesn't appear in Admin UI or fails to start.

**Solutions:**
1. Verify `npm install` completed without errors:
   ```bash
   cd ~/.signalk/node_modules/signalk-edge-link
   npm install
   ```
2. Build the web UI:
   ```bash
   npm run build
   ```
3. Check Signal K server logs for error messages
4. Verify the plugin directory path is correct: `~/.signalk/node_modules/signalk-edge-link`
5. Check Node.js version: `node --version` (requires >= 14.0.0)

### Web UI Not Accessible

**Symptoms:** Dashboard page shows blank or 404.

**Solutions:**
1. Run `npm run build` to generate UI files
2. Verify `public/` directory exists with built JavaScript files
3. Clear browser cache and hard-refresh (Ctrl+Shift+R)
4. Check Signal K server logs for webpack build errors

### Build Failures

**Symptoms:** `npm run build` fails with errors.

**Solutions:**
1. Delete `node_modules/` and reinstall:
   ```bash
   rm -rf node_modules
   npm install
   npm run build
   ```
2. Check for Node.js version compatibility
3. Ensure `webpack` and `webpack-cli` are installed (listed in devDependencies)

## Connection Issues

### No Data Transmission

**Client-side checklist:**
1. Confirm encryption keys match on both ends
2. Verify UDP port and destination address are correct
3. Check firewall allows outbound UDP traffic on the configured port
4. Confirm subscription paths are valid Signal K paths
5. Check delta timer is running: `GET /plugins/signalk-edge-link/metrics`
6. Verify `readyToSend` is `true` in metrics response
7. Check that data paths exist in Signal K (the plugin only sends data for subscribed paths that have values)

**Server-side checklist:**
1. Verify UDP port is not blocked by inbound firewall rules
2. Confirm encryption key matches the client exactly
3. Check Signal K logs for decryption errors
4. Verify the server is listening: check `deltasReceived` counter in metrics

### Connection Drops

**Symptoms:** Data flows briefly then stops.

**Possible causes:**
- NAT timeout on cellular/satellite connections. Solution: Reduce heartbeat interval to 30 seconds or less
- DNS resolution failure for dynamic IP addresses. Solution: Use static IP or DynDNS
- Firewall rate limiting UDP packets. Solution: Check firewall logs
- Network interface going down (especially cellular). Solution: Enable connection bonding

### High Latency

**Symptoms:** Data arrives with significant delay.

**Solutions:**
1. Check `GET /plugins/signalk-edge-link/network-metrics` for RTT values
2. Enable congestion control to automatically adapt:
   ```json
   { "congestionControl": { "enabled": true, "targetRTT": 200 } }
   ```
3. Reduce Brotli compression quality (trades bandwidth for CPU):
   - Edit `lib/constants.js`: change `BROTLI_QUALITY_HIGH` from 10 to 4-6
4. Increase delta timer for better batching efficiency
5. Filter unnecessary NMEA sentences to reduce data volume

## Error Messages

### Encryption Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Unsupported state or unable to authenticate data` | Mismatched encryption keys | Verify identical 32-char keys on both ends |
| `Secret key must be exactly 32 characters` | Invalid key length | Use exactly 32 characters |
| `Key lacks sufficient diversity` | Key too simple (< 8 unique chars) | Use a randomly generated key |

Generate a secure key:
```bash
openssl rand -base64 32 | cut -c1-32
```

### Protocol Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Invalid magic bytes` | v1 client sending to v2-expecting server | Upgrade both sides to same version |
| `CRC mismatch` | Header corruption in transit | Packet discarded, retransmitted automatically |
| `Unsupported protocol version` | Version mismatch | Ensure same plugin version on both ends |
| `Invalid packet size` | Corrupted or truncated packet | Check network for MTU issues |

### Network Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `UDP send error: ECONNREFUSED` | Server not listening or port wrong | Verify server is running, check port |
| `UDP send error: ENETUNREACH` | No route to host | Check network connectivity |
| `UDP send error: EMSGSIZE` | Packet too large | Should not happen with smart batching; report bug |

## Performance Issues

### Poor Compression Ratio

**Symptoms:** Compression ratio below 80%.

**Solutions:**
1. Increase delta timer to 1000 ms or higher for better batching
2. Enable path dictionary (`usePathDictionary: true`) for 10-20% savings
3. Enable MessagePack (`useMsgpack: true`) for 15-25% savings
4. Filter unnecessary NMEA sentences (GSV, GSA, VTG)
5. Review subscriptions to include only needed paths

### High CPU Usage

**Symptoms:** Signal K server CPU usage increases significantly.

**Solutions:**
1. Brotli compression at quality 10 is CPU-intensive. For constrained devices, reduce quality in `lib/constants.js`
2. Increase delta timer to reduce compression frequency
3. Reduce the number of subscribed paths
4. Check benchmark results: compression dominates CPU cost at ~0.9 ms/operation

### High Memory Usage

**Symptoms:** Memory usage grows over time.

**Solutions:**
1. All buffers are bounded by design. If you see unbounded growth, report a bug
2. Check retransmit queue depth: `GET /plugins/signalk-edge-link/metrics` → `networkQuality.queueDepth`
3. Normal bounded sizes:
   - Retransmit queue: max 5,000 packets
   - Monitoring heatmap: max 60 buckets
   - Path latency: max 200 paths × 50 samples
   - Retransmission history: max 120 entries
   - Bandwidth history: max 60 entries

### UDP Fragmentation

**Symptoms:** Intermittent packet loss, especially on paths with small MTU.

**Solutions:**
1. Smart batching should prevent this automatically (targets 85% of 1400 bytes)
2. Check `oversizedPackets` counter in metrics (should be 0)
3. If using a VPN or tunnel, the effective MTU may be lower. Adjust `MAX_SAFE_UDP_PAYLOAD` in `lib/constants.js`

## Congestion Control Issues

### Timer Not Adjusting

**Symptoms:** Delta timer stays constant despite changing network conditions.

**Checks:**
1. Verify `congestionControl.enabled` is `true`
2. Check `GET /congestion` — verify `manualMode` is `false`
3. The controller only adjusts every 5 seconds
4. RTT and loss must be beyond thresholds to trigger changes:
   - Increase requires: loss < 1% AND RTT < target
   - Decrease requires: loss > 5% OR RTT > 1.5× target

### Timer Oscillating

**Symptoms:** Delta timer changes frequently between high and low values.

**Solutions:**
1. Increase target RTT to be above your normal network RTT
2. The max adjustment per step is 20%, preventing large swings
3. EMA smoothing (alpha=0.2) dampens short-term spikes
4. If network conditions are genuinely fluctuating, consider manual mode

## Bonding Issues

### Failover Not Triggering

**Symptoms:** Primary link is degraded but no failover occurs.

**Checks:**
1. Verify `bonding.enabled` is `true`
2. Check `GET /bonding` for per-link health status
3. Ensure backup link address and port are correct
4. Verify backup server is listening and reachable
5. Check that backup link status is not `"down"` (failover won't trigger if backup is also down)
6. Review failover thresholds — primary RTT/loss must exceed configured values

### Frequent Failover/Failback (Flapping)

**Symptoms:** Link switches back and forth rapidly.

**Solutions:**
1. Increase `failbackDelay` (default 30,000 ms). Try 60,000 ms or higher
2. The hysteresis mechanism requires primary to be significantly better before failback:
   - RTT must be < threshold × 0.8
   - Loss must be < threshold × 0.5
3. If both links have similar quality, consider increasing the difference in thresholds

### Bonding Link Shows "down"

**Symptoms:** Link status shows `"down"` even though the network is working.

**Checks:**
1. Heartbeat probes may be blocked by firewall. Ensure UDP traffic is allowed bidirectionally
2. The server must echo heartbeat probes back to the client
3. Link is marked DOWN after no heartbeat response for 5,000 ms (configurable via `heartbeatTimeout`)
4. Check socket errors in Signal K debug logs

## Monitoring Issues

### No Prometheus Metrics

**Symptoms:** `GET /prometheus` returns empty or error.

**Solutions:**
1. Verify the plugin is running and has received/sent data
2. Check that the endpoint URL is correct: `/plugins/signalk-edge-link/prometheus`
3. Prometheus scrape configuration needs the full path including `/plugins/signalk-edge-link/`

### Alerts Not Firing

**Symptoms:** Metrics exceed thresholds but no Signal K notifications appear.

**Checks:**
1. Verify thresholds: `GET /monitoring/alerts`
2. Alert cooldown is 60 seconds — duplicate alerts within this window are suppressed
3. Signal K notification handling must be configured to display plugin notifications
4. Check debug logs for `[Alert] Failed to emit notification` messages

### Packet Capture Not Working

**Symptoms:** `GET /capture/export` returns empty or error.

**Solutions:**
1. Start capture first: `POST /capture/start`
2. Wait for packets to be captured
3. Check `GET /capture` for capture statistics
4. Maximum buffer is 1,000 packets — oldest packets are evicted when full

## Debug Logging

Enable debug logging in Signal K plugin settings to see detailed operational information:

- Connection status and ping results
- Configuration file changes (hot-reload events)
- Delta transmission statistics per batch
- Compression ratios and packet sizes
- Congestion control adjustments
- Bonding health checks and failover decisions
- Error messages with full context

### Useful Debug Commands

```bash
# Check current metrics
curl http://localhost:3000/plugins/signalk-edge-link/metrics | jq .

# Check network quality
curl http://localhost:3000/plugins/signalk-edge-link/network-metrics | jq .

# Check congestion control state
curl http://localhost:3000/plugins/signalk-edge-link/congestion | jq .

# Check bonding state
curl http://localhost:3000/plugins/signalk-edge-link/bonding | jq .

# Check alerts
curl http://localhost:3000/plugins/signalk-edge-link/monitoring/alerts | jq .

# Check Prometheus metrics
curl http://localhost:3000/plugins/signalk-edge-link/prometheus

# Export packet capture
curl -o capture.pcap http://localhost:3000/plugins/signalk-edge-link/capture/export
```

## Getting Help

If you've exhausted this guide:

1. Check existing issues: https://github.com/KEGustafsson/signalk-edge-link/issues
2. Enable debug logging and collect the relevant log output
3. Include your configuration (redact the encryption key)
4. Include the output of `GET /metrics` and `GET /network-metrics`
5. Open a new issue with the above information
