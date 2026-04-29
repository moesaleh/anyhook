/**
 * AES-256-GCM envelope encryption for column-level secrets.
 *
 * Used for users.totp_secret. Reads the master key from
 * TOTP_SECRET_KEY (production) and derives a per-record encryption
 * key + IV; output is `enc:v1:<iv_hex>:<ciphertext_hex>:<tag_hex>`.
 * The `enc:v1:` prefix lets decrypt() distinguish ciphertext from
 * legacy plaintext rows during the on-read migration window.
 *
 * Without TOTP_SECRET_KEY set, encrypt() returns the plaintext
 * unchanged and decrypt() expects plaintext. That keeps dev and
 * test environments simple — production sets the env var, plaintext
 * rows in the wild are upgraded transparently on first verify.
 *
 * Key requirements: 32+ chars (used as input to scrypt to derive a
 * 32-byte AES-256 key). Generate with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Rotation strategy: when the key changes, the old ciphertext can no
 * longer decrypt. The intended workflow is:
 *   1. Add OLD key as TOTP_SECRET_KEY_OLD env var, NEW key as TOTP_SECRET_KEY.
 *   2. decrypt() tries TOTP_SECRET_KEY first, falls back to TOTP_SECRET_KEY_OLD.
 *   3. encrypt() always uses TOTP_SECRET_KEY.
 *   4. After all rows have been re-saved (background job or natural
 *      verify-traffic over enrollment_pending lifetime), drop the
 *      _OLD env var.
 */

const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const KEY_LEN = 32; // AES-256
const IV_LEN = 12; // GCM 96-bit nonce
const TAG_LEN = 16;

function deriveKey(masterKey) {
  if (!masterKey || typeof masterKey !== 'string' || masterKey.length < 32) {
    throw new Error('Envelope key must be a string of at least 32 characters');
  }
  // Use scrypt with a fixed app-wide salt to derive a 32-byte AES key
  // from the master string. This lets operators paste any sufficiently
  // long secret into TOTP_SECRET_KEY without needing exactly 32 bytes
  // of high-entropy bytes; scrypt handles stretching.
  return crypto.scryptSync(masterKey, 'anyhook.envelope.v1', KEY_LEN);
}

function getKey(envName = 'TOTP_SECRET_KEY') {
  const v = process.env[envName];
  if (!v) return null;
  return deriveKey(v);
}

function encrypt(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new TypeError('encrypt expects a string plaintext');
  }
  const key = getKey();
  if (!key) {
    // No key configured — pass through unchanged. Production should
    // set TOTP_SECRET_KEY; dev/tests can run without it.
    return plaintext;
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('hex')}:${encrypted.toString('hex')}:${tag.toString('hex')}`;
}

/**
 * Returns { plaintext, neededRotation } where:
 *   plaintext: the decoded secret, ready to use
 *   neededRotation: true iff the input was decrypted with the OLD key
 *                   (or was legacy plaintext) and the caller should
 *                   re-encrypt with the current key
 */
function decrypt(value) {
  if (typeof value !== 'string') {
    throw new TypeError('decrypt expects a string');
  }
  if (!value.startsWith(PREFIX)) {
    // Legacy plaintext row from before envelope encryption was wired
    // up. Caller should re-encrypt and persist.
    return { plaintext: value, neededRotation: true };
  }
  const parts = value.slice(PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed envelope ciphertext');
  }
  const [ivHex, ctHex, tagHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const ct = Buffer.from(ctHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  if (iv.length !== IV_LEN || tag.length !== TAG_LEN) {
    throw new Error('Malformed envelope ciphertext');
  }

  // Try current key, then optional OLD key for rotation.
  const tryKeys = [
    { key: getKey('TOTP_SECRET_KEY'), needsRotation: false },
    { key: getKey('TOTP_SECRET_KEY_OLD'), needsRotation: true },
  ].filter(k => k.key !== null);

  if (tryKeys.length === 0) {
    throw new Error(
      'TOTP_SECRET_KEY is not set but encrypted data was loaded. ' +
        'Restore the env var or rotate via TOTP_SECRET_KEY_OLD.'
    );
  }

  for (const { key, needsRotation } of tryKeys) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      return { plaintext, neededRotation: needsRotation };
    } catch {
      // Try next key
    }
  }
  throw new Error('Decryption failed — wrong TOTP_SECRET_KEY?');
}

function isCiphertext(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isCiphertext, PREFIX };
