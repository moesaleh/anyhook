/**
 * API key generation + verification.
 *
 * Format: `ak_<base64url(32 random bytes)>`. The `ak_` prefix makes keys
 * recognizable in logs / source code / git history (so secret scanners can
 * pick them up) and gives users a quick visual sanity check.
 *
 * Storage: only the SHA-256 hex of the raw key is stored. Lookups hash
 * the incoming bearer and match by hash. The raw value is shown to the
 * user ONLY at creation time.
 */

const crypto = require('crypto');

const KEY_PREFIX = 'ak_';
const RAW_BYTES = 32;
const PREFIX_LENGTH = KEY_PREFIX.length + 8; // "ak_" + first 8 chars for UI display

function generateApiKey() {
  const raw = `${KEY_PREFIX}${crypto.randomBytes(RAW_BYTES).toString('base64url')}`;
  const hash = hashApiKey(raw);
  const prefix = raw.slice(0, PREFIX_LENGTH);
  return { raw, hash, prefix };
}

function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = { generateApiKey, hashApiKey, KEY_PREFIX };
