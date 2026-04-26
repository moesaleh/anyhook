const crypto = require('crypto');
const {
  generateInvitationToken,
  hashInvitationToken,
  TOKEN_PREFIX,
  DEFAULT_EXPIRY_DAYS,
} = require('../../src/lib/invitations');

describe('generateInvitationToken', () => {
  it('produces inv_-prefixed raw value', () => {
    const { raw } = generateInvitationToken();
    expect(raw.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(raw).toMatch(/^inv_[A-Za-z0-9_-]+$/);
  });

  it('hash matches sha256 hex of raw', () => {
    const { raw, hash } = generateInvitationToken();
    expect(hash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces unique tokens', () => {
    const tokens = Array.from({ length: 10 }, () => generateInvitationToken().raw);
    expect(new Set(tokens).size).toBe(10);
  });

  it('hash is consistent across calls', () => {
    const { raw, hash } = generateInvitationToken();
    expect(hashInvitationToken(raw)).toBe(hash);
  });
});

describe('hashInvitationToken', () => {
  it('is deterministic', () => {
    expect(hashInvitationToken('inv_test')).toBe(hashInvitationToken('inv_test'));
  });

  it('matches manual sha256 hex', () => {
    const expected = crypto.createHash('sha256').update('inv_anything').digest('hex');
    expect(hashInvitationToken('inv_anything')).toBe(expected);
  });
});

describe('DEFAULT_EXPIRY_DAYS', () => {
  it('is a sensible default (7 days)', () => {
    expect(DEFAULT_EXPIRY_DAYS).toBe(7);
  });
});
