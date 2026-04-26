const { signSession, verifySession, ISSUER, MIN_SECRET_LENGTH } = require('../../src/lib/jwt');

const ORIGINAL_SECRET = process.env.JWT_SECRET;

beforeEach(() => {
  process.env.JWT_SECRET = 'a'.repeat(48);
});

afterAll(() => {
  if (ORIGINAL_SECRET) process.env.JWT_SECRET = ORIGINAL_SECRET;
  else delete process.env.JWT_SECRET;
});

describe('signSession + verifySession', () => {
  it('round-trips claims', () => {
    const token = signSession('user-1', 'org-1');
    const claims = verifySession(token);
    expect(claims).toMatchObject({ sub: 'user-1', org: 'org-1', iss: ISSUER });
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('returns null for tampered tokens', () => {
    const token = signSession('user-1', 'org-1');
    const tampered = token.slice(0, -3) + 'xxx';
    expect(verifySession(tampered)).toBeNull();
  });

  it('returns null for tokens signed with a different secret', () => {
    const token = signSession('user-1', 'org-1');
    process.env.JWT_SECRET = 'b'.repeat(48);
    expect(verifySession(token)).toBeNull();
  });

  it('rejects expired tokens', async () => {
    const token = signSession('u', 'o', { expiresIn: '1ms' });
    // wait past expiry
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(verifySession(token)).toBeNull();
  });

  it('returns null for null/empty/garbage', () => {
    expect(verifySession(null)).toBeNull();
    expect(verifySession('')).toBeNull();
    expect(verifySession('not.a.jwt')).toBeNull();
  });

  it(`throws if JWT_SECRET is shorter than ${MIN_SECRET_LENGTH} chars`, () => {
    process.env.JWT_SECRET = 'short';
    expect(() => signSession('u', 'o')).toThrow(/at least 32 characters/);
  });

  it('throws if JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    expect(() => signSession('u', 'o')).toThrow(/at least 32 characters/);
  });
});
