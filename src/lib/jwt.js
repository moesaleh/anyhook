/**
 * JWT helpers for dashboard session cookies.
 *
 * HS256 signed with JWT_SECRET (>=32 chars), 7-day default expiry.
 * `iss: 'anyhook'` so we reject tokens signed with the same secret by
 * unrelated services.
 */

const jwt = require('jsonwebtoken');

const ISSUER = 'anyhook';
const DEFAULT_EXPIRES_IN = '7d';
const MIN_SECRET_LENGTH = 32;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be set to a value at least ${MIN_SECRET_LENGTH} characters long`
    );
  }
  return secret;
}

/**
 * Sign a session JWT.
 *
 * @param {string} userId
 * @param {string} organizationId
 * @param {object} options
 * @param {number} [options.tokenVersion=0] — users.token_version at sign
 *   time. requireAuth re-checks this against the live row on every
 *   authenticated request, so bumping it invalidates outstanding cookies
 *   (logout, password change, 2FA disable).
 * @param {string} [options.expiresIn]
 */
function signSession(userId, organizationId, options = {}) {
  return jwt.sign(
    { sub: userId, org: organizationId, tv: options.tokenVersion || 0 },
    getJwtSecret(),
    {
      expiresIn: options.expiresIn || DEFAULT_EXPIRES_IN,
      issuer: ISSUER,
    }
  );
}

function verifySession(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, getJwtSecret(), { issuer: ISSUER });
  } catch {
    return null;
  }
}

/**
 * Sign a short-lived single-purpose token (e.g. "2FA pending login").
 * Distinct from session tokens by the `purpose` claim, so a verify
 * function can refuse to use them as session credentials.
 */
function signEphemeralToken(payload, { expiresIn = '5m' } = {}) {
  return jwt.sign(payload, getJwtSecret(), { expiresIn, issuer: ISSUER });
}

function verifyEphemeralToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, getJwtSecret(), { issuer: ISSUER });
  } catch {
    return null;
  }
}

module.exports = {
  signSession,
  verifySession,
  signEphemeralToken,
  verifyEphemeralToken,
  ISSUER,
  MIN_SECRET_LENGTH,
};
