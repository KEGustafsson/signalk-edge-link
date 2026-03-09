"use strict";

/**
 * Pipeline Factory - Creates appropriate pipeline based on protocol version
 *
 * @module lib/pipeline-factory
 */

const createPipelineV1 = require("./pipeline.ts");
const { createPipelineV2Client } = require("./pipeline-v2-client.ts");
const { createPipelineV2Server } = require("./pipeline-v2-server.ts");

/**
 * Create pipeline instance based on protocol version and mode
 *
 * @param {number} version - Protocol version (1, 2, or 3)
 * @param {string} mode - Operating mode ("client" or "server")
 * @param {Object} app - Signal K app instance (for logging)
 * @param {Object} state - Shared mutable state
 * @param {Object} metricsApi - Metrics API from lib/metrics.js
 * @returns {Object} Pipeline API with packCrypt/unpackDecrypt (v1) or sendDelta/receivePacket (v2)
 */
function createPipeline(version, mode, app, state, metricsApi) {
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

module.exports = { createPipeline };
