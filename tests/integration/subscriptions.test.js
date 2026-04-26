const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
} = require('./setup');

describeIfPg('subscriptions CRUD (integration)', () => {
  let app;
  let pool;
  let cookieA;
  let orgA;
  let cookieB;
  let orgB;

  const validBody = {
    connection_type: 'graphql',
    args: {
      endpoint_url: 'wss://api.example.com/graphql',
      query: 'subscription { x }',
    },
    webhook_url: 'https://hooks.example.com/in',
  };

  beforeAll(async () => {
    ({ app, pool } = await setupTestApp());
  });

  afterAll(async () => {
    await teardownTestApp();
  });

  beforeEach(async () => {
    await cleanDatabase();
    const ra = await request(app).post('/auth/register').send({
      email: 'a@example.com',
      password: 'password123',
      organization_name: 'A Co',
    });
    cookieA = getSessionCookie(ra.headers['set-cookie']);
    orgA = ra.body.organization.id;

    const rb = await request(app).post('/auth/register').send({
      email: 'b@example.com',
      password: 'password123',
      organization_name: 'B Co',
    });
    cookieB = getSessionCookie(rb.headers['set-cookie']);
    orgB = rb.body.organization.id;
  });

  // Sanity check the test setup wired both orgs (used by isolation tests below).
  function assertDistinctOrgs() {
    expect(orgA).toBeDefined();
    expect(orgB).toBeDefined();
    expect(orgA).not.toBe(orgB);
  }

  describe('POST /subscribe', () => {
    it('creates a sub and returns webhook_secret once', async () => {
      const res = await request(app).post('/subscribe').set('Cookie', cookieA).send(validBody);
      expect(res.status).toBe(201);
      expect(res.body.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.webhook_secret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('persists organization_id from req.auth, not from body', async () => {
      const res = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({ ...validBody, organization_id: orgB }); // attempt to forge org
      expect(res.status).toBe(201);
      const row = await pool.query(
        'SELECT organization_id FROM subscriptions WHERE subscription_id = $1',
        [res.body.subscriptionId]
      );
      expect(row.rows[0].organization_id).toBe(orgA);
    });

    it('rejects loopback webhook_url (SSRF)', async () => {
      const res = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({ ...validBody, webhook_url: 'http://localhost:9999/x' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/webhook_url/);
    });

    it('rejects RFC1918 webhook_url (SSRF)', async () => {
      const res = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({ ...validBody, webhook_url: 'http://10.0.0.1/x' });
      expect(res.status).toBe(400);
    });

    it('rejects IMDS webhook_url (SSRF)', async () => {
      const res = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({ ...validBody, webhook_url: 'http://169.254.169.254/latest/meta-data/' });
      expect(res.status).toBe(400);
    });

    it('rejects file:// scheme', async () => {
      const res = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({ ...validBody, webhook_url: 'file:///etc/passwd' });
      expect(res.status).toBe(400);
    });

    it('rejects unknown connection_type', async () => {
      const res = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({ ...validBody, connection_type: 'mqtt' });
      expect(res.status).toBe(400);
    });

    it('graphql requires args.query', async () => {
      const res = await request(app)
        .post('/subscribe')
        .set('Cookie', cookieA)
        .send({
          connection_type: 'graphql',
          args: { endpoint_url: 'wss://api.example.com/graphql' },
          webhook_url: 'https://hooks.example.com/in',
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/query/);
    });

    it('rejects without auth', async () => {
      const res = await request(app).post('/subscribe').send(validBody);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /subscriptions', () => {
    it('returns [] for a fresh org', async () => {
      const res = await request(app).get('/subscriptions').set('Cookie', cookieA);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('strips webhook_secret from results', async () => {
      await request(app).post('/subscribe').set('Cookie', cookieA).send(validBody);
      const list = await request(app).get('/subscriptions').set('Cookie', cookieA);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
      expect(list.body[0].webhook_secret).toBeUndefined();
      expect(list.body[0].organization_id).toBe(orgA);
    });

    it("does not leak another org's subscriptions", async () => {
      assertDistinctOrgs();
      await request(app).post('/subscribe').set('Cookie', cookieA).send(validBody);
      const listB = await request(app).get('/subscriptions').set('Cookie', cookieB);
      expect(listB.body).toEqual([]);
    });
  });

  describe('GET /subscriptions/:id', () => {
    let subId;
    beforeEach(async () => {
      const r = await request(app).post('/subscribe').set('Cookie', cookieA).send(validBody);
      subId = r.body.subscriptionId;
    });

    it('returns the subscription for its owner (no secret)', async () => {
      const res = await request(app).get(`/subscriptions/${subId}`).set('Cookie', cookieA);
      expect(res.status).toBe(200);
      expect(res.body.subscription_id).toBe(subId);
      expect(res.body.webhook_secret).toBeUndefined();
    });

    it('returns 404 for a foreign org (no existence leak)', async () => {
      const res = await request(app).get(`/subscriptions/${subId}`).set('Cookie', cookieB);
      expect(res.status).toBe(404);
    });

    it('returns 404 for a non-existent UUID', async () => {
      const res = await request(app)
        .get('/subscriptions/00000000-0000-0000-0000-000000000000')
        .set('Cookie', cookieA);
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /subscriptions/:id', () => {
    let subId;
    beforeEach(async () => {
      const r = await request(app).post('/subscribe').set('Cookie', cookieA).send(validBody);
      subId = r.body.subscriptionId;
    });

    it('updates own sub (webhook_url visible in response, no secret)', async () => {
      const res = await request(app)
        .put(`/subscriptions/${subId}`)
        .set('Cookie', cookieA)
        .send({ ...validBody, webhook_url: 'https://hooks.example.com/v2' });
      expect(res.status).toBe(200);
      expect(res.body.webhook_url).toBe('https://hooks.example.com/v2');
      expect(res.body.webhook_secret).toBeUndefined();
    });

    it('returns 404 for foreign org', async () => {
      const res = await request(app)
        .put(`/subscriptions/${subId}`)
        .set('Cookie', cookieB)
        .send(validBody);
      expect(res.status).toBe(404);
    });

    it('rejects invalid args', async () => {
      const res = await request(app)
        .put(`/subscriptions/${subId}`)
        .set('Cookie', cookieA)
        .send({
          connection_type: 'graphql',
          args: { endpoint_url: 'http://localhost' }, // SSRF + no query
          webhook_url: 'https://hooks.example.com/v2',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /unsubscribe', () => {
    let subId;
    beforeEach(async () => {
      const r = await request(app).post('/subscribe').set('Cookie', cookieA).send(validBody);
      subId = r.body.subscriptionId;
    });

    it('deletes own sub', async () => {
      const res = await request(app)
        .post('/unsubscribe')
        .set('Cookie', cookieA)
        .send({ subscription_id: subId });
      expect(res.status).toBe(200);
      const list = await request(app).get('/subscriptions').set('Cookie', cookieA);
      expect(list.body).toEqual([]);
    });

    it('returns 404 for foreign org (and does not delete)', async () => {
      const res = await request(app)
        .post('/unsubscribe')
        .set('Cookie', cookieB)
        .send({ subscription_id: subId });
      expect(res.status).toBe(404);
      const list = await request(app).get('/subscriptions').set('Cookie', cookieA);
      expect(list.body).toHaveLength(1); // still there
    });

    it('rejects without subscription_id', async () => {
      const res = await request(app).post('/unsubscribe').set('Cookie', cookieA).send({});
      expect(res.status).toBe(400);
    });
  });

  describe('GET /deliveries/stats (org-scoped)', () => {
    let subA, subB;

    beforeEach(async () => {
      const ra = await request(app).post('/subscribe').set('Cookie', cookieA).send(validBody);
      subA = ra.body.subscriptionId;
      const rb = await request(app).post('/subscribe').set('Cookie', cookieB).send(validBody);
      subB = rb.body.subscriptionId;

      // Insert delivery_events directly (the route is exercised by the
      // dispatcher; these tests pre-seed data to assert the read path).
      await pool.query(
        `INSERT INTO delivery_events (subscription_id, organization_id, event_id, status, response_time_ms)
         VALUES ($1, $2, gen_random_uuid(), 'success', 50),
                ($1, $2, gen_random_uuid(), 'success', 80),
                ($1, $2, gen_random_uuid(), 'failed',  120),
                ($3, $4, gen_random_uuid(), 'success', 30)`,
        [subA, orgA, subB, orgB]
      );
    });

    it('returns zeros for org with no events', async () => {
      // Truncate then re-register a third user
      await cleanDatabase();
      const rc = await request(app)
        .post('/auth/register')
        .send({ email: 'c@example.com', password: 'password123' });
      const cookieC = getSessionCookie(rc.headers['set-cookie']);
      const stats = await request(app).get('/deliveries/stats').set('Cookie', cookieC);
      expect(stats.status).toBe(200);
      expect(stats.body.total_deliveries).toBe(0);
      expect(stats.body.success_rate).toBe(0);
    });

    it("only counts the caller's org's events", async () => {
      const a = await request(app).get('/deliveries/stats').set('Cookie', cookieA);
      expect(a.status).toBe(200);
      expect(a.body.total_deliveries).toBe(3);
      expect(a.body.successful).toBe(2);
      expect(a.body.failed).toBe(1);

      const b = await request(app).get('/deliveries/stats').set('Cookie', cookieB);
      expect(b.body.total_deliveries).toBe(1);
      expect(b.body.successful).toBe(1);
    });

    it('per-subscription stats are scoped too', async () => {
      const a = await request(app)
        .get(`/subscriptions/${subA}/deliveries/stats`)
        .set('Cookie', cookieA);
      expect(a.status).toBe(200);
      expect(a.body.total_deliveries).toBe(3);

      // B can't query A's sub stats
      const denied = await request(app)
        .get(`/subscriptions/${subA}/deliveries/stats`)
        .set('Cookie', cookieB);
      expect(denied.status).toBe(200);
      expect(denied.body.total_deliveries).toBe(0); // empty because the WHERE matches no rows
    });

    it('GET /subscriptions/:id/deliveries paginates within the org', async () => {
      const r = await request(app)
        .get(`/subscriptions/${subA}/deliveries?limit=2&page=1`)
        .set('Cookie', cookieA);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(3);
      expect(r.body.pages).toBe(2);
      expect(r.body.deliveries).toHaveLength(2);
    });

    it('GET /subscriptions/:id/deliveries filters by status', async () => {
      const r = await request(app)
        .get(`/subscriptions/${subA}/deliveries?status=failed`)
        .set('Cookie', cookieA);
      expect(r.status).toBe(200);
      expect(r.body.total).toBe(1);
      expect(r.body.deliveries[0].status).toBe('failed');
    });
  });

  describe('Bearer (API key) auth path resolves to the same org', () => {
    it("a sub created via Bearer ends up in the key's org", async () => {
      const k = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookieA)
        .send({ name: 'test' });
      expect(k.status).toBe(201);
      const rawKey = k.body.key;

      const create = await request(app)
        .post('/subscribe')
        .set('Authorization', `Bearer ${rawKey}`)
        .send(validBody);
      expect(create.status).toBe(201);

      const row = await pool.query(
        'SELECT organization_id FROM subscriptions WHERE subscription_id = $1',
        [create.body.subscriptionId]
      );
      expect(row.rows[0].organization_id).toBe(orgA);

      // B's cookie can't see it
      const listB = await request(app).get('/subscriptions').set('Cookie', cookieB);
      expect(listB.body).toEqual([]);
    });
  });
});
