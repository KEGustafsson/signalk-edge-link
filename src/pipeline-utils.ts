"use strict";

/**
 * Shared pipeline utilities used by both v1 and v2 client pipelines.
 *
 * The Brotli/serialization helpers were re-homed to the L1 codec layer
 * (`codec/compression.ts`) during the rewrite, and `udpSendAsync` moved to the
 * L2 transport layer's `UdpSocketManager` (`transport/udp-socket-manager.ts`)
 * in Phase 2. Both are re-exported here so the existing `./pipeline-utils`
 * imports keep working.
 *
 * @module lib/pipeline-utils
 */

export {
  brotliCompressAsync,
  brotliDecompressAsync,
  deltaBuffer,
  compressPayload
} from "./codec/compression";

export { udpSendAsync } from "./transport/udp-socket-manager";
