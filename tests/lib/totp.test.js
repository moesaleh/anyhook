const crypto = require('crypto');
const {
  generateTotpSecret,
  generateTotp,
  verifyTotp,
  verifyTotpAndGetStep,
  otpauthUrl,
  generateBackupCodes,
  hashBackupCode,
  base32Encode,
  base32Decode,
} = require('../../src/lib/totp');

describe('base32 round-trip', () => {
  it('decode(encode(x)) === x', () => {
    for (let len = 1; len < 32; len += 3) {
      const buf = crypto.randomBytes(len);
      const decoded = base32Decode(base32Encode(buf));
      expect(decoded.equals(buf)).toBe(true);
    }
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('!!!')).toThrow(/Invalid base32/);
  });

  it('strips padding equal signs', () => {
    // Round-trip with padding stripped is identical to without
    const buf = crypto.randomBytes(13);
    const encoded = base32Encode(buf);
    expect(base32Decode(encoded + '====')).toEqual(base32Decode(encoded));
  });
});

describe('generateTotpSecret', () => {
  it('produces a base32 string of 32 chars (20 bytes)', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]+$/);
    // 20 bytes -> 32 base32 chars (no padding for 20)
    expect(s.length).toBe(32);
  });

  it('produces unique secrets', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
  });
});

describe('generateTotp + verifyTotp', () => {
  // RFC 6238 test vectors expect SHA-1 + 8-byte secret '12345678901234567890'
  // base32-encoded as GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ.
  const RFC_SECRET_BYTES = Buffer.from('12345678901234567890', 'utf-8');
  const RFC_SECRET = base32Encode(RFC_SECRET_BYTES);

  it.each([
    [59, '94287082'.slice(-6)],
    [1111111109, '07081804'.slice(-6)],
    [1111111111, '14050471'.slice(-6)],
    [1234567890, '89005924'.slice(-6)],
  ])('matches RFC 6238 vector at t=%d', (t, expected) => {
    const code = generateTotp(RFC_SECRET, { time: t * 1000 });
    expect(code).toBe(expected);
  });

  it('verifies its own freshly-generated code', () => {
    const secret = generateTotpSecret();
    const code = generateTotp(secret);
    expect(verifyTotp(secret, code)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '000000')).toBe(false);
  });

  it('accepts a code from one step earlier (clock-skew tolerance)', () => {
    const secret = generateTotpSecret();
    const past = generateTotp(secret, { time: Date.now() - 30_000 });
    expect(verifyTotp(secret, past)).toBe(true);
  });

  it('rejects a code from too long ago', () => {
    const secret = generateTotpSecret();
    const ancient = generateTotp(secret, { time: Date.now() - 5 * 60_000 });
    expect(verifyTotp(secret, ancient)).toBe(false);
  });

  it.each([null, undefined, '', 'abcdef', '12345', '1234567'])(
    'rejects malformed code %p',
    code => {
      const secret = generateTotpSecret();
      expect(verifyTotp(secret, code)).toBe(false);
    }
  );
});

describe('verifyTotpAndGetStep (replay-guard primitive)', () => {
  it('returns the step counter that matched on success', () => {
    const secret = generateTotpSecret();
    const t = 1700000000000; // fixed epoch ms
    const code = generateTotp(secret, { time: t });
    const expectedStep = Math.floor(t / 1000 / 30);
    expect(verifyTotpAndGetStep(secret, code, { time: t })).toBe(expectedStep);
  });

  it('returns null on failure', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpAndGetStep(secret, '000000')).toBe(null);
  });

  it('returns the previous step when matching the -1 window', () => {
    const secret = generateTotpSecret();
    const now = 1700000000000;
    const past = generateTotp(secret, { time: now - 30_000 });
    const expectedStep = Math.floor((now - 30_000) / 1000 / 30);
    expect(verifyTotpAndGetStep(secret, past, { time: now })).toBe(expectedStep);
  });
});

describe('otpauthUrl', () => {
  it('includes secret + issuer + label', () => {
    const url = otpauthUrl({ secret: 'JBSWY3DPEHPK3PXP', label: 'a@example.com' });
    expect(url.startsWith('otpauth://totp/AnyHook:a%40example.com?')).toBe(true);
    expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(url).toContain('issuer=AnyHook');
    expect(url).toContain('algorithm=SHA1');
    expect(url).toContain('digits=6');
    expect(url).toContain('period=30');
  });

  it('honors custom issuer', () => {
    const url = otpauthUrl({ secret: 'X', label: 'l', issuer: 'Test Co' });
    expect(url.startsWith('otpauth://totp/Test%20Co:l?')).toBe(true);
    expect(url).toContain('issuer=Test+Co');
  });
});

describe('generateBackupCodes', () => {
  it('produces N codes by default 10', () => {
    expect(generateBackupCodes().length).toBe(10);
    expect(generateBackupCodes(5).length).toBe(5);
  });

  it('codes are in xxxx-xxxx form', () => {
    for (const c of generateBackupCodes(3)) {
      expect(c.raw).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
    }
  });

  it('codes are unique within a batch', () => {
    const codes = generateBackupCodes(20).map(c => c.raw);
    expect(new Set(codes).size).toBe(20);
  });

  it('hash matches sha256 hex of raw', () => {
    const { raw, hash } = generateBackupCodes(1)[0];
    expect(hash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
  });
});

describe('hashBackupCode', () => {
  it('deterministic', () => {
    expect(hashBackupCode('abcd-1234')).toBe(hashBackupCode('abcd-1234'));
  });
});
