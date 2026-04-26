const crypto = require('crypto');
const { generateApiKey, hashApiKey, KEY_PREFIX } = require('../../src/lib/api-keys');

describe('generateApiKey', () => {
  it('produces ak_-prefixed raw value', () => {
    const { raw } = generateApiKey();
    expect(raw.startsWith(KEY_PREFIX)).toBe(true);
    // base64url alphabet after the prefix
    expect(raw).toMatch(/^ak_[A-Za-z0-9_-]+$/);
  });

  it('prefix is the first 11 chars (ak_ + 8)', () => {
    const { raw, prefix } = generateApiKey();
    expect(prefix).toBe(raw.slice(0, 11));
    expect(prefix.length).toBe(11);
  });

  it('hash matches sha256 of raw', () => {
    const { raw, hash } = generateApiKey();
    expect(hash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique keys (10 in a row, no collision)', () => {
    const keys = Array.from({ length: 10 }, () => generateApiKey().raw);
    expect(new Set(keys).size).toBe(10);
  });

  it('hash is consistent across calls', () => {
    const { raw, hash } = generateApiKey();
    expect(hashApiKey(raw)).toBe(hash);
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    expect(hashApiKey('ak_test')).toBe(hashApiKey('ak_test'));
  });

  it('matches manual sha256 hex', () => {
    const expected = crypto.createHash('sha256').update('ak_anything').digest('hex');
    expect(hashApiKey('ak_anything')).toBe(expected);
  });

  it('handles empty input deterministically', () => {
    expect(hashApiKey('')).toBe(hashApiKey(''));
  });
});
