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

Stages in order, with the module that implements each. Settings are defined in [configuration-reference.md](configuration-reference.md).

1. Intake: subscribe to the paths in `subscription.json` ([`subscription-manager.ts`](../src/domain/subscription-manager.ts)); sanitize, strip own data with `skipOwnData`, and suppress an identical delta repeated within a short window ([`process-delta.ts`](../src/app/connection/process-delta.ts)).
2. Batching: flush every `deltaTimer` in packets sized from a rolling per-delta estimate to target the UDP payload limit (an oversized packet is logged and still sent) ([`delta-batcher.ts`](../src/domain/delta-batcher.ts)).
3. Shaping and encoding: `pathFilter`, `pathPrecision`, `pathThrottle`, `useValueDedup`, path dictionary, JSON, MessagePack or compact tuples, Brotli, AES-256-GCM ([`delta-sender.ts`](../src/transport/pipeline/reliable-client/delta-sender.ts), [`src/codec/`](../src/codec/)).
4. Framing and reliability: v3 header with sequence and CRC16 ([`packet-codec.ts`](../src/codec/packet-codec.ts)); a copy is held until ACKed ([`retransmit-queue.ts`](../src/transport/reliability/retransmit-queue.ts)).
5. Send: UDP to `udpAddress:udpPort`, or to the active link when bonding is enabled ([`udp-socket-manager.ts`](../src/transport/udp-socket-manager.ts), [`bonding.ts`](../src/transport/bonding.ts)).

A v1 client skips `useValueDedup`, compact tuples, the v3 header and the retransmit queue, and sends the encrypted payload as the whole datagram ([`v1.ts`](../src/transport/pipeline/v1.ts)).

## Server inbound (v3)

Entry point: [`receive.ts`](../src/transport/pipeline/reliable-server/receive.ts).

1. Bonding probes: an `HBPROBE` is rate limited per source IP and HMAC-verified before it is echoed; it never reaches the header parser.
2. Parse header: check magic `SK`, version and CRC16; verify the HMAC tag on control packets and, with `authenticatedHeaders`, on DATA/METADATA.
3. Rate limit DATA and METADATA: 200 packets/s per session when the sender has a session, otherwise 200 packets/s per source IP ([`sessions.ts`](../src/transport/pipeline/reliable-server/sessions.ts)).
4. Decrypt and decompress DATA: an AES-GCM tag failure rejects the packet; Brotli output is capped at 10 MB ([`data-handler.ts`](../src/transport/pipeline/reliable-server/data-handler.ts)).
5. Session: created by an authenticated HELLO or by a DATA packet that decrypted; at most 5 per IP and 100 per server connection.
6. Sequence: replay window, gap detection, NAK for missing sequences, cumulative ACK every `ackInterval`.
7. Decode, sanitize and dispatch: MessagePack or JSON, path dictionary, value-dedup expansion, `$source` resolution, then `app.handleMessage` into the local Signal K tree.
