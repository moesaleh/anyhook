/**
 * Webhook HMAC signing.
 *
 * Wire format (set on outgoing requests as X-AnyHook-Signature):
 *   t=<unix_seconds>,v1=<hex_hmac_sha256>
 *
 * Where the HMAC is computed over `<unix_seconds>.<request_body>`. The
 * timestamp prevents replay attacks; receivers should reject signatures
 * whose `t` is more than maxAgeSec (default 300) seconds away from now.
 *
 * This module is exported so receivers can reuse the same verification
 * logic AnyHook uses internally (no surprise-different schemes).
 */

const crypto = require('crypto');

function signRequest(secret, timestampSec, rawBody) {
  if (!secret) throw new Error('signRequest requires a secret');
  const payload = `${timestampSec}.${rawBody == null ? '' : rawBody}`;
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return { signature: `t=${timestampSec},v1=${hmac}`, hmac };
}

/**
 * Verify a signature header against the secret + body.
 * Returns { ok: true } on success, { ok: false, reason: '...' } otherwise.
 *
 * Reasons:
 *   missing_signature   — header was null/undefined/empty
 *   malformed_signature — could not parse t=... and v1=... pieces
 *   timestamp_too_old   — `t` outside the maxAgeSec window
 *   signature_mismatch  — HMACs don't match (could be wrong secret OR
 *                         tampered body OR wrong timestamp)
 */
function verifySignature(secret, signatureHeader, rawBody, { maxAgeSec = 300 } = {}) {
  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!secret) return { ok: false, reason: 'missing_secret' };

  const parts = String(signatureHeader)
    .split(',')
    .reduce((acc, part) => {
      const eq = part.indexOf('=');
      if (eq === -1) return acc;
      acc[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
      return acc;
    }, {});

  const timestamp = parseInt(parts.t, 10);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) {
    return { ok: false, reason: 'malformed_signature' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > maxAgeSec) {
    return { ok: false, reason: 'timestamp_too_old' };
  }

  const { hmac: expected } = signRequest(secret, timestamp, rawBody);
  let expectedBuf, providedBuf;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    providedBuf = Buffer.from(provided, 'hex');
  } catch {
    return { ok: false, reason: 'malformed_signature' };
  }
  if (expectedBuf.length !== providedBuf.length) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) {
    return { ok: false, reason: 'signature_mismatch' };
  }
  return { ok: true };
}

module.exports = { signRequest, verifySignature };
