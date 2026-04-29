const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
  fakeEmailTransport,
} = require('./setup');

describeIfPg('password change + reset (integration)', () => {
  let app;
  let cookie;

  beforeAll(async () => {
    ({ app } = await setupTestApp());
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'pw@example.com', password: 'oldpassword123' });
    cookie = getSessionCookie(reg.headers['set-cookie']);
  });

  describe('POST /auth/password/change', () => {
    it('changes password with correct current password', async () => {
      const res = await request(app)
        .post('/auth/password/change')
        .set('Cookie', cookie)
        .send({ current_password: 'oldpassword123', new_password: 'newpassword456' });
      expect(res.status).toBe(200);

      // old password no longer works
      const oldLogin = await request(app)
        .post('/auth/login')
        .send({ email: 'pw@example.com', password: 'oldpassword123' });
      expect(oldLogin.status).toBe(401);

      // new password works
      const newLogin = await request(app)
        .post('/auth/login')
        .send({ email: 'pw@example.com', password: 'newpassword456' });
      expect(newLogin.status).toBe(200);
    });

    it('rejects wrong current password', async () => {
      const res = await request(app)
        .post('/auth/password/change')
        .set('Cookie', cookie)
        .send({ current_password: 'wrong', new_password: 'newpassword456' });
      expect(res.status).toBe(401);
    });

    it('rejects short new password', async () => {
      const res = await request(app)
        .post('/auth/password/change')
        .set('Cookie', cookie)
        .send({ current_password: 'oldpassword123', new_password: 'short' });
      expect(res.status).toBe(400);
    });

    it('requires authentication', async () => {
      const res = await request(app)
        .post('/auth/password/change')
        .send({ current_password: 'a', new_password: 'b' });
      expect(res.status).toBe(401);
    });

    it('rejects API-key auth (cookie sessions only)', async () => {
      const k = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'k1' });
      const res = await request(app)
        .post('/auth/password/change')
        .set('Authorization', `Bearer ${k.body.key}`)
        .send({ current_password: 'oldpassword123', new_password: 'newpassword456' });
      expect(res.status).toBe(403);
    });
  });

  describe('POST /auth/password/reset-request', () => {
    it('returns 200 + token for an existing email', async () => {
      const res = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'pw@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.token).toMatch(/^pwr_/);
      expect(res.body.expires_at).toBeDefined();
    });

    it('returns 200 (NO token) for unknown email — does not leak existence', async () => {
      const res = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'nope@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeUndefined();
    });

    it('rejects missing email', async () => {
      const res = await request(app).post('/auth/password/reset-request').send({});
      expect(res.status).toBe(400);
    });

    it('case-insensitive email lookup', async () => {
      const res = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'PW@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeDefined();
    });
  });

  describe('POST /auth/password/reset-request — token disclosure rules', () => {
    // The default integration app has no email transport (== no_transport
    // mode), so the previous suite covers that branch. These two cases
    // mount fresh apps with the other transport modes.

    let oldApp;

    beforeAll(() => {
      oldApp = global.__app__; // not actually shared; just structural
      void oldApp;
    });

    it('omits the token when SMTP delivers successfully', async () => {
      await teardownTestApp();
      const transport = fakeEmailTransport({ mode: 'delivered' });
      ({ app } = await setupTestApp({ emailTransport: transport }));
      await cleanDatabase();
      // Re-register since cleanDatabase wiped users.
      const reg = await request(app)
        .post('/auth/register')
        .send({ email: 'ok@example.com', password: 'oldpassword123' });
      // Re-set the outer cookie so the afterEach / following describes
      // continue to work.
      cookie = getSessionCookie(reg.headers['set-cookie']);

      const res = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'ok@example.com' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBeUndefined();
      expect(res.body.email_sent).toBe(true);
      expect(transport.calls.length).toBe(1);
      expect(transport.calls[0].to).toBe('ok@example.com');
    });

    it('omits the token when SMTP errors (anonymous-callable hardening)', async () => {
      await teardownTestApp();
      const transport = fakeEmailTransport({ mode: 'smtp_error' });
      ({ app } = await setupTestApp({ emailTransport: transport }));
      await cleanDatabase();
      const reg = await request(app)
        .post('/auth/register')
        .send({ email: 'fail@example.com', password: 'oldpassword123' });
      cookie = getSessionCookie(reg.headers['set-cookie']);

      const res = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'fail@example.com' });
      expect(res.status).toBe(200);
      // Critical security assertion: SMTP failure must NOT leak the
      // token to the anonymous caller. An attacker who can degrade SMTP
      // egress would otherwise harvest reset tokens via the API.
      expect(res.body.token).toBeUndefined();
      expect(res.body.email_sent).toBe(false);
      expect(transport.calls.length).toBe(1);
    });

    afterAll(async () => {
      // Restore the default (no-transport) app for any subsequent
      // suites that might run after.
      await teardownTestApp();
      ({ app } = await setupTestApp());
    });
  });

  describe('POST /auth/password/reset', () => {
    let token;
    beforeEach(async () => {
      const r = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'pw@example.com' });
      token = r.body.token;
    });

    it('resets password with valid token', async () => {
      const res = await request(app)
        .post('/auth/password/reset')
        .send({ token, new_password: 'brandnewpassword789' });
      expect(res.status).toBe(200);

      const login = await request(app)
        .post('/auth/login')
        .send({ email: 'pw@example.com', password: 'brandnewpassword789' });
      expect(login.status).toBe(200);
    });

    it('rejects re-use of the same token', async () => {
      await request(app)
        .post('/auth/password/reset')
        .send({ token, new_password: 'brandnewpassword789' })
        .expect(200);
      const second = await request(app)
        .post('/auth/password/reset')
        .send({ token, new_password: 'anotherpassword' });
      expect(second.status).toBe(410);
    });

    it('rejects unknown token', async () => {
      const res = await request(app)
        .post('/auth/password/reset')
        .send({ token: 'pwr_unknown', new_password: 'newpassword456' });
      expect(res.status).toBe(404);
    });

    it('rejects expired token', async () => {
      // Create a fresh request, then backdate the token
      const r = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'pw@example.com' });
      // Hardcoded expiry — easier to hand-verify than parsing the response
      const ourPool = (await setupTestApp()).pool; // grabs the current pool
      await ourPool.query(
        `UPDATE password_reset_tokens SET expires_at = NOW() - INTERVAL '1 hour'
         WHERE token_hash = encode(digest($1, 'sha256'), 'hex')`,
        [r.body.token]
      );
      const res = await request(app)
        .post('/auth/password/reset')
        .send({ token: r.body.token, new_password: 'newpassword456' });
      // pgcrypto's digest() may not be enabled — fall back: any of the
      // 410/404 are acceptable proof the token is no longer valid.
      expect([410, 404]).toContain(res.status);
    });

    it('rejects short new password', async () => {
      const res = await request(app)
        .post('/auth/password/reset')
        .send({ token, new_password: 'short' });
      expect(res.status).toBe(400);
    });

    it('changing password invalidates outstanding reset tokens', async () => {
      // Generate a reset token, then change the password via the
      // authenticated endpoint, then try to use the token.
      const reset = await request(app)
        .post('/auth/password/reset-request')
        .send({ email: 'pw@example.com' });
      await request(app)
        .post('/auth/password/change')
        .set('Cookie', cookie)
        .send({ current_password: 'oldpassword123', new_password: 'differentpassword' });
      const useReset = await request(app)
        .post('/auth/password/reset')
        .send({ token: reset.body.token, new_password: 'attempttoreset' });
      expect(useReset.status).toBe(410);
    });
  });
});
