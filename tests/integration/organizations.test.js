const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
} = require('./setup');

describeIfPg('organizations + members + api keys (integration)', () => {
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
      .send({ email: 'owner@example.com', password: 'password123', organization_name: 'Owner Co' });
    cookie = getSessionCookie(reg.headers['set-cookie']);
  });

  describe('POST /organizations', () => {
    it('creates a new org with the caller as owner', async () => {
      const res = await request(app)
        .post('/organizations')
        .set('Cookie', cookie)
        .send({ name: 'Side Project' });
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Side Project', role: 'owner' });
      expect(res.body.id).toBeDefined();
    });

    it('rejects empty name', async () => {
      const res = await request(app)
        .post('/organizations')
        .set('Cookie', cookie)
        .send({ name: '' });
      expect(res.status).toBe(400);
    });

    it('rejects unauthenticated', async () => {
      const res = await request(app).post('/organizations').send({ name: 'x' });
      expect(res.status).toBe(401);
    });

    it('appears in /auth/me organizations list', async () => {
      await request(app).post('/organizations').set('Cookie', cookie).send({ name: 'Second Org' });
      const me = await request(app).get('/auth/me').set('Cookie', cookie);
      expect(me.status).toBe(200);
      expect(me.body.organizations.length).toBe(2);
      const names = me.body.organizations.map(o => o.name).sort();
      expect(names).toEqual(['Owner Co', 'Second Org']);
    });
  });

  describe('GET /organizations/current/members', () => {
    it("returns only the current org's members", async () => {
      const res = await request(app).get('/organizations/current/members').set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].email).toBe('owner@example.com');
      expect(res.body[0].role).toBe('owner');
    });
  });

  describe('POST /organizations/current/members', () => {
    beforeEach(async () => {
      // Pre-register a second user so they can be added to the org
      await request(app)
        .post('/auth/register')
        .send({ email: 'invitee@example.com', password: 'password123' });
    });

    it('adds an existing user to the org', async () => {
      const res = await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('member');

      const list = await request(app).get('/organizations/current/members').set('Cookie', cookie);
      expect(list.body.length).toBe(2);
      expect(list.body.find(m => m.email === 'invitee@example.com').role).toBe('member');
    });

    it('returns 404 when the email is not a registered user', async () => {
      const res = await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'unknown@example.com', role: 'member' });
      expect(res.status).toBe(404);
    });

    it('rejects invalid role values', async () => {
      const res = await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'invitee@example.com', role: 'evil-overlord' });
      expect(res.status).toBe(400);
    });
  });

  describe('API keys', () => {
    it('creates a key, lists it, then revokes it', async () => {
      const create = await request(app)
        .post('/organizations/current/api-keys')
        .set('Cookie', cookie)
        .send({ name: 'CI Robot' });
      expect(create.status).toBe(201);
      expect(create.body.key).toMatch(/^ak_/);
      expect(create.body.name).toBe('CI Robot');
      const keyId = create.body.id;
      const rawKey = create.body.key;

      const list = await request(app).get('/organizations/current/api-keys').set('Cookie', cookie);
      expect(list.status).toBe(200);
      expect(list.body.length).toBe(1);
      // Raw key is NOT returned by list
      expect(list.body[0].key).toBeUndefined();
      expect(list.body[0].key_prefix).toBe(rawKey.slice(0, 11));
      expect(list.body[0].revoked_at).toBeNull();

      // The raw key authenticates as Bearer
      const auth = await request(app)
        .get('/subscriptions')
        .set('Authorization', `Bearer ${rawKey}`);
      expect(auth.status).toBe(200);

      // Revoke
      const revoke = await request(app)
        .delete(`/organizations/current/api-keys/${keyId}`)
        .set('Cookie', cookie);
      expect(revoke.status).toBe(200);

      // After revoke, the same key returns 401
      const denied = await request(app)
        .get('/subscriptions')
        .set('Authorization', `Bearer ${rawKey}`);
      expect(denied.status).toBe(401);
    });

    it('rejects invalid bearer format', async () => {
      const res = await request(app)
        .get('/subscriptions')
        .set('Authorization', 'Bearer not-a-real-key');
      expect(res.status).toBe(401);
    });
  });
});
