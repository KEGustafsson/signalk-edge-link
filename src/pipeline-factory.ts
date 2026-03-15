"use strict";

/**
 * Pipeline Factory - Creates appropriate pipeline based on protocol version
 *
 * @module lib/pipeline-factory
 */

import createPipelineV1 = require("./pipeline");
import { createPipelineV2Client } from "./pipeline-v2-client";
import { createPipelineV2Server } from "./pipeline-v2-server";
import type {
  SignalKApp,
  MetricsApi,
  InstanceState,
  ClientPipelineApi,
  ServerPipelineApi
} from "./types";

/**
 * Create pipeline instance based on protocol version and mode
 *
 * @param version - Protocol version (1, 2, or 3)
 * @param mode - Operating mode ("client" or "server")
 * @param app - Signal K app instance (for logging)
 * @param state - Shared mutable state
 * @param metricsApi - Metrics API from lib/metrics.js
 * @returns Pipeline API with packCrypt/unpackDecrypt (v1) or sendDelta/receivePacket (v2)
 */
export function createPipeline(
  version: number,
  mode: string,
  app: SignalKApp,
  state: InstanceState,
  metricsApi: MetricsApi
):
  | ClientPipelineApi
  | ServerPipelineApi
  | {
      packCrypt(delta: unknown, secretKey: string, address: string, port: number): Promise<void>;
      unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
    } {
  if (version === 2 || version === 3) {
    if (mode === "client") {
      return createPipelineV2Client(app, state, metricsApi);
    }
    if (mode === "server") {
      return createPipelineV2Server(app, state, metricsApi);
    }
    throw new Error(`Invalid pipeline mode: "${mode}" (expected "client" or "server")`);
  }

  if (version === 1) {
    return createPipelineV1(app, state, metricsApi);
  }

  throw new Error(`Unsupported pipeline version: ${version} (supported versions: 1, 2, 3)`);
}
