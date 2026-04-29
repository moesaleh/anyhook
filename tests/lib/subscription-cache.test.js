const {
  SUBSCRIPTION_KEY_PREFIX,
  SUBSCRIPTION_KEY_PATTERN,
  subscriptionCacheKey,
  subscriptionIdFromKey,
} = require('../../src/lib/subscription-cache');

describe('subscription-cache key helpers', () => {
  it('uses sub: as the prefix', () => {
    expect(SUBSCRIPTION_KEY_PREFIX).toBe('sub:');
    expect(SUBSCRIPTION_KEY_PATTERN).toBe('sub:*');
  });

  it('subscriptionCacheKey wraps a UUID', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(subscriptionCacheKey(id)).toBe(`sub:${id}`);
  });

  it('subscriptionIdFromKey unwraps a sub:<id> key', () => {
    const id = '11111111-2222-3333-4444-555555555555';
    expect(subscriptionIdFromKey(`sub:${id}`)).toBe(id);
  });

  it.each([
    [null, null],
    [undefined, null],
    ['', null],
    ['ratelimit:org-1:1234', null],
    ['auth-rl:1.2.3.4:1234', null],
    ['random-key', null],
    [42, null], // non-string
    [{}, null],
  ])('subscriptionIdFromKey(%j) returns null for non-sub keys', (input, expected) => {
    expect(subscriptionIdFromKey(input)).toBe(expected);
  });

  it('round-trip: key → id → key', () => {
    const id = 'abc-123';
    const key = subscriptionCacheKey(id);
    expect(subscriptionIdFromKey(key)).toBe(id);
  });
});
