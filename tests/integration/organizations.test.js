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

  describe('owner protections (admin overthrow defense)', () => {
    let adminCookie;

    beforeEach(async () => {
      // Pre-register three users we can promote to various roles in
      // Owner Co. They each start as owner of their own org.
      const reg = email =>
        request(app).post('/auth/register').send({ email, password: 'password123' });

      const adminReg = await reg('admin@example.com');
      adminCookie = getSessionCookie(adminReg.headers['set-cookie']);
      await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie) // existing owner
        .send({ email: 'admin@example.com', role: 'admin' });

      await reg('owner2@example.com');
      // owner2 added as owner — gives us a multi-owner org
      await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'owner2@example.com', role: 'owner' });

      await reg('plain@example.com');
      await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'plain@example.com', role: 'member' });
    });

    async function switchTo(targetCookie, targetOrgName) {
      // Find target org id by listing this user's orgs via /auth/me, then
      // switch their session to it.
      const me = await request(app).get('/auth/me').set('Cookie', targetCookie);
      const target = me.body.organizations.find(o => o.name === targetOrgName);
      const swap = await request(app)
        .post('/auth/switch-org')
        .set('Cookie', targetCookie)
        .send({ organization_id: target.id });
      return getSessionCookie(swap.headers['set-cookie']);
    }

    it('admin CANNOT demote an owner via add-member', async () => {
      const adminInOwnerCo = await switchTo(adminCookie, 'Owner Co');
      const res = await request(app)
        .post('/organizations/current/members')
        .set('Cookie', adminInOwnerCo)
        .send({ email: 'owner2@example.com', role: 'member' });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/Only owners/);

      // owner2's role unchanged
      const list = await request(app).get('/organizations/current/members').set('Cookie', cookie);
      const owner2 = list.body.find(m => m.email === 'owner2@example.com');
      expect(owner2.role).toBe('owner');
    });

    it('owner CAN demote another owner', async () => {
      const res = await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'owner2@example.com', role: 'admin' });
      expect(res.status).toBe(201);
      expect(res.body.role).toBe('admin');
    });

    it('owner CANNOT demote the LAST owner', async () => {
      // First demote owner2 so the original owner is the only one left
      await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'owner2@example.com', role: 'member' });

      // Now try to demote the original owner (self) — also blocked because
      // they're the last owner. (The endpoint allows self-edit; the
      // last-owner guard catches it regardless of who's calling.)
      const res = await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'owner@example.com', role: 'admin' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/last owner/i);
    });

    it('admin CANNOT remove an owner via DELETE', async () => {
      const adminInOwnerCo = await switchTo(adminCookie, 'Owner Co');
      // Find owner2's userId
      const list = await request(app).get('/organizations/current/members').set('Cookie', cookie);
      const owner2 = list.body.find(m => m.email === 'owner2@example.com');

      const res = await request(app)
        .delete(`/organizations/current/members/${owner2.id}`)
        .set('Cookie', adminInOwnerCo);
      expect(res.status).toBe(403);

      // Still a member
      const list2 = await request(app).get('/organizations/current/members').set('Cookie', cookie);
      expect(list2.body.find(m => m.email === 'owner2@example.com')).toBeDefined();
    });

    it('owner CAN remove a non-last owner', async () => {
      // Owner Co has 2 owners (original + owner2). The original owner
      // removes owner2 — allowed because there's still one owner left.
      const list = await request(app).get('/organizations/current/members').set('Cookie', cookie);
      const owner2 = list.body.find(m => m.email === 'owner2@example.com');
      const res = await request(app)
        .delete(`/organizations/current/members/${owner2.id}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      const after = await request(app).get('/organizations/current/members').set('Cookie', cookie);
      const owners = after.body.filter(m => m.role === 'owner');
      expect(owners.length).toBe(1);
    });

    // Note: the "last owner DELETE" branch only fires through a
    // concurrent race (one owner deleting another while the latter is
    // simultaneously demoted). In serial flow the self-removal guard
    // catches the only would-be path. The advisory lock on the
    // organization_id makes both racers serialize, and the second one
    // observes the count == 1 → blocked. This is exercised at the SQL
    // level by the lock semantics; a deterministic JS test would need a
    // sync barrier mid-transaction.
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
