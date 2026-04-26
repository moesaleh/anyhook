/**
 * Password hashing using Node's built-in scrypt.
 *
 * Stored format: `scrypt$<salt_hex>$<hash_hex>`. Verification re-derives
 * with the stored salt and uses timingSafeEqual to avoid leaking timing
 * differences between near-matches.
 */

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 8;

async function hashPassword(plain) {
  if (!plain || typeof plain !== 'string' || plain.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  if (!plain || !stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const derived = await scrypt(plain, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH };
