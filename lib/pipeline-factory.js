"use strict";

/**
 * Pipeline Factory - Creates appropriate pipeline based on protocol version
 *
 * @module lib/pipeline-factory
 */

const createPipelineV1 = require("./pipeline");
const { createPipelineV2Client } = require("./pipeline-v2-client");
const { createPipelineV2Server } = require("./pipeline-v2-server");

/**
 * Create pipeline instance based on protocol version and mode
 *
 * @param {number} version - Protocol version (1 or 2)
 * @param {string} mode - Operating mode ("client" or "server")
 * @param {Object} app - Signal K app instance (for logging)
 * @param {Object} state - Shared mutable state
 * @param {Object} metricsApi - Metrics API from lib/metrics.js
 * @returns {Object} Pipeline API with packCrypt/unpackDecrypt (v1) or sendDelta/receivePacket (v2)
 */
function createPipeline(version, mode, app, state, metricsApi) {
  if (version === 2) {
    if (mode === "client") {
      return createPipelineV2Client(app, state, metricsApi);
    }
    return createPipelineV2Server(app, state, metricsApi);
  }

  // Default to v1
  return createPipelineV1(app, state, metricsApi);
}

module.exports = { createPipeline };
