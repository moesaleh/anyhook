const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
} = require('./setup');

describeIfPg('auth + tenancy (integration)', () => {
  let app;

  beforeAll(async () => {
    ({ app } = await setupTestApp());
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  describe('POST /auth/register', () => {
    it('creates a user, an org, and sets a session cookie', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'alice@example.com', password: 'password123', name: 'Alice' });

      expect(res.status).toBe(201);
      expect(res.body.user).toMatchObject({ email: 'alice@example.com', name: 'Alice' });
      expect(res.body.organization).toMatchObject({ role: 'owner' });
      expect(res.headers['set-cookie']).toBeDefined();
      expect(res.headers['set-cookie'].some(c => c.startsWith('anyhook_session='))).toBe(true);
    });

    it('uses the supplied organization_name when provided', async () => {
      const res = await request(app).post('/auth/register').send({
        email: 'bob@example.com',
        password: 'password123',
        organization_name: 'Acme Inc',
      });

      expect(res.status).toBe(201);
      expect(res.body.organization.name).toBe('Acme Inc');
      expect(res.body.organization.slug).toMatch(/^acme-inc/);
    });

    it('rejects duplicate email with 409', async () => {
      await request(app)
        .post('/auth/register')
        .send({ email: 'dup@example.com', password: 'password123' })
        .expect(201);

      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'dup@example.com', password: 'password123' });
      expect(res.status).toBe(409);
    });

    it('rejects passwords shorter than 8 chars with 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'short@example.com', password: 'short' });
      expect(res.status).toBe(400);
    });

    it('rejects malformed email with 400', async () => {
      const res = await request(app)
        .post('/auth/register')
        .send({ email: 'not-an-email', password: 'password123' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      await request(app)
        .post('/auth/register')
        .send({ email: 'carol@example.com', password: 'password123', name: 'Carol' });
    });

    it('returns 200 + cookie for the right credentials', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'carol@example.com', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('carol@example.com');
      expect(res.body.organization).toBeDefined();
      expect(res.headers['set-cookie']).toBeDefined();
    });

    it('case-insensitive email lookup', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'Carol@example.com', password: 'password123' });
      expect(res.status).toBe(200);
    });

    it('returns 401 for the wrong password', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'carol@example.com', password: 'wrong-password' });
      expect(res.status).toBe(401);
    });

    it('returns 401 for an unknown email', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ email: 'ghost@example.com', password: 'password123' });
      expect(res.status).toBe(401);
    });

    it('returns 400 when fields are missing', async () => {
      const res = await request(app).post('/auth/login').send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /auth/me', () => {
    let cookie;

    beforeEach(async () => {
      const reg = await request(app)
        .post('/auth/register')
        .send({ email: 'dave@example.com', password: 'password123', name: 'Dave' });
      cookie = getSessionCookie(reg.headers['set-cookie']);
    });

    it('returns the current user + org with cookie', async () => {
      const res = await request(app).get('/auth/me').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe('dave@example.com');
      expect(res.body.organization).toBeDefined();
      expect(res.body.organizations.length).toBe(1);
      expect(res.body.via).toBe('cookie');
    });

    it('returns 401 without a cookie', async () => {
      const res = await request(app).get('/auth/me');
      expect(res.status).toBe(401);
    });

    it('returns 401 with a bogus cookie', async () => {
      const res = await request(app)
        .get('/auth/me')
        .set('Cookie', 'anyhook_session=not-a-real-jwt');
      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('clears the session cookie', async () => {
      const res = await request(app).post('/auth/logout');
      expect(res.status).toBe(200);
      // clearCookie sets an expired Set-Cookie
      const setCookie = res.headers['set-cookie'] || [];
      expect(setCookie.some(c => c.startsWith('anyhook_session='))).toBe(true);
    });
  });

  describe('protected route enforcement', () => {
    it('GET /subscriptions returns 401 without auth', async () => {
      const res = await request(app).get('/subscriptions');
      expect(res.status).toBe(401);
    });

    it('GET /subscriptions returns [] for a freshly-registered user', async () => {
      const reg = await request(app)
        .post('/auth/register')
        .send({ email: 'eve@example.com', password: 'password123' });
      const cookie = getSessionCookie(reg.headers['set-cookie']);
      const res = await request(app).get('/subscriptions').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('multi-org isolation', () => {
    it("one user cannot see another org's subscriptions", async () => {
      // User A's org
      const regA = await request(app)
        .post('/auth/register')
        .send({ email: 'a@example.com', password: 'password123', organization_name: 'A Co' });
      const cookieA = getSessionCookie(regA.headers['set-cookie']);

      // User B's org
      const regB = await request(app)
        .post('/auth/register')
        .send({ email: 'b@example.com', password: 'password123', organization_name: 'B Co' });
      const cookieB = getSessionCookie(regB.headers['set-cookie']);

      // A creates a subscription
      const create = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({
          connection_type: 'graphql',
          args: {
            endpoint_url: 'wss://api.example.com/graphql',
            query: 'subscription { x }',
          },
          webhook_url: 'https://hooks.example.com/in',
        });
      expect(create.status).toBe(201);
      const subId = create.body.subscriptionId;

      // B can't see it via list
      const listB = await request(app).get('/subscriptions').set('Cookie', cookieB);
      expect(listB.status).toBe(200);
      expect(listB.body).toEqual([]);

      // B can't see it by id (404, not 403 — don't leak existence)
      const getB = await request(app).get(`/subscriptions/${subId}`).set('Cookie', cookieB);
      expect(getB.status).toBe(404);

      // A can see it
      const listA = await request(app).get('/subscriptions').set('Cookie', cookieA);
      expect(listA.status).toBe(200);
      expect(listA.body).toHaveLength(1);
      expect(listA.body[0].subscription_id).toBe(subId);
      // webhook_secret is stripped on GET
      expect(listA.body[0].webhook_secret).toBeUndefined();
    });
  });
});
