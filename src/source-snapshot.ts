"use strict";

import type { SignalKApp } from "./types";

export type SourceTree = Record<string, unknown>;

const BLOCKED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clonePlain(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => clonePlain(entry));
  }
  if (!isRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!BLOCKED_KEYS.has(key)) {
      out[key] = clonePlain(entry);
    }
  }
  return out;
}

function mergePlain(target: Record<string, unknown>, incoming: Record<string, unknown>): void {
  for (const [key, incomingValue] of Object.entries(incoming)) {
    if (BLOCKED_KEYS.has(key)) {
      continue;
    }
    const currentValue = target[key];
    if (isRecord(currentValue) && isRecord(incomingValue)) {
      mergePlain(currentValue, incomingValue);
    } else {
      target[key] = clonePlain(incomingValue);
    }
  }
}

function getSignalKRoot(app: Pick<SignalKApp, "debug">): Record<string, unknown> | null {
  const signalk = (app as unknown as { signalk?: { retrieve?: () => unknown } }).signalk;
  if (!signalk || typeof signalk.retrieve !== "function") {
    return null;
  }
  const root = signalk.retrieve();
  return isRecord(root) ? root : null;
}

export function collectSourceSnapshot(app: Pick<SignalKApp, "debug">): SourceTree | null {
  const root = getSignalKRoot(app);
  if (!root || !isRecord(root.sources)) {
    return null;
  }
  return clonePlain(root.sources) as SourceTree;
}

export function mergeSourceSnapshot(app: Pick<SignalKApp, "debug">, sources: unknown): number {
  if (!isRecord(sources)) {
    return 0;
  }

  const root = getSignalKRoot(app);
  if (!root) {
    return 0;
  }
  if (!isRecord(root.sources)) {
    root.sources = {};
  }

  const target = root.sources as Record<string, unknown>;
  const before = Object.keys(target).length;
  mergePlain(target, sources);
  return Object.keys(target).length - before;
}
