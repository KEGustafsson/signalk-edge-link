"use strict";

/**
 * Plugin schema definition (L4 application layer).
 *
 * Single source of truth for the plugin-level JSON schema. The per-connection
 * item schema is authored in src/shared/connection-schema.ts and consumed here
 * and by the webapp RJSF form without duplication.
 *
 * @module app/config/schema
 */

import { buildConnectionItemSchema } from "../../shared/connection-schema";

export function buildPluginSchema(): object {
  const connectionItemSchema = buildConnectionItemSchema();
  return {
    type: "object",
    title: "SignalK Edge Link",
    description:
      "Configure encrypted UDP data transmission between SignalK units. Add one connection per server listener or client sender.",
    properties: {
      schemaVersion: {
        type: "number",
        title: "Schema Version",
        description: "Internal schema version for forward-compatibility migrations. Do not edit.",
        default: 1,
        readOnly: true
      },
      managementApiToken: {
        type: "string",
        title: "Management API Token",
        description:
          "Shared secret to protect management API endpoints. Strongly recommended for production. Can also be set via SIGNALK_EDGE_LINK_MANAGEMENT_TOKEN environment variable."
      },
      requireManagementApiToken: {
        type: "boolean",
        title: "Require Management API Token",
        description:
          "If true, all management API requests are rejected when no managementApiToken is configured. Enables a fail-closed security posture. Default: false (open access when no token is set).",
        default: false
      },
      connections: {
        type: "array",
        title: "Connections",
        description:
          "Add one item per server or client connection. Multiple servers (on different ports) and multiple clients can run simultaneously.",
        minItems: 1,
        items: connectionItemSchema,
        default: [
          {
            name: "default",
            serverType: "client",
            udpPort: 4446,
            protocolVersion: 1
          }
        ]
      }
    },
    required: ["connections"]
  };
}
