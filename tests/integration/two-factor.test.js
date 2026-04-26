const request = require('supertest');
const { generateTotp } = require('../../src/lib/totp');
const {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
} = require('./setup');

describeIfPg('2FA / TOTP (integration)', () => {
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
      .send({ email: '2fa@example.com', password: 'password123' });
    cookie = getSessionCookie(reg.headers['set-cookie']);
  });

  describe('GET /auth/2fa/status', () => {
    it('starts disabled with no pending enrollment', async () => {
      const res = await request(app).get('/auth/2fa/status').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        enabled: false,
        enrollment_pending: false,
        unused_backup_codes: 0,
      });
    });

    it('rejects API-key auth', async () => {
      const k = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'k1' });
      const res = await request(app)
        .get('/auth/2fa/status')
        .set('Authorization', `Bearer ${k.body.key}`);
      expect(res.status).toBe(403);
    });
  });

  describe('Setup → verify-setup → backup codes', () => {
    it('generates a secret + otpauth URL on setup', async () => {
      const res = await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.secret).toMatch(/^[A-Z2-7]+$/);
      expect(res.body.otpauth_url).toContain('otpauth://totp/');
      expect(res.body.otpauth_url).toContain(`secret=${res.body.secret}`);
    });

    it('marks status as enrollment_pending after setup', async () => {
      await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      const status = await request(app).get('/auth/2fa/status').set('Cookie', cookie);
      expect(status.body.enabled).toBe(false);
      expect(status.body.enrollment_pending).toBe(true);
    });

    it('verify-setup with the right code enables 2FA + returns 10 backup codes', async () => {
      const setup = await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      const code = generateTotp(setup.body.secret);
      const verify = await request(app)
        .post('/auth/2fa/verify-setup')
        .set('Cookie', cookie)
        .send({ code });
      expect(verify.status).toBe(200);
      expect(verify.body.enabled).toBe(true);
      expect(verify.body.backup_codes).toHaveLength(10);
      for (const c of verify.body.backup_codes) {
        expect(c).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
      }

      const status = await request(app).get('/auth/2fa/status').set('Cookie', cookie);
      expect(status.body.enabled).toBe(true);
      expect(status.body.unused_backup_codes).toBe(10);
    });

    it('verify-setup rejects wrong code', async () => {
      await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      const verify = await request(app)
        .post('/auth/2fa/verify-setup')
        .set('Cookie', cookie)
        .send({ code: '000000' });
      expect(verify.status).toBe(401);
    });

    it('verify-setup rejects when no enrollment pending', async () => {
      const verify = await request(app)
        .post('/auth/2fa/verify-setup')
        .set('Cookie', cookie)
        .send({ code: '123456' });
      expect(verify.status).toBe(400);
    });

    it('setup refuses if 2FA already enabled', async () => {
      const setup = await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      await request(app)
        .post('/auth/2fa/verify-setup')
        .set('Cookie', cookie)
        .send({ code: generateTotp(setup.body.secret) });

      const second = await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      expect(second.status).toBe(409);
    });
  });

  describe('Login flow with 2FA enabled', () => {
    let secret;
    let backupCodes;

    beforeEach(async () => {
      const setup = await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      secret = setup.body.secret;
      const verify = await request(app)
        .post('/auth/2fa/verify-setup')
        .set('Cookie', cookie)
        .send({ code: generateTotp(secret) });
      backupCodes = verify.body.backup_codes;
    });

    it('login returns needs_2fa + pending_token, NO cookie', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: '2fa@example.com', password: 'password123' });
      expect(res.status).toBe(200);
      expect(res.body.needs_2fa).toBe(true);
      expect(res.body.pending_token).toBeDefined();
      // cookie not set on the partial-login response
      const setCookie = res.headers['set-cookie'] || [];
      expect(setCookie.some(c => c.startsWith('anyhook_session='))).toBe(false);
    });

    it('verify-login with correct TOTP completes login + sets cookie', async () => {
      const login = await request(app)
        .post('/auth/login')
        .send({ email: '2fa@example.com', password: 'password123' });
      const verify = await request(app)
        .post('/auth/2fa/verify-login')
        .send({
          pending_token: login.body.pending_token,
          code: generateTotp(secret),
        });
      expect(verify.status).toBe(200);
      expect(verify.body.user.email).toBe('2fa@example.com');
      expect(verify.headers['set-cookie'].some(c => c.startsWith('anyhook_session='))).toBe(true);
    });

    it('verify-login accepts a backup code AND consumes it', async () => {
      const login = await request(app)
        .post('/auth/login')
        .send({ email: '2fa@example.com', password: 'password123' });
      const verify = await request(app).post('/auth/2fa/verify-login').send({
        pending_token: login.body.pending_token,
        code: backupCodes[0],
      });
      expect(verify.status).toBe(200);

      // Status now shows 9 unused
      const newCookie = getSessionCookie(verify.headers['set-cookie']);
      const status = await request(app).get('/auth/2fa/status').set('Cookie', newCookie);
      expect(status.body.unused_backup_codes).toBe(9);

      // Same backup code can't be reused
      const login2 = await request(app)
        .post('/auth/login')
        .send({ email: '2fa@example.com', password: 'password123' });
      const verify2 = await request(app).post('/auth/2fa/verify-login').send({
        pending_token: login2.body.pending_token,
        code: backupCodes[0],
      });
      expect(verify2.status).toBe(401);
    });

    it('verify-login rejects wrong TOTP', async () => {
      const login = await request(app)
        .post('/auth/login')
        .send({ email: '2fa@example.com', password: 'password123' });
      const verify = await request(app).post('/auth/2fa/verify-login').send({
        pending_token: login.body.pending_token,
        code: '000000',
      });
      expect(verify.status).toBe(401);
    });

    it('verify-login rejects bogus pending_token', async () => {
      const verify = await request(app)
        .post('/auth/2fa/verify-login')
        .send({
          pending_token: 'not.a.token',
          code: generateTotp(secret),
        });
      expect(verify.status).toBe(401);
    });
  });

  describe('Disable 2FA', () => {
    let secret;

    beforeEach(async () => {
      const setup = await request(app).post('/auth/2fa/setup').set('Cookie', cookie);
      secret = setup.body.secret;
      await request(app)
        .post('/auth/2fa/verify-setup')
        .set('Cookie', cookie)
        .send({ code: generateTotp(secret) });
    });

    it('disables with correct password + TOTP', async () => {
      const res = await request(app)
        .post('/auth/2fa/disable')
        .set('Cookie', cookie)
        .send({
          current_password: 'password123',
          code: generateTotp(secret),
        });
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);

      const status = await request(app).get('/auth/2fa/status').set('Cookie', cookie);
      expect(status.body.enabled).toBe(false);
      expect(status.body.unused_backup_codes).toBe(0);

      // Login is back to single-step
      const login = await request(app)
        .post('/auth/login')
        .send({ email: '2fa@example.com', password: 'password123' });
      expect(login.body.needs_2fa).toBeUndefined();
    });

    it('rejects wrong password', async () => {
      const res = await request(app)
        .post('/auth/2fa/disable')
        .set('Cookie', cookie)
        .send({
          current_password: 'wrong',
          code: generateTotp(secret),
        });
      expect(res.status).toBe(401);
    });

    it('rejects wrong TOTP', async () => {
      const res = await request(app).post('/auth/2fa/disable').set('Cookie', cookie).send({
        current_password: 'password123',
        code: '000000',
      });
      expect(res.status).toBe(401);
    });
  });
});
