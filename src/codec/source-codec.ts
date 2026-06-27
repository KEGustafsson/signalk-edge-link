"use strict";

/**
 * L1 codec — source handling public surface.
 *
 * Barrels the two cohesive, deliberately-separate source concerns:
 *   - source-dispatch.ts — RECEIVER-SIDE delta source normalization.
 *   - source-snapshot.ts — WIRE TRANSPORT of the /sources tree (collect/merge).
 * (Their file headers document why they stay distinct.)
 *
 * @module codec/source-codec
 */

export * from "./source-dispatch";
export * from "./source-snapshot";
