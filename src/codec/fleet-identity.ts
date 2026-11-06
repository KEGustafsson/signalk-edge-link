"use strict";

/**
 * Signal K Edge Link — encrypted fleet identity carried in HELLO.
 *
 * HELLO is HMAC-authenticated but not encrypted, so the client's own vessel
 * context (which usually contains its MMSI) is AES-256-GCM encrypted with the
 * link key before it goes into the HELLO `fleet` field. See
 * docs/protocol-v3-spec.md §15.2.
 *
 * @module codec/fleet-identity
 */

import * as crypto from "node:crypto";
import { encryptBinary, decryptBinary } from "./crypto";
import {
  FLEET_IDENTITY_MAX_LENGTH,
  FLEET_MIN_MAX_BYTES_PER_SEC,
  FLEET_MAX_MAX_BYTES_PER_SEC,
  FLEET_PATH_FILTER_MAX_PATTERNS,
  FLEET_PATH_PATTERN_MAX_LENGTH
} from "../foundation/constants";
import type { PathFilterConfig } from "../foundation/types";

/** Version of the decrypted `fleet` object this code understands. */
export const FLEET_IDENTITY_VERSION = 1;

const MAX_CONTEXT_LENGTH = 256;
/** AES-256-GCM adds a 12-byte IV and a 16-byte tag (codec/crypto). */
const ENCRYPTION_OVERHEAD = 28;

export interface FleetIdentity {
  /** The client's own context, e.g. `vessels.urn:mrn:imo:mmsi:230123456`. */
  self: string;
  /** 16 hex characters, new per HELLO; echoed by HELLO_ACK. */
  nonce: string;
  /** Paths the client wants to receive. */
  pathFilter?: PathFilterConfig;
  /** Byte-rate ceiling the client requests (bytes per second). */
  maxBytesPerSec?: number;
}

/** A fresh 64-bit nonce as 16 lowercase hex characters. */
export function newFleetNonce(): string {
  return crypto.randomBytes(8).toString("hex");
}

function sanitizePatterns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out = value
    .filter((p): p is string => typeof p === "string" && p.length > 0)
    .map((p) => p.slice(0, FLEET_PATH_PATTERN_MAX_LENGTH))
    .slice(0, FLEET_PATH_FILTER_MAX_PATTERNS);
  return out;
}

function sanitizePathFilter(value: unknown): PathFilterConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const allow = sanitizePatterns(record.allow);
  const deny = sanitizePatterns(record.deny);
  if (!allow?.length && !deny?.length) {
    return undefined;
  }
  return { allow: allow ?? [], deny: deny ?? [] };
}

/** Validate a decrypted identity object; returns null when it is unusable. */
export function parseFleetIdentityObject(value: unknown): FleetIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.v !== FLEET_IDENTITY_VERSION) {
    return null;
  }
  const self = record.self;
  if (
    typeof self !== "string" ||
    !self.startsWith("vessels.") ||
    self.length > MAX_CONTEXT_LENGTH ||
    self === "vessels.self"
  ) {
    return null;
  }
  const nonce = record.nonce;
  if (typeof nonce !== "string" || !/^[0-9a-f]{16}$/.test(nonce)) {
    return null;
  }
  const identity: FleetIdentity = { self, nonce };
  const pathFilter = sanitizePathFilter(record.pathFilter);
  if (pathFilter) {
    identity.pathFilter = pathFilter;
  }
  const rate = record.maxBytesPerSec;
  if (typeof rate === "number" && Number.isFinite(rate)) {
    // A requested ceiling below the minimum is raised to the minimum, never
    // dropped: dropping it would let the server send at its full rate.
    identity.maxBytesPerSec = Math.max(FLEET_MIN_MAX_BYTES_PER_SEC, Math.floor(rate));
  }
  return identity;
}

/**
 * True when an identity carrying `pathFilter` fits the HELLO `fleet` field for
 * any valid vessel context and rate. Config validation uses it so a filter it
 * accepts is never refused by encodeFleetIdentity at runtime.
 */
export function fleetPathFilterFits(pathFilter: PathFilterConfig): boolean {
  const worstCase = JSON.stringify({
    v: FLEET_IDENTITY_VERSION,
    self: "v".repeat(MAX_CONTEXT_LENGTH),
    nonce: "0".repeat(16),
    // Both keys, as either form may be sent; this only adds bytes.
    pathFilter: { allow: pathFilter.allow ?? [], deny: pathFilter.deny ?? [] },
    maxBytesPerSec: FLEET_MAX_MAX_BYTES_PER_SEC
  });
  const encrypted = Buffer.byteLength(worstCase) + ENCRYPTION_OVERHEAD;
  return Math.ceil(encrypted / 3) * 4 <= FLEET_IDENTITY_MAX_LENGTH;
}

/** Encrypt an identity for the HELLO `fleet` field (base64). */
export function encodeFleetIdentity(
  identity: FleetIdentity,
  secretKey: string,
  options: { stretchAsciiKey?: boolean } = {}
): string {
  const body: Record<string, unknown> = {
    v: FLEET_IDENTITY_VERSION,
    self: identity.self,
    nonce: identity.nonce
  };
  if (identity.pathFilter) {
    body.pathFilter = identity.pathFilter;
  }
  if (identity.maxBytesPerSec) {
    body.maxBytesPerSec = identity.maxBytesPerSec;
  }
  const encoded = encryptBinary(Buffer.from(JSON.stringify(body)), secretKey, options).toString(
    "base64"
  );
  if (encoded.length > FLEET_IDENTITY_MAX_LENGTH) {
    throw new Error(
      `fleet identity is ${encoded.length} bytes encoded (limit ${FLEET_IDENTITY_MAX_LENGTH}); shorten fleetSharing.pathFilter`
    );
  }
  return encoded;
}

/**
 * Decrypt and validate a HELLO `fleet` field. Returns null for anything that
 * is missing, oversized, fails authentication, or has an unknown version — the
 * HELLO is then treated as a non-fleet HELLO.
 */
export function decodeFleetIdentity(
  field: unknown,
  secretKey: string,
  options: { stretchAsciiKey?: boolean } = {}
): FleetIdentity | null {
  if (typeof field !== "string" || field.length === 0 || field.length > FLEET_IDENTITY_MAX_LENGTH) {
    return null;
  }
  try {
    const plaintext = decryptBinary(Buffer.from(field, "base64"), secretKey, options);
    return parseFleetIdentityObject(JSON.parse(plaintext.toString("utf8")));
  } catch {
    return null;
  }
}
