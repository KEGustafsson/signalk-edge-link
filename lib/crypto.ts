"use strict";

import * as crypto from "crypto";

// Use AES-256-GCM for authenticated encryption (encryption + authentication in one)
const ALGORITHM = "aes-256-gcm";
export const IV_LENGTH = 12; // GCM standard IV length
export const AUTH_TAG_LENGTH = 16; // GCM authentication tag length
export const CONTROL_AUTH_TAG_LENGTH = 16; // Truncated HMAC-SHA256 tag for v3 control packets

/**
 * Normalize a secret key string into a 32-byte Buffer.
 *
 * Accepts three formats:
 * - 64-character hex string  → decoded to 32 bytes (full 256-bit entropy)
 * - 44-character base64 string → decoded to 32 bytes (full 256-bit entropy)
 * - 32-character ASCII string → used as-is (~208 bits effective entropy)
 *
 * @param secretKey - Secret key in any supported format
 * @returns 32-byte key buffer
 * @throws Error if key cannot be normalized to exactly 32 bytes
 */
export function normalizeKey(secretKey: string): Buffer {
  if (!secretKey || typeof secretKey !== "string") {
    throw new Error("Secret key must be a non-empty string");
  }

  // Try hex: 64 hex characters → 32 bytes
  if (/^[0-9a-fA-F]{64}$/.test(secretKey)) {
    return Buffer.from(secretKey, "hex");
  }

  // Try base64: 44 chars (with optional padding) → 32 bytes
  if (/^[A-Za-z0-9+/]{43}=?$/.test(secretKey)) {
    const buf = Buffer.from(secretKey, "base64");
    if (buf.length === 32) {
      return buf;
    }
  }

  // Fallback: raw ASCII — must be exactly 32 bytes
  // NOTE: ASCII keys provide ~6.5 bits/char ≈ 208 bits effective entropy.
  // Prefer hex or base64 keys for full 256-bit strength.
  if (Buffer.byteLength(secretKey) === 32) {
    return Buffer.from(secretKey);
  }

  throw new Error(
    "Secret key must be exactly 32 bytes: use a 32-character ASCII string, " +
    "64-character hex string, or 44-character base64 string"
  );
}

/**
 * Encrypts data using AES-256-GCM with binary output
 * Binary format: [IV (12 bytes)][Encrypted Data][Auth Tag (16 bytes)]
 * @param data - Data to encrypt
 * @param secretKey - Secret key (32-char ASCII, 64-char hex, or 44-char base64)
 * @returns Binary packet with IV, encrypted data, and auth tag
 * @throws Error if secretKey is invalid or data is empty
 */
export const encryptBinary = (data: Buffer | string, secretKey: string): Buffer => {
  const keyBuffer = normalizeKey(secretKey);

  if (!data || (Buffer.isBuffer(data) && data.length === 0)) {
    throw new Error("Data to encrypt cannot be empty");
  }

  // Ensure data is a Buffer
  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  // Generate random IV for each encryption (critical for GCM security)
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv) as crypto.CipherGCM;

  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Return single buffer: [IV][Encrypted][AuthTag]
  return Buffer.concat([iv, encrypted, authTag]);
};

/**
 * Decrypts data encrypted with AES-256-GCM
 * @param packet - Binary packet with IV, encrypted data, and auth tag
 * @param secretKey - Secret key (32-char ASCII, 64-char hex, or 44-char base64)
 * @returns Decrypted data as Buffer
 * @throws Error if secretKey or packet is invalid, or authentication fails
 */
export const decryptBinary = (packet: Buffer, secretKey: string): Buffer => {
  const keyBuffer = normalizeKey(secretKey);

  if (!Buffer.isBuffer(packet) || packet.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid packet size");
  }

  // Extract components from packet (subarray provides zero-copy views)
  const iv = packet.subarray(0, IV_LENGTH);
  const authTag = packet.subarray(packet.length - AUTH_TAG_LENGTH);
  const encrypted = packet.subarray(IV_LENGTH, packet.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(authTag);

  // This will throw if authentication fails (tampered data)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
};

/**
 * Validates secret key strength
 * @param key - Secret key to validate
 * @returns True if key is valid
 * @throws Error if key is weak or invalid
 */
export function validateSecretKey(key: string): boolean {
  // First verify the key can be normalized to 32 bytes
  normalizeKey(key);

  // For hex/base64 keys, entropy validation on the raw string is not meaningful;
  // entropy checks apply to the ASCII fallback path where the user typed the key.
  if (/^[0-9a-fA-F]{64}$/.test(key) || /^[A-Za-z0-9+/]{43}=?$/.test(key)) {
    return true;
  }

  // Check for common weak patterns: all same character
  if (/^(.)\1{31}$/.test(key)) {
    throw new Error("Secret key has insufficient entropy (all same character)");
  }

  // Check for short repeating patterns (e.g., "abab...", "abcabc...")
  for (let len = 1; len <= 4; len++) {
    const segment = key.slice(0, len);
    if (segment.repeat(Math.ceil(32 / len)).slice(0, 32) === key) {
      throw new Error("Secret key has insufficient entropy (repeating pattern)");
    }
  }

  // Check character diversity
  const uniqueChars = new Set(key.split("")).size;
  if (uniqueChars < 8) {
    throw new Error("Secret key has insufficient diversity (use at least 8 different characters)");
  }

  return true;
}

/**
 * Creates an authentication tag for a v3 control packet.
 * The tag covers the header bytes 0..12 and the unhashed control payload.
 *
 * @param headerData - Header bytes 0..12
 * @param payload - Control payload without trailing auth tag
 * @param secretKey - Secret key in any supported format
 * @returns Truncated HMAC tag
 */
export function createControlPacketAuthTag(
  headerData: Buffer,
  payload: Buffer | string | null,
  secretKey: string
): Buffer {
  if (!Buffer.isBuffer(headerData)) {
    throw new Error("Control packet header must be a Buffer");
  }

  const keyBuffer = normalizeKey(secretKey);
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || "");
  const hmac = crypto.createHmac("sha256", keyBuffer);
  hmac.update(headerData);
  if (payloadBuffer.length > 0) {
    hmac.update(payloadBuffer);
  }
  return hmac.digest().subarray(0, CONTROL_AUTH_TAG_LENGTH);
}

/**
 * Verifies the authentication tag for a v3 control packet.
 *
 * @param headerData - Header bytes 0..12
 * @param payload - Control payload without trailing auth tag
 * @param authTag - Trailing auth tag from the packet
 * @param secretKey - Secret key in any supported format
 * @returns True when authentication succeeds
 */
export function verifyControlPacketAuthTag(
  headerData: Buffer,
  payload: Buffer | string | null,
  authTag: Buffer,
  secretKey: string
): boolean {
  if (!Buffer.isBuffer(authTag) || authTag.length !== CONTROL_AUTH_TAG_LENGTH) {
    throw new Error("Control packet authentication tag missing");
  }

  const expected = createControlPacketAuthTag(headerData, payload, secretKey);
  if (!crypto.timingSafeEqual(expected, authTag)) {
    throw new Error("Control packet authentication failed");
  }

  return true;
}
