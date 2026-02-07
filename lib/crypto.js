const crypto = require("crypto");

// Use AES-256-GCM for authenticated encryption (encryption + authentication in one)
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // GCM standard IV length
const AUTH_TAG_LENGTH = 16; // GCM authentication tag length

/**
 * Encrypts data using AES-256-GCM with binary output
 * Binary format: [IV (12 bytes)][Encrypted Data][Auth Tag (16 bytes)]
 * @param {Buffer} data - Data to encrypt
 * @param {string} secretKey - 32-character secret key
 * @returns {Buffer} Binary packet with IV, encrypted data, and auth tag
 * @throws {Error} If secretKey is invalid or data is empty
 */
const encryptBinary = (data, secretKey) => {
  // Validate inputs
  if (!secretKey || typeof secretKey !== "string" || secretKey.length !== 32) {
    throw new Error("Secret key must be exactly 32 characters");
  }
  if (!data || (Buffer.isBuffer(data) && data.length === 0)) {
    throw new Error("Data to encrypt cannot be empty");
  }

  // Ensure data is a Buffer
  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);

  // Generate random IV for each encryption (critical for GCM security)
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, secretKey, iv);

  const encrypted = Buffer.concat([cipher.update(dataBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Return single buffer: [IV][Encrypted][AuthTag]
  return Buffer.concat([iv, encrypted, authTag]);
};

/**
 * Decrypts data encrypted with AES-256-GCM
 * @param {Buffer} packet - Binary packet with IV, encrypted data, and auth tag
 * @param {string} secretKey - 32-character secret key
 * @returns {Buffer} Decrypted data as Buffer
 * @throws {Error} If secretKey or packet is invalid, or authentication fails
 */
const decryptBinary = (packet, secretKey) => {
  // Validate inputs
  if (!secretKey || typeof secretKey !== "string" || secretKey.length !== 32) {
    throw new Error("Secret key must be exactly 32 characters");
  }
  if (!Buffer.isBuffer(packet) || packet.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid packet size");
  }

  // Extract components from packet (subarray provides zero-copy views)
  const iv = packet.subarray(0, IV_LENGTH);
  const authTag = packet.subarray(packet.length - AUTH_TAG_LENGTH);
  const encrypted = packet.subarray(IV_LENGTH, packet.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, secretKey, iv);
  decipher.setAuthTag(authTag);

  // This will throw if authentication fails (tampered data)
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
};

/**
 * Validates secret key strength
 * @param {string} key - Secret key to validate
 * @returns {boolean} True if key is valid
 * @throws {Error} If key is weak or invalid
 */
function validateSecretKey(key) {
  if (!key || typeof key !== "string" || key.length !== 32) {
    throw new Error("Secret key must be exactly 32 characters");
  }

  // Check for common weak patterns (all same character)
  if (/^(.)\1{31}$/.test(key)) {
    throw new Error("Secret key has insufficient entropy (all same character)");
  }

  // Check character diversity
  const uniqueChars = new Set(key.split("")).size;
  if (uniqueChars < 8) {
    throw new Error("Secret key has insufficient diversity (use at least 8 different characters)");
  }

  return true;
}

module.exports = {
  encryptBinary,
  decryptBinary,
  validateSecretKey,
  IV_LENGTH,
  AUTH_TAG_LENGTH
};
