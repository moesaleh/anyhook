const { encrypt, decrypt, isCiphertext, PREFIX } = require('../../src/lib/envelope');

const ORIGINAL = process.env.TOTP_SECRET_KEY;
const ORIGINAL_OLD = process.env.TOTP_SECRET_KEY_OLD;

afterEach(() => {
  if (ORIGINAL !== undefined) process.env.TOTP_SECRET_KEY = ORIGINAL;
  else delete process.env.TOTP_SECRET_KEY;
  if (ORIGINAL_OLD !== undefined) process.env.TOTP_SECRET_KEY_OLD = ORIGINAL_OLD;
  else delete process.env.TOTP_SECRET_KEY_OLD;
});

describe('envelope.encrypt + decrypt (no key set)', () => {
  beforeEach(() => {
    delete process.env.TOTP_SECRET_KEY;
    delete process.env.TOTP_SECRET_KEY_OLD;
  });

  it('passes plaintext through when no key is configured', () => {
    expect(encrypt('JBSWY3DPEHPK3PXP')).toBe('JBSWY3DPEHPK3PXP');
  });

  it('decrypt returns plaintext unchanged + neededRotation: true', () => {
    expect(decrypt('JBSWY3DPEHPK3PXP')).toEqual({
      plaintext: 'JBSWY3DPEHPK3PXP',
      neededRotation: true,
    });
  });
});

describe('envelope.encrypt + decrypt (key set)', () => {
  beforeEach(() => {
    process.env.TOTP_SECRET_KEY = 'a'.repeat(48);
    delete process.env.TOTP_SECRET_KEY_OLD;
  });

  it('round-trips a TOTP secret', () => {
    const ct = encrypt('JBSWY3DPEHPK3PXP');
    expect(ct).toMatch(new RegExp(`^${PREFIX}[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$`));
    expect(decrypt(ct)).toEqual({
      plaintext: 'JBSWY3DPEHPK3PXP',
      neededRotation: false,
    });
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const a = encrypt('hello');
    const b = encrypt('hello');
    expect(a).not.toBe(b);
    expect(decrypt(a).plaintext).toBe('hello');
    expect(decrypt(b).plaintext).toBe('hello');
  });

  it('flags legacy plaintext (no prefix) as neededRotation', () => {
    const result = decrypt('plaintext-that-pre-dates-encryption');
    expect(result.plaintext).toBe('plaintext-that-pre-dates-encryption');
    expect(result.neededRotation).toBe(true);
  });

  it('rejects a too-short master key', () => {
    process.env.TOTP_SECRET_KEY = 'short';
    expect(() => encrypt('x')).toThrow(/at least 32/);
  });

  it('throws on tampered ciphertext (auth tag mismatch)', () => {
    const ct = encrypt('JBSWY3DPEHPK3PXP');
    // Flip a nibble in the ciphertext middle section
    const tampered = ct.replace(/:([0-9a-f])/, (m, c) => `:${c === '0' ? '1' : '0'}`);
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on a malformed envelope', () => {
    expect(() => decrypt(`${PREFIX}only:two`)).toThrow(/Malformed/);
  });
});

describe('isCiphertext', () => {
  it.each([
    ['enc:v1:abc:def:ghi', true],
    ['plain-text', false],
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('isCiphertext(%j) === %j', (input, expected) => {
    expect(isCiphertext(input)).toBe(expected);
  });
});

describe('envelope rotation (TOTP_SECRET_KEY_OLD)', () => {
  it('decrypts with OLD key + flags rotation', () => {
    // Simulate the rotation scenario: encrypt with key A, then make A
    // the OLD key + put a different B as the current key. Decrypt
    // should fall through to OLD and report neededRotation.
    process.env.TOTP_SECRET_KEY = 'a'.repeat(48);
    const oldCt = encrypt('JBSWY3DPEHPK3PXP');

    process.env.TOTP_SECRET_KEY_OLD = 'a'.repeat(48);
    process.env.TOTP_SECRET_KEY = 'b'.repeat(48);

    const result = decrypt(oldCt);
    expect(result.plaintext).toBe('JBSWY3DPEHPK3PXP');
    expect(result.neededRotation).toBe(true);
  });

  it('decrypts with current key + reports neededRotation: false', () => {
    process.env.TOTP_SECRET_KEY = 'a'.repeat(48);
    process.env.TOTP_SECRET_KEY_OLD = 'b'.repeat(48);
    const ct = encrypt('JBSWY3DPEHPK3PXP');
    const result = decrypt(ct);
    expect(result.plaintext).toBe('JBSWY3DPEHPK3PXP');
    expect(result.neededRotation).toBe(false);
  });
});
