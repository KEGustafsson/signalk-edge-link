"use strict";

/**
 * L1 codec — metadata public surface (rewrite plan doc 02/05). Barrels the
 * split cache (change detection) and collect (snapshot/config/envelope) halves.
 *
 * @module codec/metadata-codec
 */

export * from "./metadata/cache";
export * from "./metadata/collect";
