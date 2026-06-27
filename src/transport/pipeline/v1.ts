"use strict";

import { createPathThrottleState } from "../../codec/delta-sanitizer";
import {
  packCrypt as packCryptOp,
  unpackDecrypt as unpackDecryptOp,
  type V1PipelineContext
} from "./v1-helpers";
import type { SignalKApp, MetricsApi, InstanceState, Delta } from "../../foundation/types";

/**
 * Creates the data processing pipeline (compress, encrypt, send / receive, decrypt, decompress).
 * @param app - SignalK app object (for logging)
 * @param state - Shared mutable state (options, socketUdp, batching vars, lastPacketTime)
 * @param metricsApi - Metrics API from lib/metrics.js
 * @returns Pipeline API: { packCrypt, unpackDecrypt }
 */
function createPipeline(
  app: SignalKApp,
  state: InstanceState,
  metricsApi: MetricsApi
): {
  packCrypt(
    delta: Delta | Delta[],
    secretKey: string,
    udpAddress: string,
    udpPort: number
  ): Promise<void>;
  unpackDecrypt(msg: Buffer, secretKey: string): Promise<void>;
} {
  const setStatus = app.setPluginStatus || app.setProviderStatus || (() => {});
  const ctx: V1PipelineContext = {
    app,
    state,
    metricsApi,
    throttleState: createPathThrottleState(),
    setStatus
  };

  return {
    packCrypt(delta, secretKey, udpAddress, udpPort) {
      return packCryptOp(ctx, delta, secretKey, udpAddress, udpPort);
    },
    unpackDecrypt(packet, secretKey) {
      return unpackDecryptOp(ctx, packet, secretKey);
    }
  };
}

export = createPipeline;
