const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
} = require('./setup');

const validSub = {
  connection_type: 'graphql',
  args: { endpoint_url: 'wss://api.example.com/graphql', query: 'subscription { x }' },
  webhook_url: 'https://hooks.example.com/in',
};

describeIfPg('per-org quotas (integration)', () => {
  let app;
  let pool;
  let cookie;
  let orgId;
  const ORIGINAL_ENV = {};

  beforeAll(async () => {
    // Tighten the limits for the test run so we don't have to create 100 subs
    ORIGINAL_ENV.ORG_MAX_SUBSCRIPTIONS = process.env.ORG_MAX_SUBSCRIPTIONS;
    ORIGINAL_ENV.ORG_MAX_API_KEYS = process.env.ORG_MAX_API_KEYS;
    process.env.ORG_MAX_SUBSCRIPTIONS = '3';
    process.env.ORG_MAX_API_KEYS = '2';
    ({ app, pool } = await setupTestApp());
  });

  afterAll(async () => {
    if (ORIGINAL_ENV.ORG_MAX_SUBSCRIPTIONS !== undefined) {
      process.env.ORG_MAX_SUBSCRIPTIONS = ORIGINAL_ENV.ORG_MAX_SUBSCRIPTIONS;
    } else {
      delete process.env.ORG_MAX_SUBSCRIPTIONS;
    }
    if (ORIGINAL_ENV.ORG_MAX_API_KEYS !== undefined) {
      process.env.ORG_MAX_API_KEYS = ORIGINAL_ENV.ORG_MAX_API_KEYS;
    } else {
      delete process.env.ORG_MAX_API_KEYS;
    }
    await teardownTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const reg = await request(app)
      .post('/auth/register')
      .send({ email: 'q@example.com', password: 'password123' });
    cookie = getSessionCookie(reg.headers['set-cookie']);
    orgId = reg.body.organization.id;
  });

  describe('subscription quota (limit=3)', () => {
    it('allows up to the limit then blocks with 429 + headers + JSON', async () => {
      // 3 succeed
      for (let i = 0; i < 3; i++) {
        const r = await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
        expect(r.status).toBe(201);
      }
      // 4th blocked
      const blocked = await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({
        error: expect.stringContaining('Subscription quota exceeded'),
        quota: 'subscriptions',
        used: 3,
        limit: 3,
      });
      expect(blocked.headers['x-quota-limit']).toBe('3');
      expect(blocked.headers['x-quota-used']).toBe('3');
    });

    it('quota frees up after a delete', async () => {
      const created = [];
      for (let i = 0; i < 3; i++) {
        const r = await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
        created.push(r.body.subscriptionId);
      }
      // Cap reached
      const blocked = await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
      expect(blocked.status).toBe(429);

      // Delete one — back under cap
      await request(app)
        .post('/unsubscribe')
        .set('Cookie', cookie)
        .send({ subscription_id: created[0] });

      const allowed = await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
      expect(allowed.status).toBe(201);
    });

    it("isolates orgs (one org's cap does not affect another)", async () => {
      // Fill org A
      for (let i = 0; i < 3; i++) {
        await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
      }
      // Register a new user in a separate org
      const reg2 = await request(app)
        .post('/auth/register')
        .send({ email: 'q2@example.com', password: 'password123', organization_name: 'B Co' });
      const cookie2 = getSessionCookie(reg2.headers['set-cookie']);

      // B can still create
      const r = await request(app).post('/subscribe').set('Cookie', cookie2).send(validSub);
      expect(r.status).toBe(201);
    });
  });

  describe('API key quota (limit=2)', () => {
    it('allows up to the limit then blocks with 429', async () => {
      for (let i = 0; i < 2; i++) {
        const r = await request(app)
          .post('/organizations/current/api-keys')
          .set('Cookie', cookie)
          .send({ name: `k${i}` });
        expect(r.status).toBe(201);
      }
      const blocked = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'over' });
      expect(blocked.status).toBe(429);
      expect(blocked.body.quota).toBe('api_keys');
    });

    it('revoked keys do NOT count against the cap', async () => {
      const k1 = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'k1' });
      const k2 = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'k2' });

      // Cap: would be 429
      const blockedBefore = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'k3' });
      expect(blockedBefore.status).toBe(429);

      // Revoke one
      await request(app)
        .delete(`/organizations/current/api-keys/${k1.body.id}`)
        .set('Cookie', cookie);

      // Now k3 should succeed (k2 active + k3 active = 2)
      const allowed = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'k3' });
      expect(allowed.status).toBe(201);

      // Sanity: k2 still active
      const list = await request(app).get('/organizations/current/api-keys').set('Cookie', cookie);
      const active = list.body.filter(k => !k.revoked_at);
      expect(active.length).toBe(2);
      expect(active.find(k => k.id === k2.body.id)).toBeDefined();
    });
  });

  describe('GET /organizations/current/quotas', () => {
    it('returns zeros for a fresh org', async () => {
      const res = await request(app).get('/organizations/current/quotas').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        subscriptions: { used: 0, limit: 3 },
        api_keys: { used: 0, limit: 2 },
      });
    });

    it('reflects current usage', async () => {
      await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
      await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'k1' });

      const res = await request(app).get('/organizations/current/quotas').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        subscriptions: { used: 1, limit: 3 },
        api_keys: { used: 1, limit: 2 },
      });
    });

    it('does not count revoked api keys', async () => {
      const k = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'tmp' });
      await request(app)
        .delete(`/organizations/current/api-keys/${k.body.id}`)
        .set('Cookie', cookie);

      const res = await request(app).get('/organizations/current/quotas').set('Cookie', cookie);
      expect(res.body.api_keys.used).toBe(0);
    });

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/organizations/current/quotas');
      expect(res.status).toBe(401);
    });

    it('isolates orgs', async () => {
      // Fill org A with 2 subs
      await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
      await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);

      // Register org B
      const reg2 = await request(app)
        .post('/auth/register')
        .send({ email: 'q3@example.com', password: 'password123', organization_name: 'C Co' });
      const cookie2 = getSessionCookie(reg2.headers['set-cookie']);

      const a = await request(app).get('/organizations/current/quotas').set('Cookie', cookie);
      const b = await request(app).get('/organizations/current/quotas').set('Cookie', cookie2);
      expect(a.body.subscriptions.used).toBe(2);
      expect(b.body.subscriptions.used).toBe(0);
    });
  });

  describe('quota headers on a successful create', () => {
    it('subscription create returns X-Quota-Used reflecting current count', async () => {
      const r1 = await request(app).post('/subscribe').set('Cookie', cookie).send(validSub);
      // Headers reflect count BEFORE the insert (used = 0 here).
      expect(r1.headers['x-quota-limit']).toBe('3');
      expect(r1.headers['x-quota-used']).toBe('0');
      // verify the orgId is the one we registered
      const row = await pool.query(
        'SELECT organization_id FROM subscriptions WHERE subscription_id = $1',
        [r1.body.subscriptionId]
      );
      expect(row.rows[0].organization_id).toBe(orgId);
    });
  });
});
