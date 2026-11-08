# Signal K Edge Link — Architecture Overview

Source modules and the client and server data flow. Installation and configuration are in [GUIDE.md](GUIDE.md); topologies (point to point, hub, bonding, relay chain, fleet sharing) are in the project [README](../README.md#topologies); wire format is in [protocol-v3-spec.md](protocol-v3-spec.md).

One Signal K server runs any number of connections. Each connection is either a **client** (subscribes to local data and sends it) or a **server** (receives and writes it into the local Signal K tree), with its own key, port and protocol mode (Basic v1 or Advanced v3, see [protocol-v3.md](protocol-v3.md)). A relay is one Signal K server with a server connection and a client connection; each hop is an independent link.

## Source layers

| Layer       | Path                           | Responsibility                                                                                    |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------- |
| Foundation  | `src/foundation/`              | Types, constants, logger, config file I/O and debounced reload                                    |
| Codec       | `src/codec/`                   | Crypto, packet codec, compression, path dictionary, value dedup, metadata and source envelopes    |
| Transport   | `src/transport/`               | UDP socket, v1/v3 pipelines, reliability, congestion control, bonding, fleet sharing              |
| Domain      | `src/domain/`                  | Subscription, delta batching, keepalive, metadata streaming, source registry, metrics, monitoring |
| Application | `src/app/`                     | Connection lifecycle, connection manager, config validation, migration and file watchers          |
| Interface   | `src/routes.ts`, `src/routes/` | REST API, management auth, rate limiting                                                          |
| Web UI      | `src/webapp/`                  | React configuration panel and dashboard                                                           |
| CLI         | `src/bin/edge-link-cli.ts`     | Management CLI                                                                                    |

## Key modules

| Module                                                             | Role                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                     | Plugin entry point and plugin schema                                                            |
| `src/app/connection-manager.ts`                                    | Instance registry, validation, port-collision checks, server-then-client startup, status        |
| `src/app/connection.ts`, `src/app/connection/`                     | One connection: context wiring, client/server start, delta intake, socket recovery              |
| `src/app/lifecycle.ts`                                             | Connection state machine                                                                        |
| `src/app/config/watcher.ts`                                        | Watchers for `delta_timer.json`, `subscription.json`, `sentence_filter.json`                    |
| `src/connection-config.ts`, `src/shared/connection-schema.ts`      | Connection validation and normalization; schema shared with the web UI                          |
| `src/transport/pipeline/factory.ts`                                | Selects the v1 or v3 pipeline                                                                   |
| `src/transport/pipeline/v1.ts`                                     | Basic (v1) client and server pipeline                                                           |
| `src/transport/pipeline/reliable-client.ts` and `reliable-client/` | v3 client: DATA send, ACK/NAK handling, HELLO, metadata, fleet receive                          |
| `src/transport/pipeline/reliable-server.ts` and `reliable-server/` | v3 server: sessions, DATA receive, ACK/NAK send, fleet send                                     |
| `src/transport/reliability/`                                       | `sequence.ts` (gap detection), `retransmit-queue.ts`, `replay-window.ts`, `connection-epoch.ts` |
| `src/transport/congestion.ts`                                      | AIMD send-rate control                                                                          |
| `src/transport/bonding.ts`, `bonding-health.ts`                    | Dual-link failover and link health                                                              |
| `src/transport/udp-socket-manager.ts`                              | UDP socket create, bind, send, close                                                            |
| `src/codec/packet-codec.ts`, `src/codec/packet/`                   | v3 header build and parse, packet type constants                                                |
| `src/codec/crypto.ts`                                              | AES-256-GCM, key normalization and checks, HMAC                                                 |
| `src/domain/subscription-manager.ts`                               | Signal K subscription and resubscribe                                                           |
| `src/domain/delta-batcher.ts`                                      | Outbound flush timer and batching                                                               |
| `src/domain/metrics/`                                              | Metrics registry and Prometheus output                                                          |
| `src/domain/monitoring/`                                           | Packet loss, path latency, retransmission tracking, alerts, packet capture                      |

## Client outbound (v3)

| Step | Stage              | Detail                                                                                    |
| ---- | ------------------ | ----------------------------------------------------------------------------------------- |
| 1    | Subscribe          | Paths from `subscription.json`                                                            |
| 2    | Sanitize, strip    | Drop invalid values; with `skipOwnData`, drop `networking.edgeLink.*` paths except RTT    |
| 3    | Duplicate suppress | Drop an identical delta repeated within 1500 ms                                           |
| 4    | Buffer             | Flush every `deltaTimer` (default 1000 ms); smart batching keeps packets under the MTU    |
| 5    | Filter and shape   | `pathFilter`, `pathPrecision`, `pathThrottle`, then `useValueDedup`                       |
| 6    | Path dictionary    | With `usePathDictionary`, replace known paths with numeric IDs                            |
| 7    | Serialize          | JSON, MessagePack (`useMsgpack`), or compact tuples (`useCompactDeltas` with MessagePack) |
| 8    | Compress           | Brotli, quality `brotliQuality` (default 6)                                               |
| 9    | Encrypt            | AES-256-GCM: `[12B IV][ciphertext][16B tag]`                                              |
| 10   | Packet header      | 15-byte v3 header with sequence and CRC16                                                 |
| 11   | Retransmit queue   | Copy kept until ACKed (default 5000 packets, 3 retransmits)                               |
| 12   | UDP send           | To `udpAddress:udpPort`                                                                   |

A v1 client skips `useValueDedup`, compact tuples and steps 10–11, and sends the encrypted payload as the whole datagram.

## Server inbound (v3)

| Step | Stage            | Detail                                                                                                                         |
| ---- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Rate limit       | At most 200 packets/s per source IP before authentication and per session                                                      |
| 2    | Parse header     | Check magic `SK`, version and CRC16; verify the HMAC tag on control packets and, with `authenticatedHeaders`, on DATA/METADATA |
| 3    | Decrypt          | AES-GCM tag failure rejects the packet                                                                                         |
| 4    | Decompress       | Brotli, output capped at 10 MB                                                                                                 |
| 5    | Session          | Created only after decryption; at most 5 per IP and 100 per server connection                                                  |
| 6    | Sequence         | Replay window, gap detection, NAK for missing sequences, cumulative ACK every `ackInterval` (default 100 ms)                   |
| 7    | Decode           | MessagePack or JSON, compact tuples, path dictionary, value-dedup expansion                                                    |
| 8    | Sanitize, source | Drop invalid values; resolve `$source` per delta                                                                               |
| 9    | Dispatch         | `app.handleMessage` into the local Signal K tree                                                                               |
