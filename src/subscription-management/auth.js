/**
 * Auth + multi-tenancy module.
 *
 * Exports:
 *   - mountAuthRoutes(app, deps): registers /auth/*, /organizations/*, /api-keys/*
 *   - requireAuth: Express middleware that resolves req.auth from cookie or API key
 *   - requireRole(role): middleware factory that requires a specific membership role
 *
 * req.auth shape after requireAuth:
 *   { userId: string|null, organizationId: string, via: 'cookie'|'api_key' }
 *   userId is null for API-key-authenticated requests.
 */

const crypto = require('crypto');
const { promisify } = require('util');
const jwt = require('jsonwebtoken');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
const COOKIE_NAME = 'anyhook_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('JWT_SECRET must be set to a value at least 32 characters long');
  }
  return secret;
}

// --- Password hashing (scrypt — Node built-in, no native deps) ---

async function hashPassword(plain) {
  if (!plain || typeof plain !== 'string' || plain.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(plain, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  if (!plain || !stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = await scrypt(plain, salt, expected.length);
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

// --- JWT helpers ---

function signSession(userId, organizationId) {
  return jwt.sign({ sub: userId, org: organizationId }, getJwtSecret(), {
    expiresIn: '7d',
    issuer: 'anyhook',
  });
}

function verifySession(token) {
  try {
    return jwt.verify(token, getJwtSecret(), { issuer: 'anyhook' });
  } catch {
    return null;
  }
}

function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

// --- API key helpers ---

function generateApiKey() {
  // ak_ prefix so users can recognize the value at a glance and grep for it.
  const raw = `ak_${crypto.randomBytes(32).toString('base64url')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const prefix = raw.slice(0, 11); // "ak_" + 8 chars
  return { raw, hash, prefix };
}

function hashApiKey(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// --- Slug helpers ---

function slugify(name) {
  return (
    String(name || '')
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'org'
  );
}

// --- Auth middleware ---

function makeRequireAuth({ pool }) {
  return async function requireAuth(req, res, next) {
    // 1. Bearer API key
    const authHeader = req.headers.authorization || '';
    const bearerMatch = /^Bearer\s+(\S+)$/i.exec(authHeader);
    if (bearerMatch) {
      const raw = bearerMatch[1];
      const hash = hashApiKey(raw);
      try {
        const result = await pool.query(
          `SELECT id, organization_id, expires_at, revoked_at
                     FROM api_keys WHERE key_hash = $1`,
          [hash]
        );
        if (result.rowCount === 0) {
          return res.status(401).json({ error: 'Invalid API key' });
        }
        const row = result.rows[0];
        if (row.revoked_at) {
          return res.status(401).json({ error: 'API key revoked' });
        }
        if (row.expires_at && new Date(row.expires_at) < new Date()) {
          return res.status(401).json({ error: 'API key expired' });
        }
        // Best-effort last_used_at update — fire and forget
        pool
          .query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [row.id])
          .catch(err => console.error('Failed to update api_keys.last_used_at', err.message));

        req.auth = {
          userId: null,
          organizationId: row.organization_id,
          via: 'api_key',
          apiKeyId: row.id,
        };
        return next();
      } catch (err) {
        console.error('API key lookup failed:', err);
        return res.status(500).json({ error: 'Auth failed' });
      }
    }

    // 2. Session cookie
    const cookieToken = req.cookies && req.cookies[COOKIE_NAME];
    if (cookieToken) {
      const claims = verifySession(cookieToken);
      if (!claims) {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }
      // Verify the membership still exists (user could have been removed
      // from the org since the cookie was issued)
      try {
        const result = await pool.query(
          `SELECT role FROM memberships
                     WHERE user_id = $1 AND organization_id = $2`,
          [claims.sub, claims.org]
        );
        if (result.rowCount === 0) {
          return res.status(403).json({ error: 'No active membership in this organization' });
        }
        req.auth = {
          userId: claims.sub,
          organizationId: claims.org,
          role: result.rows[0].role,
          via: 'cookie',
        };
        return next();
      } catch (err) {
        console.error('Membership lookup failed:', err);
        return res.status(500).json({ error: 'Auth failed' });
      }
    }

    return res.status(401).json({ error: 'Authentication required' });
  };
}

function requireRole(...allowedRoles) {
  return function (req, res, next) {
    if (!req.auth) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    // API keys are treated as 'admin' for write operations within their org.
    // Membership-based requests carry an explicit role.
    const effectiveRole = req.auth.role || (req.auth.via === 'api_key' ? 'admin' : null);
    if (!effectiveRole || !allowedRoles.includes(effectiveRole)) {
      return res.status(403).json({ error: `Requires role: ${allowedRoles.join(' or ')}` });
    }
    next();
  };
}

// --- Route mounting ---

function mountAuthRoutes(app, { pool }) {
  const requireAuth = makeRequireAuth({ pool });

  // POST /auth/register — create user; if no orgName given, create a default
  // org for them. Either way, the user becomes 'owner' of the org they end up in.
  app.post('/auth/register', async (req, res) => {
    const { email, password, name, organization_name: orgName } = req.body || {};

    if (!email || typeof email !== 'string' || !/^.+@.+\..+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const existing = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [
        email,
      ]);
      if (existing.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Email already registered' });
      }

      const passwordHash = await hashPassword(password);
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, name)
                 VALUES ($1, $2, $3)
                 RETURNING id, email, name, created_at`,
        [email.toLowerCase(), passwordHash, name || null]
      );
      const user = userResult.rows[0];

      const orgDisplayName = orgName || `${name || email.split('@')[0]}'s Organization`;
      const baseSlug = slugify(orgDisplayName);
      // Find a unique slug
      let slug = baseSlug;
      let attempt = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const taken = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
        if (taken.rowCount === 0) break;
        attempt += 1;
        slug = `${baseSlug}-${attempt}`;
        if (attempt > 100) {
          throw new Error('Could not generate a unique organization slug');
        }
      }

      const orgResult = await client.query(
        `INSERT INTO organizations (name, slug)
                 VALUES ($1, $2)
                 RETURNING id, name, slug, created_at`,
        [orgDisplayName, slug]
      );
      const org = orgResult.rows[0];

      await client.query(
        `INSERT INTO memberships (user_id, organization_id, role)
                 VALUES ($1, $2, 'owner')`,
        [user.id, org.id]
      );

      await client.query('COMMIT');

      const token = signSession(user.id, org.id);
      setSessionCookie(res, token);
      res.status(201).json({
        user: { id: user.id, email: user.email, name: user.name },
        organization: { id: org.id, name: org.name, slug: org.slug, role: 'owner' },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error('Registration failed:', err);
      res.status(500).json({ error: 'Registration failed' });
    } finally {
      client.release();
    }
  });

  // POST /auth/login — returns user + active org; session cookie set.
  // If user belongs to multiple orgs, defaults to the first; client can
  // POST /auth/switch-org afterwards.
  app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
      const userResult = await pool.query(
        'SELECT id, email, name, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
        [email]
      );
      // Constant-time-ish: always do a hash check even if user not found,
      // so timing doesn't leak account existence.
      const dummyHash = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);
      const stored = userResult.rowCount > 0 ? userResult.rows[0].password_hash : dummyHash;
      const ok = await verifyPassword(password, stored);
      if (userResult.rowCount === 0 || !ok) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = userResult.rows[0];
      const orgs = await pool.query(
        `SELECT o.id, o.name, o.slug, m.role
                 FROM memberships m
                 JOIN organizations o ON o.id = m.organization_id
                 WHERE m.user_id = $1
                 ORDER BY m.created_at ASC`,
        [user.id]
      );
      if (orgs.rowCount === 0) {
        return res.status(403).json({ error: 'User has no organization memberships' });
      }
      const activeOrg = orgs.rows[0];

      const token = signSession(user.id, activeOrg.id);
      setSessionCookie(res, token);
      res.status(200).json({
        user: { id: user.id, email: user.email, name: user.name },
        organization: activeOrg,
        organizations: orgs.rows,
      });
    } catch (err) {
      console.error('Login failed:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  app.post('/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.status(200).json({ message: 'Logged out' });
  });

  // GET /auth/me — full session context for the dashboard
  app.get('/auth/me', requireAuth, async (req, res) => {
    if (req.auth.via === 'api_key') {
      // No user context for API-key calls; return org info only
      const orgResult = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [
        req.auth.organizationId,
      ]);
      return res.status(200).json({
        user: null,
        organization: orgResult.rows[0],
        organizations: orgResult.rows,
        via: 'api_key',
      });
    }

    try {
      const [userResult, orgsResult] = await Promise.all([
        pool.query('SELECT id, email, name FROM users WHERE id = $1', [req.auth.userId]),
        pool.query(
          `SELECT o.id, o.name, o.slug, m.role
                     FROM memberships m
                     JOIN organizations o ON o.id = m.organization_id
                     WHERE m.user_id = $1
                     ORDER BY m.created_at ASC`,
          [req.auth.userId]
        ),
      ]);
      const activeOrg = orgsResult.rows.find(o => o.id === req.auth.organizationId);
      res.status(200).json({
        user: userResult.rows[0],
        organization: activeOrg,
        organizations: orgsResult.rows,
        via: 'cookie',
      });
    } catch (err) {
      console.error('/auth/me failed:', err);
      res.status(500).json({ error: 'Failed to load session' });
    }
  });

  // POST /auth/switch-org — change active organization (must be a member)
  app.post('/auth/switch-org', requireAuth, async (req, res) => {
    if (req.auth.via !== 'cookie') {
      return res.status(400).json({ error: 'API key sessions cannot switch org' });
    }
    const { organization_id: targetOrgId } = req.body || {};
    if (!targetOrgId) {
      return res.status(400).json({ error: 'organization_id is required' });
    }
    try {
      const result = await pool.query(
        'SELECT 1 FROM memberships WHERE user_id = $1 AND organization_id = $2',
        [req.auth.userId, targetOrgId]
      );
      if (result.rowCount === 0) {
        return res.status(403).json({ error: 'Not a member of that organization' });
      }
      const token = signSession(req.auth.userId, targetOrgId);
      setSessionCookie(res, token);
      res.status(200).json({ organization_id: targetOrgId });
    } catch (err) {
      console.error('switch-org failed:', err);
      res.status(500).json({ error: 'Switch organization failed' });
    }
  });

  // POST /organizations — create a new org for the current user (becomes owner)
  app.post(
    '/organizations',
    requireAuth,
    requireRole('owner', 'admin', 'member'),
    async (req, res) => {
      if (req.auth.via !== 'cookie') {
        return res.status(403).json({ error: 'Only user sessions can create organizations' });
      }
      const { name } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ error: 'name is required' });
      }
      const baseSlug = slugify(name);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        let slug = baseSlug;
        let attempt = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const taken = await client.query('SELECT 1 FROM organizations WHERE slug = $1', [slug]);
          if (taken.rowCount === 0) break;
          attempt += 1;
          slug = `${baseSlug}-${attempt}`;
          if (attempt > 100) throw new Error('Could not generate slug');
        }
        const orgResult = await client.query(
          `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *`,
          [name.trim(), slug]
        );
        await client.query(
          `INSERT INTO memberships (user_id, organization_id, role) VALUES ($1, $2, 'owner')`,
          [req.auth.userId, orgResult.rows[0].id]
        );
        await client.query('COMMIT');
        res.status(201).json({ ...orgResult.rows[0], role: 'owner' });
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('Create organization failed:', err);
        res.status(500).json({ error: 'Create organization failed' });
      } finally {
        client.release();
      }
    }
  );

  // GET /organizations/current/members — list members of active org
  app.get('/organizations/current/members', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT u.id, u.email, u.name, m.role, m.created_at
                 FROM memberships m
                 JOIN users u ON u.id = m.user_id
                 WHERE m.organization_id = $1
                 ORDER BY m.created_at ASC`,
        [req.auth.organizationId]
      );
      res.status(200).json(result.rows);
    } catch (err) {
      console.error('List members failed:', err);
      res.status(500).json({ error: 'List members failed' });
    }
  });

  // POST /organizations/current/members — add an existing user by email.
  // Requires owner/admin role. (Real product needs an invite flow with
  // email tokens; this is the minimum viable version.)
  app.post(
    '/organizations/current/members',
    requireAuth,
    requireRole('owner', 'admin'),
    async (req, res) => {
      const { email, role } = req.body || {};
      if (!email) return res.status(400).json({ error: 'email is required' });
      const targetRole = role || 'member';
      if (!['owner', 'admin', 'member'].includes(targetRole)) {
        return res.status(400).json({ error: 'role must be owner, admin, or member' });
      }
      try {
        const userResult = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [
          email,
        ]);
        if (userResult.rowCount === 0) {
          return res
            .status(404)
            .json({ error: 'No user with that email; they must register first' });
        }
        await pool.query(
          `INSERT INTO memberships (user_id, organization_id, role)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role`,
          [userResult.rows[0].id, req.auth.organizationId, targetRole]
        );
        res.status(201).json({ user_id: userResult.rows[0].id, role: targetRole });
      } catch (err) {
        console.error('Add member failed:', err);
        res.status(500).json({ error: 'Add member failed' });
      }
    }
  );

  // DELETE /organizations/current/members/:userId — remove a member
  app.delete(
    '/organizations/current/members/:userId',
    requireAuth,
    requireRole('owner', 'admin'),
    async (req, res) => {
      const { userId } = req.params;
      if (userId === req.auth.userId) {
        return res.status(400).json({ error: 'Cannot remove yourself; transfer ownership first' });
      }
      try {
        const result = await pool.query(
          `DELETE FROM memberships
                 WHERE user_id = $1 AND organization_id = $2`,
          [userId, req.auth.organizationId]
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: 'Member not found' });
        }
        res.status(200).json({ message: 'Member removed' });
      } catch (err) {
        console.error('Remove member failed:', err);
        res.status(500).json({ error: 'Remove member failed' });
      }
    }
  );

  // GET /organizations/current/api-keys — list keys for the active org
  app.get('/organizations/current/api-keys', requireAuth, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, name, key_prefix, last_used_at, expires_at, revoked_at, created_at
                 FROM api_keys
                 WHERE organization_id = $1
                 ORDER BY created_at DESC`,
        [req.auth.organizationId]
      );
      res.status(200).json(result.rows);
    } catch (err) {
      console.error('List API keys failed:', err);
      res.status(500).json({ error: 'List API keys failed' });
    }
  });

  // POST /organizations/current/api-keys — create a new API key
  app.post(
    '/organizations/current/api-keys',
    requireAuth,
    requireRole('owner', 'admin'),
    async (req, res) => {
      const { name, expires_in_days: expiresInDays } = req.body || {};
      if (!name || typeof name !== 'string') {
        return res.status(400).json({ error: 'name is required' });
      }
      const { raw, hash, prefix } = generateApiKey();
      let expiresAt = null;
      if (expiresInDays && Number.isFinite(Number(expiresInDays))) {
        expiresAt = new Date(Date.now() + Number(expiresInDays) * 24 * 60 * 60 * 1000);
      }
      try {
        const result = await pool.query(
          `INSERT INTO api_keys (organization_id, name, key_prefix, key_hash,
                                       created_by_user_id, expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING id, name, key_prefix, expires_at, created_at`,
          [req.auth.organizationId, name, prefix, hash, req.auth.userId, expiresAt]
        );
        // raw value is shown ONLY here, never queryable later
        res.status(201).json({
          ...result.rows[0],
          key: raw,
          message: 'Save the key value — it is shown only once.',
        });
      } catch (err) {
        console.error('Create API key failed:', err);
        res.status(500).json({ error: 'Create API key failed' });
      }
    }
  );

  // DELETE /organizations/current/api-keys/:id — revoke (soft delete)
  app.delete(
    '/organizations/current/api-keys/:id',
    requireAuth,
    requireRole('owner', 'admin'),
    async (req, res) => {
      try {
        const result = await pool.query(
          `UPDATE api_keys SET revoked_at = NOW()
                 WHERE id = $1 AND organization_id = $2 AND revoked_at IS NULL
                 RETURNING id`,
          [req.params.id, req.auth.organizationId]
        );
        if (result.rowCount === 0) {
          return res.status(404).json({ error: 'API key not found or already revoked' });
        }
        res.status(200).json({ message: 'API key revoked' });
      } catch (err) {
        console.error('Revoke API key failed:', err);
        res.status(500).json({ error: 'Revoke API key failed' });
      }
    }
  );

  return { requireAuth, requireRole };
}

module.exports = {
  mountAuthRoutes,
  makeRequireAuth,
  requireRole,
  hashApiKey,
  COOKIE_NAME,
};
