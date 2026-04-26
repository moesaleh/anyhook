const crypto = require('crypto');
const {
  generateResetToken,
  hashResetToken,
  TOKEN_PREFIX,
  DEFAULT_EXPIRY_HOURS,
} = require('../../src/lib/password-reset');

describe('generateResetToken', () => {
  it('produces pwr_-prefixed value', () => {
    const { raw } = generateResetToken();
    expect(raw.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(raw).toMatch(/^pwr_[A-Za-z0-9_-]+$/);
  });

  it('hash is sha256 of raw', () => {
    const { raw, hash } = generateResetToken();
    expect(hash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
  });

  it('unique', () => {
    const tokens = Array.from({ length: 10 }, () => generateResetToken().raw);
    expect(new Set(tokens).size).toBe(10);
  });
});

describe('hashResetToken', () => {
  it('deterministic', () => {
    expect(hashResetToken('pwr_test')).toBe(hashResetToken('pwr_test'));
  });
});

describe('DEFAULT_EXPIRY_HOURS', () => {
  it('is 2 hours', () => {
    expect(DEFAULT_EXPIRY_HOURS).toBe(2);
  });
});
