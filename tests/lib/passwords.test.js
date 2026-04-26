const { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } = require('../../src/lib/passwords');

describe('hashPassword', () => {
  it('produces scrypt$<salt>$<hash> format', async () => {
    const hash = await hashPassword('correctpassword');
    expect(hash).toMatch(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]+$/);
  });

  it('produces different hashes for the same password (salt randomness)', async () => {
    const a = await hashPassword('samepassword');
    const b = await hashPassword('samepassword');
    expect(a).not.toBe(b);
  });

  it(`rejects passwords shorter than ${MIN_PASSWORD_LENGTH} chars`, async () => {
    await expect(hashPassword('short')).rejects.toThrow(/at least 8 characters/);
  });

  it.each([null, undefined, '', 0, false])('rejects %p', async input => {
    await expect(hashPassword(input)).rejects.toThrow();
  });
});

describe('verifyPassword', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('correctpassword');
    await expect(verifyPassword('correctpassword', hash)).resolves.toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correctpassword');
    await expect(verifyPassword('wrongpassword', hash)).resolves.toBe(false);
  });

  it('rejects null/empty inputs without throwing', async () => {
    await expect(verifyPassword('', 'scrypt$00$00')).resolves.toBe(false);
    await expect(verifyPassword('x', '')).resolves.toBe(false);
    await expect(verifyPassword(null, null)).resolves.toBe(false);
  });

  it('rejects malformed stored hashes', async () => {
    await expect(verifyPassword('x', 'plaintext')).resolves.toBe(false);
    await expect(verifyPassword('x', 'bcrypt$00$00')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$only_two_parts')).resolves.toBe(false);
  });

  it('rejects when stored has empty salt or hash', async () => {
    await expect(verifyPassword('x', 'scrypt$$abc')).resolves.toBe(false);
    await expect(verifyPassword('x', 'scrypt$abc$')).resolves.toBe(false);
  });
});
