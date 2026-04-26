/**
 * Organization invitation tokens.
 *
 * Format: `inv_<base64url(32 random bytes)>`. The `inv_` prefix mirrors
 * the `ak_` API-key convention so secret scanners pick them up.
 *
 * Storage: only SHA-256(raw) is stored in invitations.token_hash. The
 * raw value is shown to the inviter ONCE at creation time and shared
 * with the invitee out-of-band (email, Slack, copy-paste).
 */

const crypto = require('crypto');

const TOKEN_PREFIX = 'inv_';
const RAW_BYTES = 32;
const DEFAULT_EXPIRY_DAYS = 7;

function generateInvitationToken() {
  const raw = `${TOKEN_PREFIX}${crypto.randomBytes(RAW_BYTES).toString('base64url')}`;
  const hash = hashInvitationToken(raw);
  return { raw, hash };
}

function hashInvitationToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  generateInvitationToken,
  hashInvitationToken,
  TOKEN_PREFIX,
  DEFAULT_EXPIRY_DAYS,
};
