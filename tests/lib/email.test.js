const { makeEmailTransport } = require('../../src/lib/email');

describe('makeEmailTransport (no SMTP_HOST)', () => {
  it('returns enabled: false when SMTP_HOST is unset', () => {
    const t = makeEmailTransport({ env: {} });
    expect(t.enabled).toBe(false);
  });

  it('uses default from address when EMAIL_FROM unset', () => {
    const t = makeEmailTransport({ env: {} });
    expect(t.from).toBe('noreply@anyhook.local');
  });

  it('honors EMAIL_FROM', () => {
    const t = makeEmailTransport({ env: { EMAIL_FROM: 'team@example.com' } });
    expect(t.from).toBe('team@example.com');
  });

  it('send() is a no-op that logs and returns delivered: false', async () => {
    const logged = [];
    const log = { info: (msg, meta) => logged.push({ msg, meta }) };
    const t = makeEmailTransport({ env: {}, log });
    const res = await t.send({ to: 'x@example.com', subject: 's', text: 'hello' });
    expect(res).toEqual({ delivered: false, reason: 'no_transport' });
    expect(logged.length).toBe(1);
    expect(logged[0].meta.to).toBe('x@example.com');
    expect(logged[0].meta.subject).toBe('s');
  });

  it('send() truncates the body in the log preview', async () => {
    const logged = [];
    const log = { info: (msg, meta) => logged.push({ msg, meta }) };
    const t = makeEmailTransport({ env: {}, log });
    const longBody = 'A'.repeat(1000);
    await t.send({ to: 'x@example.com', subject: 's', text: longBody });
    expect(logged[0].meta.text_preview.length).toBe(200);
  });
});

describe('makeEmailTransport (SMTP_HOST set)', () => {
  // We don't actually send mail in unit tests — just verify the transport
  // construction reads the right env vars + reports enabled: true.
  // Real send goes through nodemailer, mocked separately if needed.

  it('returns enabled: true when SMTP_HOST is set', () => {
    const t = makeEmailTransport({
      env: { SMTP_HOST: 'smtp.example.com' },
    });
    expect(t.enabled).toBe(true);
  });

  it('exposes the from address', () => {
    const t = makeEmailTransport({
      env: { SMTP_HOST: 'smtp.example.com', EMAIL_FROM: 'noreply@x.com' },
    });
    expect(t.from).toBe('noreply@x.com');
  });
});
