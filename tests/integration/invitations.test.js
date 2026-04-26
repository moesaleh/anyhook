const request = require('supertest');
const {
  setupTestApp,
  teardownTestApp,
  cleanDatabase,
  describeIfPg,
  getSessionCookie,
} = require('./setup');

describeIfPg('invitations (integration)', () => {
  let app;
  let pool;
  let cookie;
  let orgId;

  beforeAll(async () => {
    ({ app, pool } = await setupTestApp());
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
    orgId = reg.body.organization.id;
  });

  describe('POST /organizations/current/invitations', () => {
    it('creates an invitation and returns the raw token once', async () => {
      const res = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      expect(res.status).toBe(201);
      expect(res.body.token).toMatch(/^inv_[A-Za-z0-9_-]+$/);
      expect(res.body.email).toBe('invitee@example.com');
      expect(res.body.role).toBe('member');
      expect(res.body.organization_id).toBe(orgId);
    });

    it('lowercases the email', async () => {
      const res = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'BIG@EXAMPLE.COM' });
      expect(res.status).toBe(201);
      expect(res.body.email).toBe('big@example.com');
    });

    it('rejects malformed email', async () => {
      const res = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'not-an-email' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid role', async () => {
      const res = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'x@example.com', role: 'evil-overlord' });
      expect(res.status).toBe(400);
    });

    it('requires owner/admin role to create', async () => {
      // Add a member-role user, log in as them, expect 403
      const memberReg = await request(app)
        .post('/auth/register')
        .send({ email: 'm@example.com', password: 'password123' });
      // Register puts you in your OWN org as owner. To get a member role
      // in someone else's org, the owner adds them.
      await request(app)
        .post('/organizations/current/members')
        .set('Cookie', cookie)
        .send({ email: 'm@example.com', role: 'member' });
      // Switch m's session to Owner Co
      const memberCookie = getSessionCookie(memberReg.headers['set-cookie']);
      const switchRes = await request(app)
        .post('/auth/switch-org')
        .set('Cookie', memberCookie)
        .send({ organization_id: orgId });
      const switchedCookie = getSessionCookie(switchRes.headers['set-cookie']);

      const inv = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', switchedCookie)
        .send({ email: 'x@example.com' });
      expect(inv.status).toBe(403);
    });
  });

  describe('GET /organizations/current/invitations', () => {
    it('lists pending invites without exposing tokens', async () => {
      await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'a@example.com' });
      await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'b@example.com', role: 'admin' });

      const res = await request(app)
        .get('/organizations/current/invitations')
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(2);
      for (const row of res.body) {
        expect(row.token).toBeUndefined();
        expect(row.token_hash).toBeUndefined();
      }
    });

    it("does not leak another org's invites", async () => {
      await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'leak@example.com' });

      const reg2 = await request(app).post('/auth/register').send({
        email: 'other@example.com',
        password: 'password123',
        organization_name: 'Other Co',
      });
      const cookie2 = getSessionCookie(reg2.headers['set-cookie']);

      const list = await request(app)
        .get('/organizations/current/invitations')
        .set('Cookie', cookie2);
      expect(list.status).toBe(200);
      expect(list.body).toEqual([]);
    });
  });

  describe('DELETE /organizations/current/invitations/:id', () => {
    it('revokes a pending invite', async () => {
      const create = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'tobedeleted@example.com' });
      const id = create.body.id;

      const revoke = await request(app)
        .delete(`/organizations/current/invitations/${id}`)
        .set('Cookie', cookie);
      expect(revoke.status).toBe(200);

      // After revoke the token can't be looked up
      const lookup = await request(app).get(`/invitations/${create.body.token}`);
      expect(lookup.status).toBe(410);
    });

    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .delete('/organizations/current/invitations/00000000-0000-0000-0000-000000000000')
        .set('Cookie', cookie);
      expect(res.status).toBe(404);
    });
  });

  describe('GET /invitations/:token (anonymous)', () => {
    let token;
    beforeEach(async () => {
      const r = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'pending@example.com', role: 'admin' });
      token = r.body.token;
    });

    it('returns email + role + org name for a valid token', async () => {
      const res = await request(app).get(`/invitations/${token}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        email: 'pending@example.com',
        role: 'admin',
        organization_name: 'Owner Co',
      });
      expect(res.body.token_hash).toBeUndefined();
    });

    it('returns 404 for an unknown token', async () => {
      const res = await request(app).get('/invitations/inv_fake-token');
      expect(res.status).toBe(404);
    });

    it('returns 410 for a revoked invitation', async () => {
      const created = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'gone@example.com' });
      await request(app)
        .delete(`/organizations/current/invitations/${created.body.id}`)
        .set('Cookie', cookie);
      const res = await request(app).get(`/invitations/${created.body.token}`);
      expect(res.status).toBe(410);
    });

    it('returns 410 for an expired invitation', async () => {
      const created = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'old@example.com' });
      // Backdate the expiry
      await pool.query(
        `UPDATE invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`,
        [created.body.id]
      );
      const res = await request(app).get(`/invitations/${created.body.token}`);
      expect(res.status).toBe(410);
    });
  });

  describe('POST /auth/accept-invite', () => {
    let token;
    beforeEach(async () => {
      const r = await request(app)
        .post('/organizations/current/invitations')
        .set('Cookie', cookie)
        .send({ email: 'newbie@example.com', role: 'member' });
      token = r.body.token;
    });

    it('creates the user, attaches to org, sets cookie, marks accepted', async () => {
      const res = await request(app)
        .post('/auth/accept-invite')
        .send({ token, password: 'password123', name: 'Newbie' });
      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe('newbie@example.com');
      expect(res.body.organization.role).toBe('member');
      expect(res.body.organization.id).toBe(orgId);
      expect(res.headers['set-cookie'].some(c => c.startsWith('anyhook_session='))).toBe(true);

      // Membership exists
      const memberships = await pool.query(
        'SELECT role FROM memberships WHERE organization_id = $1',
        [orgId]
      );
      expect(memberships.rowCount).toBe(2); // owner + newbie

      // Invitation now accepted; second use rejected
      const second = await request(app)
        .post('/auth/accept-invite')
        .send({ token, password: 'password123' });
      expect(second.status).toBe(410);
    });

    it('rejects when a user with the invitation email already exists', async () => {
      // Pre-register a user with the same email the invite targets
      await request(app)
        .post('/auth/register')
        .send({ email: 'newbie@example.com', password: 'password123' });

      const res = await request(app)
        .post('/auth/accept-invite')
        .send({ token, password: 'password123' });
      expect(res.status).toBe(409);
    });

    it('rejects short password', async () => {
      const res = await request(app).post('/auth/accept-invite').send({ token, password: 'short' });
      expect(res.status).toBe(400);
    });

    it('rejects unknown / malformed token', async () => {
      const res = await request(app)
        .post('/auth/accept-invite')
        .send({ token: 'inv_not-a-real-token', password: 'password123' });
      expect(res.status).toBe(404);
    });
  });
});
