"use strict";

/**
 * Signal K Path Dictionary for bandwidth optimization
 * Maps common SignalK paths to short numeric IDs for transmission
 * Based on official Signal K specification: https://github.com/SignalK/specification
 */

import type { Delta, DeltaValue } from "../foundation/types";

import { PATH_TO_ID } from "./path-dictionary-data";

// Re-export the encode table so existing consumers keep importing it here.
export { PATH_TO_ID } from "./path-dictionary-data";

// ID to Path mapping (decode) - generated from PATH_TO_ID.
// Both maps are frozen so that no caller can accidentally mutate the shared
// encoding/decoding tables, which would silently corrupt all path lookups.
export const ID_TO_PATH: Record<number, string> = Object.freeze(
  Object.fromEntries(Object.entries(PATH_TO_ID).map(([k, v]) => [v, k]))
) as Record<number, string>;

const ALL_PATHS = Object.keys(PATH_TO_ID);
const DICTIONARY_SIZE = ALL_PATHS.length;

interface PathCategory {
  name: string;
  description: string;
  icon: string;
  prefix: string;
}

// Path categories for UI grouping
export const PATH_CATEGORIES: Record<string, PathCategory> = {
  navigation: {
    name: "Navigation",
    description: "Position, speed, heading, and course data",
    icon: "🧭",
    prefix: "navigation."
  },
  environment: {
    name: "Environment",
    description: "Weather, water, wind, and depth data",
    icon: "🌊",
    prefix: "environment."
  },
  electrical: {
    name: "Electrical",
    description: "Batteries, chargers, solar, and power data",
    icon: "⚡",
    prefix: "electrical."
  },
  propulsion: {
    name: "Propulsion",
    description: "Engine, transmission, and fuel data",
    icon: "🔧",
    prefix: "propulsion."
  },
  steering: {
    name: "Steering",
    description: "Rudder and autopilot data",
    icon: "🎯",
    prefix: "steering."
  },
  tanks: {
    name: "Tanks",
    description: "Fuel, water, and fluid levels",
    icon: "🛢️",
    prefix: "tanks."
  },
  communication: {
    name: "Communication",
    description: "Vessel contact information",
    icon: "📡",
    prefix: "communication."
  },
  notifications: {
    name: "Notifications",
    description: "Alerts and emergency signals",
    icon: "🚨",
    prefix: "notifications."
  },
  design: {
    name: "Design",
    description: "Vessel dimensions and specifications",
    icon: "📐",
    prefix: "design."
  },
  performance: {
    name: "Performance",
    description: "Sailing performance metrics",
    icon: "📈",
    prefix: "performance."
  },
  sails: {
    name: "Sails",
    description: "Sail inventory and area",
    icon: "⛵",
    prefix: "sails."
  },
  networking: {
    name: "Networking",
    description: "Modem and connectivity data",
    icon: "📶",
    prefix: "networking."
  }
};

const PATHS_BY_CATEGORY: Record<string, string[]> = Object.fromEntries(
  Object.entries(PATH_CATEGORIES).map(([category, info]) => [
    category,
    ALL_PATHS.filter((path) => path.startsWith(info.prefix))
  ])
);

/**
 * Encodes a path string to its numeric ID
 * @param path - The SignalK path
 * @returns The numeric ID if found, otherwise the original path
 */
export function encodePath(path: string): number | string {
  if (PATH_TO_ID[path] !== undefined) {
    return PATH_TO_ID[path];
  }
  // No exact match -- return original path string to preserve instance IDs
  return path;
}

/**
 * Decodes a numeric ID to its path string
 * @param id - The numeric ID or original path
 * @returns The SignalK path
 */
export function decodePath(id: number | string): string {
  if (typeof id === "number" && ID_TO_PATH[id] !== undefined) {
    return ID_TO_PATH[id];
  }
  return id as string;
}

/**
 * Transforms paths in a delta object using the provided path transform function
 */
function transformDelta(
  delta: Delta,
  pathTransform: (path: string) => number | string,
  shouldTransform: (value: DeltaValue) => boolean
): Delta {
  if (!delta || !delta.updates) {
    return delta;
  }

  const transformedUpdates = new Array(delta.updates.length);
  for (let i = 0; i < delta.updates.length; i++) {
    const update = delta.updates[i];
    const values = update.values;
    let transformedValues = values;

    if (values) {
      transformedValues = new Array(values.length);
      for (let j = 0; j < values.length; j++) {
        const value = values[j];

        if (!value || typeof value !== "object") {
          transformedValues[j] = value;
        } else if (shouldTransform(value)) {
          const transformedPath = pathTransform(value.path);
          transformedValues[j] = { ...value, path: transformedPath as string };
        } else {
          transformedValues[j] = { ...value };
        }
      }
    }

    transformedUpdates[i] = {
      // Ensure source is always an object (never null/undefined)
      source: update.source ?? {},
      timestamp: update.timestamp,
      $source: update.$source,
      values: transformedValues
    };
  }

  return {
    context: delta.context,
    updates: transformedUpdates
  };
}

/**
 * Encodes paths in a delta object (optimized - no JSON stringify/parse)
 * @param delta - SignalK delta object
 * @returns Delta with encoded paths
 */
export function encodeDelta(delta: Delta): Delta {
  return transformDelta(delta, encodePath, (value) => !!value.path);
}

/**
 * Decodes paths in a delta object (optimized - no JSON stringify/parse)
 * @param delta - SignalK delta object with encoded paths
 * @returns Delta with decoded paths
 */
export function decodeDelta(delta: Delta): Delta {
  return transformDelta(delta, decodePath, (value) => value.path !== undefined);
}

/**
 * Encode the `path` field of a metadata entry using the path dictionary.
 * The `meta` payload itself is intentionally not touched — dictionary
 * compression applies to the path strings only.
 */
export function encodeMetaEntry<T extends { path: string }>(entry: T): T {
  return { ...entry, path: encodePath(entry.path) as unknown as string };
}

/**
 * Decode the `path` field of a metadata entry. Inverse of encodeMetaEntry.
 */
export function decodeMetaEntry<T extends { path: string | number }>(entry: T): T {
  return { ...entry, path: decodePath(entry.path as number | string) };
}

/**
 * Get all known paths as an array
 * @returns Array of all known SignalK paths
 */
export function getAllPaths(): string[] {
  return ALL_PATHS;
}

/**
 * Get paths by category
 * @param category - Category name (e.g., 'navigation', 'environment')
 * @returns Array of paths in that category
 */
export function getPathsByCategory(category: string): string[] {
  return PATHS_BY_CATEGORY[category] ?? [];
}

/**
 * Get the dictionary size (number of known paths)
 * @returns Number of paths in dictionary
 */
export function getDictionarySize(): number {
  return DICTIONARY_SIZE;
}
