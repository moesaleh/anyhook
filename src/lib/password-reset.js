/**
 * Password reset tokens.
 *
 * Format: `pwr_<base64url(32 random bytes)>`. Same pattern as API keys
 * and invitation tokens — only SHA-256(raw) is stored; raw is shown in
 * the API response (or, in production, emailed to the user).
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'pwr_';
const RAW_BYTES = 32;
const DEFAULT_EXPIRY_HOURS = 2;

function generateResetToken() {
  const raw = `${TOKEN_PREFIX}${crypto.randomBytes(RAW_BYTES).toString('base64url')}`;
  return { raw, hash: hashResetToken(raw) };
}

function hashResetToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  generateResetToken,
  hashResetToken,
  TOKEN_PREFIX,
  DEFAULT_EXPIRY_HOURS,
};
