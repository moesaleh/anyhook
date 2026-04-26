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

function signSession(userId, organizationId, options = {}) {
  return jwt.sign({ sub: userId, org: organizationId }, getJwtSecret(), {
    expiresIn: options.expiresIn || DEFAULT_EXPIRES_IN,
    issuer: ISSUER,
  });
}

function verifySession(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, getJwtSecret(), { issuer: ISSUER });
  } catch {
    return null;
  }
}

module.exports = { signSession, verifySession, ISSUER, MIN_SECRET_LENGTH };
