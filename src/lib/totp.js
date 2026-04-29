/**
 * TOTP (RFC 6238) — Time-based One-Time Password.
 *
 * Rolled in-house to avoid pulling in `speakeasy`/`otplib`. ~120 lines
 * including base32 + otpauth URL generation. Verified against the RFC's
 * test vectors in tests/lib/totp.test.js.
 *
 * Defaults match Google Authenticator: SHA-1, 30-second step, 6 digits,
 * ±1 step verification window (so a code accepted at second 29 still
 * works at second 32 to handle clock skew).
 *
 * Backup codes are emitted in `xxxx-xxxx` form (8 hex chars + dash, ~32
 * bits each — single-use, so the moderate entropy is fine).
 */

const crypto = require('crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP = 30;
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(str) {
  const cleaned = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`Invalid base32 character: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Generate a new TOTP shared secret (default 20 bytes = 160 bits). */
function generateTotpSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

/**
 * Compute the HOTP/TOTP code for a given counter value.
 * Internal — public surface is generateTotp(secret, opts).
 */
function hotp(secretBuf, counter, digits) {
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', secretBuf).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  const mod = 10 ** digits;
  return String(code % mod).padStart(digits, '0');
}

function generateTotp(
  secret,
  { time = Date.now(), step = DEFAULT_STEP, digits = DEFAULT_DIGITS } = {}
) {
  const counter = Math.floor(time / 1000 / step);
  return hotp(base32Decode(secret), counter, digits);
}

/**
 * Verify a 6-digit code against a secret with a ±window-step tolerance.
 * Returns true if the code matches at any step within [now-window, now+window].
 * Constant-time comparison prevents timing leaks.
 */
function verifyTotp(
  secret,
  code,
  { time = Date.now(), step = DEFAULT_STEP, digits = DEFAULT_DIGITS, window = DEFAULT_WINDOW } = {}
) {
  return verifyTotpAndGetStep(secret, code, { time, step, digits, window }) !== null;
}

/**
 * Like verifyTotp but returns the matching step counter (an integer
 * count of `step`-second intervals since the Unix epoch) on success,
 * or null on failure. The caller can persist the returned step as the
 * "highest accepted step" for the user, then reject any subsequent
 * code at step <= that — closing the replay window where a code is
 * still inside the ±1 step tolerance for ~90s but has already been
 * used.
 */
function verifyTotpAndGetStep(
  secret,
  code,
  { time = Date.now(), step = DEFAULT_STEP, digits = DEFAULT_DIGITS, window = DEFAULT_WINDOW } = {}
) {
  if (!secret || code == null) return null;
  const codeStr = String(code).padStart(digits, '0');
  if (codeStr.length !== digits || !/^\d+$/.test(codeStr)) return null;
  const secretBuf = base32Decode(secret);
  const baseCounter = Math.floor(time / 1000 / step);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secretBuf, baseCounter + w, digits);
    const a = Buffer.from(expected);
    const b = Buffer.from(codeStr);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
      return baseCounter + w;
    }
  }
  return null;
}

/**
 * Build an otpauth:// URI for QR-code rendering by the authenticator app.
 * Format per https://github.com/google/google-authenticator/wiki/Key-Uri-Format
 */
function otpauthUrl({ secret, label, issuer = 'AnyHook' }) {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DEFAULT_DIGITS),
    period: String(DEFAULT_STEP),
  });
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?${params}`;
}

/**
 * Generate N backup codes (default 10). Each code is single-use.
 *
 * Format: `xxxxxxxx-xxxxxxxx` — 64 bits of entropy (was 32 bits in the
 * earlier `xxxx-xxxx` form). The longer form makes a brute-force attack
 * against a leaked backup_codes table infeasible even without
 * key-stretching: 2^64 / (commodity GPU rate ~10^11/s) ~= 5800 years.
 *
 * Hashing: HMAC-SHA256 with BACKUP_CODE_PEPPER (if set), else SHA-256.
 * The pepper is a system-wide secret separate from JWT_SECRET — an
 * attacker with only DB read access cannot brute-force the codes
 * without it. Production deployments should set it. Without it (dev /
 * tests / unconfigured prod) we keep returning SHA-256 hashes so
 * existing rows in backup_codes still validate.
 *
 * Backwards-compat with the previous `xxxx-xxxx` 32-bit format and
 * unsalted SHA-256: the verifier (in auth.js) accepts BOTH the new
 * regex shape and the legacy one, and looks up by both peppered AND
 * unpeppered hashes — so codes generated before this upgrade keep
 * working until the user regenerates.
 */
const BACKUP_CODE_REGEX = /^([0-9a-f]{4}-[0-9a-f]{4}|[0-9a-f]{8}-[0-9a-f]{8})$/;

function generateBackupCodes(count = 10) {
  return Array.from({ length: count }, () => {
    // 4 bytes per half = 64 bits total
    const raw = `${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
    return { raw, hash: hashBackupCode(raw) };
  });
}

function hashBackupCode(raw) {
  const pepper = process.env.BACKUP_CODE_PEPPER;
  if (pepper) {
    return crypto.createHmac('sha256', pepper).update(raw).digest('hex');
  }
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * Legacy hash function — always plain SHA-256 regardless of pepper.
 * Used for backwards-compat lookups against rows generated before
 * BACKUP_CODE_PEPPER was introduced. New rows always use
 * hashBackupCode() (which is peppered when pepper is set).
 */
function legacyHashBackupCode(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

module.exports = {
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  verifyTotpAndGetStep,
  otpauthUrl,
  generateBackupCodes,
  hashBackupCode,
  legacyHashBackupCode,
  BACKUP_CODE_REGEX,
  base32Encode,
  base32Decode,
};
