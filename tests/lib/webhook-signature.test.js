const { signRequest, verifySignature } = require('../../src/lib/webhook-signature');

describe('signRequest', () => {
  it('signature has the t=<ts>,v1=<hex> format', () => {
    const { signature } = signRequest('secret', 1700000000, 'body');
    expect(signature).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
  });

  it('is deterministic for the same inputs', () => {
    const a = signRequest('secret', 1700000000, 'body');
    const b = signRequest('secret', 1700000000, 'body');
    expect(a.hmac).toBe(b.hmac);
    expect(a.signature).toBe(b.signature);
  });

  it('different timestamps produce different sigs', () => {
    const a = signRequest('secret', 1, 'body');
    const b = signRequest('secret', 2, 'body');
    expect(a.hmac).not.toBe(b.hmac);
  });

  it('different bodies produce different sigs', () => {
    const a = signRequest('secret', 1700000000, 'body1');
    const b = signRequest('secret', 1700000000, 'body2');
    expect(a.hmac).not.toBe(b.hmac);
  });

  it('different secrets produce different sigs', () => {
    const a = signRequest('secret-a', 1700000000, 'body');
    const b = signRequest('secret-b', 1700000000, 'body');
    expect(a.hmac).not.toBe(b.hmac);
  });

  it('throws if secret is missing', () => {
    expect(() => signRequest('', 1, 'body')).toThrow();
    expect(() => signRequest(null, 1, 'body')).toThrow();
  });

  it('treats null body as empty string', () => {
    const a = signRequest('s', 1, '');
    const b = signRequest('s', 1, null);
    expect(a.hmac).toBe(b.hmac);
  });
});

describe('verifySignature', () => {
  function freshSig(secret, body) {
    const ts = Math.floor(Date.now() / 1000);
    return signRequest(secret, ts, body).signature;
  }

  it('accepts a fresh, valid signature', () => {
    expect(verifySignature('secret', freshSig('secret', 'body'), 'body')).toEqual({ ok: true });
  });

  it('rejects tampered body', () => {
    const result = verifySignature('secret', freshSig('secret', 'body'), 'tampered');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects wrong secret', () => {
    const result = verifySignature('wrong', freshSig('right', 'body'), 'body');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature_mismatch');
  });

  it('rejects timestamps outside maxAgeSec window', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const sig = signRequest('secret', oldTs, 'body').signature;
    const result = verifySignature('secret', sig, 'body', { maxAgeSec: 300 });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timestamp_too_old');
  });

  it('accepts old timestamps if maxAgeSec is wide enough', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 600;
    const sig = signRequest('secret', oldTs, 'body').signature;
    expect(verifySignature('secret', sig, 'body', { maxAgeSec: 3600 }).ok).toBe(true);
  });

  it('rejects malformed signatures', () => {
    expect(verifySignature('s', 'not-a-sig', 'b').reason).toBe('malformed_signature');
    expect(verifySignature('s', 't=1', 'b').reason).toBe('malformed_signature');
    expect(verifySignature('s', 'v1=abc', 'b').reason).toBe('malformed_signature');
    expect(verifySignature('s', 't=notanumber,v1=abc', 'b').reason).toBe('malformed_signature');
  });

  it('rejects missing signature header', () => {
    expect(verifySignature('s', null, 'b').reason).toBe('missing_signature');
    expect(verifySignature('s', undefined, 'b').reason).toBe('missing_signature');
    expect(verifySignature('s', '', 'b').reason).toBe('missing_signature');
  });

  it('rejects missing secret', () => {
    expect(verifySignature(null, 't=1,v1=abc', 'b').reason).toBe('missing_secret');
  });
});
