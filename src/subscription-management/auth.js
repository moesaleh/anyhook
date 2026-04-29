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

const { createLogger } = require('../lib/logger');
const { hashPassword, verifyPassword } = require('../lib/passwords');
const {
  signSession,
  verifySession,
  signEphemeralToken,
  verifyEphemeralToken,
} = require('../lib/jwt');
const { generateApiKey, hashApiKey } = require('../lib/api-keys');
const {
  generateTotpSecret,
  verifyTotp,
  otpauthUrl,
  generateBackupCodes,
  hashBackupCode,
} = require('../lib/totp');
const {
  generateInvitationToken,
  hashInvitationToken,
  DEFAULT_EXPIRY_DAYS: INVITE_EXPIRY_DAYS,
} = require('../lib/invitations');
const {
  generateResetToken,
  hashResetToken,
  DEFAULT_EXPIRY_HOURS: RESET_EXPIRY_HOURS,
} = require('../lib/password-reset');
const { slugify } = require('../lib/slug');

const log = createLogger('auth');

const COOKIE_NAME = 'anyhook_session';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
          .catch(err => log.error('Failed to update api_keys.last_used_at', err.message));

        req.auth = {
          userId: null,
          organizationId: row.organization_id,
          via: 'api_key',
          apiKeyId: row.id,
        };
        return next();
      } catch (err) {
        log.error('API key lookup failed:', err);
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
        log.error('Membership lookup failed:', err);
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

// noopMiddleware is used when no rateLimit is provided (e.g. in tests).
// Keeps every route definition shape identical: requireAuth, rateLimit, ...
function noopMiddleware(req, res, next) {
  next();
}

function mountAuthRoutes(
  app,
  { pool, rateLimit, authRateLimit, apiKeyQuota, quotaLimits, emailTransport }
) {
  const requireAuth = makeRequireAuth({ pool });
  const rl = rateLimit || noopMiddleware;
  const authRl = authRateLimit || noopMiddleware;
  const apiKeyQuotaMw = apiKeyQuota || noopMiddleware;
  // No-op email when SMTP isn't configured (dev / tests).
  const email = emailTransport || {
    enabled: false,
    from: 'noreply@anyhook.local',
    async send() {
      return { delivered: false, reason: 'no_transport' };
    },
  };
  const baseUrl = (process.env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
  // Limits used by the read-only /quotas endpoint. The middleware-side
  // limits are baked in at construction time; this echoes them so the
  // dashboard can show "X/Y used" without scraping headers from every call.
  const limits = {
    subscriptions: (quotaLimits && quotaLimits.subscriptions) || 100,
    apiKeys: (quotaLimits && quotaLimits.apiKeys) || 10,
  };

  // POST /auth/register — create user; if no orgName given, create a default
  // org for them. Either way, the user becomes 'owner' of the org they end up in.
  // IP-rate-limited to slow bulk-account attacks.
  app.post('/auth/register', authRl, async (req, res) => {
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
      log.error('Registration failed:', err);
      res.status(500).json({ error: 'Registration failed' });
    } finally {
      client.release();
    }
  });

  /**
   * Build the standard "logged in" payload + set the session cookie.
   * Reused by /auth/login (no-2FA path) and /auth/2fa/verify-login.
   */
  async function completeLogin(res, user) {
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
    return res.status(200).json({
      user: { id: user.id, email: user.email, name: user.name },
      organization: activeOrg,
      organizations: orgs.rows,
    });
  }

  // POST /auth/login — returns user + active org; session cookie set.
  // If 2FA is enabled, returns { needs_2fa: true, pending_token } instead
  // and the client must POST /auth/2fa/verify-login to complete.
  // IP-rate-limited to slow credential-stuffing.
  app.post('/auth/login', authRl, async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    try {
      const userResult = await pool.query(
        `SELECT id, email, name, password_hash, totp_secret, totp_enabled_at
         FROM users WHERE LOWER(email) = LOWER($1)`,
        [email]
      );
      const dummyHash = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);
      const stored = userResult.rowCount > 0 ? userResult.rows[0].password_hash : dummyHash;
      const ok = await verifyPassword(password, stored);
      if (userResult.rowCount === 0 || !ok) {
        return res.status(401).json({ error: 'Invalid email or password' });
      }

      const user = userResult.rows[0];

      if (user.totp_enabled_at) {
        const pendingToken = signEphemeralToken(
          { sub: user.id, purpose: '2fa-pending' },
          { expiresIn: '5m' }
        );
        return res.status(200).json({ needs_2fa: true, pending_token: pendingToken });
      }

      return completeLogin(res, user);
    } catch (err) {
      log.error('Login failed:', err);
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // POST /auth/2fa/verify-login — second step when 2FA is enabled.
  // Body: { pending_token, code }   code = 6-digit TOTP OR xxxx-xxxx backup code.
  app.post('/auth/2fa/verify-login', authRl, async (req, res) => {
    const { pending_token: pendingToken, code } = req.body || {};
    if (!pendingToken || !code) {
      return res.status(400).json({ error: 'pending_token and code are required' });
    }
    const claims = verifyEphemeralToken(pendingToken);
    if (!claims || claims.purpose !== '2fa-pending' || !claims.sub) {
      return res.status(401).json({ error: 'Invalid or expired pending token' });
    }
    try {
      const userResult = await pool.query(
        `SELECT id, email, name, totp_secret, totp_enabled_at
         FROM users WHERE id = $1`,
        [claims.sub]
      );
      if (userResult.rowCount === 0 || !userResult.rows[0].totp_enabled_at) {
        return res.status(400).json({ error: '2FA is not enabled for this user' });
      }
      const user = userResult.rows[0];

      // TOTP attempt (no DB hit, fast path)
      if (typeof code === 'string' && /^\d{6}$/.test(code) && verifyTotp(user.totp_secret, code)) {
        return completeLogin(res, user);
      }

      // Backup code attempt: hash, claim under FOR UPDATE in a tx.
      if (typeof code === 'string' && /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(code)) {
        const codeHash = hashBackupCode(code);
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const r = await client.query(
            `SELECT id FROM backup_codes
             WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
             FOR UPDATE`,
            [user.id, codeHash]
          );
          if (r.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(401).json({ error: 'Invalid 2FA code' });
          }
          await client.query('UPDATE backup_codes SET used_at = NOW() WHERE id = $1', [
            r.rows[0].id,
          ]);
          await client.query('COMMIT');
          return completeLogin(res, user);
        } finally {
          client.release();
        }
      }

      return res.status(401).json({ error: 'Invalid 2FA code' });
    } catch (err) {
      log.error('2FA verify-login failed:', err);
      res.status(500).json({ error: '2FA verification failed' });
    }
  });

  // GET /auth/2fa/status — current 2FA state for the logged-in user.
  app.get('/auth/2fa/status', requireAuth, rl, async (req, res) => {
    if (req.auth.via !== 'cookie') {
      return res.status(403).json({ error: '2FA management is only available via session login' });
    }
    try {
      const r = await pool.query(
        `SELECT
           totp_enabled_at,
           totp_secret IS NOT NULL AS has_pending_secret,
           (SELECT COUNT(*)::int FROM backup_codes
            WHERE user_id = u.id AND used_at IS NULL) AS unused_backup_codes
         FROM users u WHERE u.id = $1`,
        [req.auth.userId]
      );
      const row = r.rows[0] || {};
      res.status(200).json({
        enabled: !!row.totp_enabled_at,
        enrollment_pending: !!row.has_pending_secret && !row.totp_enabled_at,
        unused_backup_codes: row.unused_backup_codes || 0,
      });
    } catch (err) {
      log.error('2FA status failed:', err);
      res.status(500).json({ error: '2FA status failed' });
    }
  });

  // POST /auth/2fa/setup — start enrollment. Generates a secret + returns
  // it (plus otpauth URL for QR rendering). NOT enabled until verify-setup.
  // Refuses if already enabled — disable first to rotate.
  app.post('/auth/2fa/setup', requireAuth, rl, async (req, res) => {
    if (req.auth.via !== 'cookie') {
      return res.status(403).json({ error: '2FA management is only available via session login' });
    }
    try {
      const userResult = await pool.query(
        'SELECT email, totp_enabled_at FROM users WHERE id = $1',
        [req.auth.userId]
      );
      if (userResult.rowCount === 0) return res.status(404).json({ error: 'User not found' });
      if (userResult.rows[0].totp_enabled_at) {
        return res.status(409).json({
          error: '2FA is already enabled — disable it first to enroll a new device',
        });
      }
      const secret = generateTotpSecret();
      await pool.query('UPDATE users SET totp_secret = $1 WHERE id = $2', [
        secret,
        req.auth.userId,
      ]);
      res.status(200).json({
        secret,
        otpauth_url: otpauthUrl({
          secret,
          label: userResult.rows[0].email,
          issuer: process.env.TOTP_ISSUER || 'AnyHook',
        }),
      });
    } catch (err) {
      log.error('2FA setup failed:', err);
      res.status(500).json({ error: '2FA setup failed' });
    }
  });

  // POST /auth/2fa/verify-setup — finalize enrollment. Verifies a code
  // against the pending secret, marks 2FA enabled, generates 10 backup
  // codes (raw values returned ONCE).
  app.post('/auth/2fa/verify-setup', requireAuth, rl, async (req, res) => {
    if (req.auth.via !== 'cookie') {
      return res.status(403).json({ error: '2FA management is only available via session login' });
    }
    const { code } = req.body || {};
    if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'A 6-digit code is required' });
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const userResult = await client.query(
        'SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1 FOR UPDATE',
        [req.auth.userId]
      );
      if (userResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'User not found' });
      }
      const row = userResult.rows[0];
      if (row.totp_enabled_at) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: '2FA is already enabled' });
      }
      if (!row.totp_secret) {
        await client.query('ROLLBACK');
        return res
          .status(400)
          .json({ error: 'No pending enrollment — call /auth/2fa/setup first' });
      }
      if (!verifyTotp(row.totp_secret, code)) {
        await client.query('ROLLBACK');
        return res.status(401).json({ error: 'Invalid 2FA code' });
      }
      await client.query(
        'UPDATE users SET totp_enabled_at = NOW(), updated_at = NOW() WHERE id = $1',
        [req.auth.userId]
      );
      await client.query('DELETE FROM backup_codes WHERE user_id = $1', [req.auth.userId]);
      const codes = generateBackupCodes(10);
      const valuesSql = codes.map((_c, i) => `($1, $${i + 2})`).join(', ');
      await client.query(`INSERT INTO backup_codes (user_id, code_hash) VALUES ${valuesSql}`, [
        req.auth.userId,
        ...codes.map(c => c.hash),
      ]);
      await client.query('COMMIT');
      res.status(200).json({
        enabled: true,
        backup_codes: codes.map(c => c.raw),
        message: 'Save these backup codes — they are shown only once.',
      });
    } catch (err) {
      await client.query('ROLLBACK');
      log.error('2FA verify-setup failed:', err);
      res.status(500).json({ error: '2FA verify-setup failed' });
    } finally {
      client.release();
    }
  });

  // POST /auth/2fa/disable — turn 2FA off. Requires current_password
  // AND a current TOTP code (or backup code).
  app.post('/auth/2fa/disable', requireAuth, rl, async (req, res) => {
    if (req.auth.via !== 'cookie') {
      return res.status(403).json({ error: '2FA management is only available via session login' });
    }
    const { current_password: currentPassword, code } = req.body || {};
    if (!currentPassword || !code) {
      return res.status(400).json({ error: 'current_password and code are required' });
    }
    try {
      const userResult = await pool.query(
        'SELECT password_hash, totp_secret, totp_enabled_at FROM users WHERE id = $1',
        [req.auth.userId]
      );
      if (userResult.rowCount === 0) return res.status(404).json({ error: 'User not found' });
      const user = userResult.rows[0];
      if (!user.totp_enabled_at) return res.status(400).json({ error: '2FA is not enabled' });

      if (!(await verifyPassword(currentPassword, user.password_hash))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }

      let codeOk = false;
      if (typeof code === 'string' && /^\d{6}$/.test(code)) {
        codeOk = verifyTotp(user.totp_secret, code);
      } else if (typeof code === 'string' && /^[0-9a-f]{4}-[0-9a-f]{4}$/.test(code)) {
        const r = await pool.query(
          `SELECT id FROM backup_codes
           WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
          [req.auth.userId, hashBackupCode(code)]
        );
        codeOk = r.rowCount > 0;
        if (codeOk) {
          await pool.query('UPDATE backup_codes SET used_at = NOW() WHERE id = $1', [r.rows[0].id]);
        }
      }
      if (!codeOk) return res.status(401).json({ error: 'Invalid 2FA code' });

      await pool.query(
        `UPDATE users SET totp_secret = NULL, totp_enabled_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [req.auth.userId]
      );
      await pool.query('DELETE FROM backup_codes WHERE user_id = $1', [req.auth.userId]);
      res.status(200).json({ enabled: false, message: '2FA disabled' });
    } catch (err) {
      log.error('2FA disable failed:', err);
      res.status(500).json({ error: '2FA disable failed' });
    }
  });

  app.post('/auth/logout', (req, res) => {
    clearSessionCookie(res);
    res.status(200).json({ message: 'Logged out' });
  });

  // GET /auth/me — full session context for the dashboard
  app.get('/auth/me', requireAuth, rl, async (req, res) => {
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
      log.error('/auth/me failed:', err);
      res.status(500).json({ error: 'Failed to load session' });
    }
  });

  // POST /auth/switch-org — change active organization (must be a member)
  app.post('/auth/switch-org', requireAuth, rl, async (req, res) => {
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
      log.error('switch-org failed:', err);
      res.status(500).json({ error: 'Switch organization failed' });
    }
  });

  // POST /organizations — create a new org for the current user (becomes owner)
  app.post(
    '/organizations',
    requireAuth,
    rl,
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
        log.error('Create organization failed:', err);
        res.status(500).json({ error: 'Create organization failed' });
      } finally {
        client.release();
      }
    }
  );

  // GET /organizations/current/members — list members of active org
  app.get('/organizations/current/members', requireAuth, rl, async (req, res) => {
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
      log.error('List members failed:', err);
      res.status(500).json({ error: 'List members failed' });
    }
  });

  // POST /organizations/current/members — add or update an existing user
  // by email. Requires owner/admin role.
  //
  // Owner-demotion rules (defense against admin-overthrow):
  //   - Only owners can demote an existing owner.
  //   - Never demote the last owner of the org. The transaction holds
  //     a row lock + counts owners under FOR UPDATE so two concurrent
  //     demotions can't both succeed.
  //
  // Real product needs an invite-by-email flow for users that don't
  // yet exist; that lives at /organizations/current/invitations.
  app.post(
    '/organizations/current/members',
    requireAuth,
    rl,
    requireRole('owner', 'admin'),
    async (req, res) => {
      const { email, role } = req.body || {};
      if (!email) return res.status(400).json({ error: 'email is required' });
      const targetRole = role || 'member';
      if (!['owner', 'admin', 'member'].includes(targetRole)) {
        return res.status(400).json({ error: 'role must be owner, admin, or member' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Per-org advisory lock so concurrent role mutations on different
        // memberships in the same org serialize. Without it, two admins
        // concurrently demoting two distinct owners can both pass the
        // owner-count check (each sees 2) and the org ends up with 0
        // owners.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [
          req.auth.organizationId,
        ]);
        const userResult = await client.query(
          'SELECT id FROM users WHERE LOWER(email) = LOWER($1)',
          [email]
        );
        if (userResult.rowCount === 0) {
          await client.query('ROLLBACK');
          return res
            .status(404)
            .json({ error: 'No user with that email; they must register first' });
        }
        const targetUserId = userResult.rows[0].id;

        // Lock the existing membership row so a concurrent demotion of
        // the same user can't pass the count-then-update check twice.
        const existing = await client.query(
          `SELECT role FROM memberships
           WHERE user_id = $1 AND organization_id = $2 FOR UPDATE`,
          [targetUserId, req.auth.organizationId]
        );

        if (existing.rowCount > 0 && existing.rows[0].role === 'owner' && targetRole !== 'owner') {
          // Demotion of an existing owner.
          if (req.auth.role !== 'owner') {
            await client.query('ROLLBACK');
            return res.status(403).json({
              error: "Only owners can change an owner's role",
            });
          }
          const owners = await client.query(
            `SELECT COUNT(*)::int AS n FROM memberships
             WHERE organization_id = $1 AND role = 'owner'`,
            [req.auth.organizationId]
          );
          if (owners.rows[0].n <= 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: 'Cannot demote the last owner; promote someone else first',
            });
          }
        }

        await client.query(
          `INSERT INTO memberships (user_id, organization_id, role)
                 VALUES ($1, $2, $3)
                 ON CONFLICT (user_id, organization_id) DO UPDATE SET role = EXCLUDED.role`,
          [targetUserId, req.auth.organizationId, targetRole]
        );
        await client.query('COMMIT');
        res.status(201).json({ user_id: targetUserId, role: targetRole });
      } catch (err) {
        await client.query('ROLLBACK');
        log.error('Add member failed:', err);
        res.status(500).json({ error: 'Add member failed' });
      } finally {
        client.release();
      }
    }
  );

  // DELETE /organizations/current/members/:userId — remove a member.
  //
  // Same protection as the demotion path: only owners can remove
  // owners, and the last owner can never be removed (transferring
  // ownership first is the only way to leave an org you solo-own).
  app.delete(
    '/organizations/current/members/:userId',
    requireAuth,
    rl,
    requireRole('owner', 'admin'),
    async (req, res) => {
      const { userId } = req.params;
      if (userId === req.auth.userId) {
        return res.status(400).json({ error: 'Cannot remove yourself; transfer ownership first' });
      }
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Per-org advisory lock — see /members POST for rationale.
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [
          req.auth.organizationId,
        ]);
        const target = await client.query(
          `SELECT role FROM memberships
           WHERE user_id = $1 AND organization_id = $2 FOR UPDATE`,
          [userId, req.auth.organizationId]
        );
        if (target.rowCount === 0) {
          await client.query('ROLLBACK');
          return res.status(404).json({ error: 'Member not found' });
        }
        const targetRole = target.rows[0].role;
        if (targetRole === 'owner' && req.auth.role !== 'owner') {
          await client.query('ROLLBACK');
          return res.status(403).json({ error: 'Only owners can remove an owner' });
        }
        if (targetRole === 'owner') {
          const owners = await client.query(
            `SELECT COUNT(*)::int AS n FROM memberships
             WHERE organization_id = $1 AND role = 'owner'`,
            [req.auth.organizationId]
          );
          if (owners.rows[0].n <= 1) {
            await client.query('ROLLBACK');
            return res.status(400).json({
              error: 'Cannot remove the last owner; promote someone else first',
            });
          }
        }
        await client.query(
          `DELETE FROM memberships
                 WHERE user_id = $1 AND organization_id = $2`,
          [userId, req.auth.organizationId]
        );
        await client.query('COMMIT');
        res.status(200).json({ message: 'Member removed' });
      } catch (err) {
        await client.query('ROLLBACK');
        log.error('Remove member failed:', err);
        res.status(500).json({ error: 'Remove member failed' });
      } finally {
        client.release();
      }
    }
  );

  // GET /organizations/current/quotas — current usage + EFFECTIVE limits
  // (per-org override if set, else env default).
  app.get('/organizations/current/quotas', requireAuth, rl, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM subscriptions
             WHERE organization_id = $1) AS sub_used,
            (SELECT COUNT(*)::int FROM api_keys
             WHERE organization_id = $1 AND revoked_at IS NULL) AS key_used,
            o.max_subscriptions, o.max_api_keys
         FROM organizations o WHERE o.id = $1`,
        [req.auth.organizationId]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Organization not found' });
      }
      const row = r.rows[0];
      res.status(200).json({
        subscriptions: {
          used: row.sub_used,
          limit: row.max_subscriptions != null ? row.max_subscriptions : limits.subscriptions,
        },
        api_keys: {
          used: row.key_used,
          limit: row.max_api_keys != null ? row.max_api_keys : limits.apiKeys,
        },
      });
    } catch (err) {
      log.error('Failed to load quotas:', err);
      res.status(500).json({ error: 'Failed to load quotas' });
    }
  });

  // --- Password change + reset ---

  // POST /auth/password/change — authenticated; rotate password.
  // Requires the CURRENT password to prevent stolen-cookie attacks
  // from quietly changing the password and locking the user out.
  app.post('/auth/password/change', requireAuth, rl, async (req, res) => {
    if (req.auth.via !== 'cookie') {
      return res.status(403).json({ error: 'Password change is only available via session login' });
    }
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: 'current_password and new_password are required' });
    }
    if (typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    try {
      const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [
        req.auth.userId,
      ]);
      if (userResult.rowCount === 0) {
        return res.status(404).json({ error: 'User not found' });
      }
      const ok = await verifyPassword(current_password, userResult.rows[0].password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
      const newHash = await hashPassword(new_password);
      await pool.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
        newHash,
        req.auth.userId,
      ]);
      // Invalidate any outstanding reset tokens for this user — they
      // chose a new password, any in-flight resets are obsolete.
      await pool.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL`,
        [req.auth.userId]
      );
      res.status(200).json({ message: 'Password changed' });
    } catch (err) {
      log.error('Password change failed:', err);
      res.status(500).json({ error: 'Password change failed' });
    }
  });

  // POST /auth/password/reset-request — anonymous; create a reset token
  // for the given email if (and only if) such a user exists. Always
  // returns 200 to avoid leaking which emails are registered.
  //
  // In production: email the raw token to the user. Here we return it
  // in the response so the dashboard / curl can complete the flow
  // end-to-end without an SMTP setup. Documented in the response.
  app.post('/auth/password/reset-request', authRl, async (req, res) => {
    const { email: email_address } = req.body || {};
    if (!email_address || typeof email_address !== 'string') {
      return res.status(400).json({ error: 'email is required' });
    }
    try {
      const userResult = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [
        email_address,
      ]);
      if (userResult.rowCount === 0) {
        // No-op — same response shape so callers can't tell registered
        // emails from unregistered ones. Add a small consistent delay?
        // Skipped: scrypt verifyPassword on login already pads timing.
        return res.status(200).json({
          message: 'If that email is registered, a reset link has been generated',
        });
      }
      const userId = userResult.rows[0].id;
      const { raw, hash } = generateResetToken();
      const expiresAt = new Date(Date.now() + RESET_EXPIRY_HOURS * 60 * 60 * 1000);
      await pool.query(
        `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, hash, expiresAt]
      );

      // If SMTP is configured, send the email and OMIT the raw token from
      // the response. Without SMTP, fall back to returning the token so the
      // dashboard / curl flow still works in dev.
      const resetUrl = `${baseUrl}/auth/password/reset?token=${encodeURIComponent(raw)}`;
      let delivery = { delivered: false, reason: 'no_transport' };
      if (email.enabled) {
        delivery = await email.send({
          to: email_address,
          subject: 'Reset your AnyHook password',
          text:
            `Hello,\n\nA password reset was requested for your AnyHook account.\n\n` +
            `Reset your password: ${resetUrl}\n\n` +
            `This link expires at ${expiresAt.toISOString()}. ` +
            `If you didn't request this, ignore this email.`,
        });
      }

      res.status(200).json({
        message: 'If that email is registered, a reset link has been generated',
        ...(delivery.delivered ? {} : { token: raw, expires_at: expiresAt }),
        email_sent: delivery.delivered,
      });
    } catch (err) {
      log.error('Password reset request failed:', err);
      res.status(500).json({ error: 'Reset request failed' });
    }
  });

  // POST /auth/password/reset — anonymous; consume a reset token + set
  // a new password. Marks the token used + sets a fresh password_hash.
  app.post('/auth/password/reset', authRl, async (req, res) => {
    const { token, new_password } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    if (!new_password || typeof new_password !== 'string' || new_password.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    const hash = hashResetToken(token);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tokenResult = await client.query(
        `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens
         WHERE token_hash = $1 FOR UPDATE`,
        [hash]
      );
      if (tokenResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invalid token' });
      }
      const row = tokenResult.rows[0];
      if (row.used_at) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'Token already used' });
      }
      if (new Date(row.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'Token expired' });
      }
      const newHash = await hashPassword(new_password);
      await client.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [
        newHash,
        row.user_id,
      ]);
      await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [
        row.id,
      ]);
      // Invalidate any OTHER outstanding reset tokens for this user.
      await client.query(
        `UPDATE password_reset_tokens SET used_at = NOW()
         WHERE user_id = $1 AND id != $2 AND used_at IS NULL`,
        [row.user_id, row.id]
      );
      await client.query('COMMIT');
      res.status(200).json({ message: 'Password reset' });
    } catch (err) {
      await client.query('ROLLBACK');
      log.error('Password reset failed:', err);
      res.status(500).json({ error: 'Password reset failed' });
    } finally {
      client.release();
    }
  });

  // --- Invitations ---

  // POST /organizations/current/invitations — create a new invitation token.
  // Returns the raw token ONCE; only the SHA-256 hash is stored.
  app.post(
    '/organizations/current/invitations',
    requireAuth,
    rl,
    requireRole('owner', 'admin'),
    async (req, res) => {
      // Renamed to avoid shadowing the outer `email` (transport).
      const { email: invite_email, role, expires_in_days: expiresInDays } = req.body || {};
      if (!invite_email || typeof invite_email !== 'string' || !/^.+@.+\..+$/.test(invite_email)) {
        return res.status(400).json({ error: 'Valid email is required' });
      }
      const targetRole = role || 'member';
      if (!['owner', 'admin', 'member'].includes(targetRole)) {
        return res.status(400).json({ error: 'role must be owner, admin, or member' });
      }
      const days =
        Number.isFinite(Number(expiresInDays)) && Number(expiresInDays) > 0
          ? Number(expiresInDays)
          : INVITE_EXPIRY_DAYS;
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

      const { raw, hash } = generateInvitationToken();
      try {
        const result = await pool.query(
          `INSERT INTO invitations
             (organization_id, email, role, token_hash, expires_at, created_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, organization_id, email, role, expires_at, created_at`,
          [
            req.auth.organizationId,
            invite_email.toLowerCase(),
            targetRole,
            hash,
            expiresAt,
            req.auth.userId,
          ]
        );

        // Try to email the invitee if SMTP is configured. On success,
        // omit the raw token from the response (delivered via email).
        const inviteUrl = `${baseUrl}/invitations/${raw}`;
        let delivery = { delivered: false, reason: 'no_transport' };
        if (email.enabled) {
          delivery = await email.send({
            to: result.rows[0].email,
            subject: `You've been invited to join an organization on AnyHook`,
            text:
              `Hello,\n\nYou've been invited to join an organization on AnyHook ` +
              `as a ${targetRole}.\n\nAccept the invitation: ${inviteUrl}\n\n` +
              `This link expires at ${result.rows[0].expires_at.toISOString()}.`,
          });
        }

        res.status(201).json({
          ...result.rows[0],
          ...(delivery.delivered ? {} : { token: raw }),
          email_sent: delivery.delivered,
          message: delivery.delivered
            ? 'Invitation created and emailed.'
            : 'Invitation created. Save the token — it is shown only once.',
        });
      } catch (err) {
        log.error('Create invitation failed:', err);
        res.status(500).json({ error: 'Create invitation failed' });
      }
    }
  );

  // GET /organizations/current/invitations — list pending (not accepted/
  // revoked/expired) invitations. No tokens returned.
  app.get('/organizations/current/invitations', requireAuth, rl, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT id, email, role, expires_at, created_at, accepted_at, revoked_at
         FROM invitations
         WHERE organization_id = $1
         ORDER BY created_at DESC`,
        [req.auth.organizationId]
      );
      res.status(200).json(result.rows);
    } catch (err) {
      log.error('List invitations failed:', err);
      res.status(500).json({ error: 'List invitations failed' });
    }
  });

  // DELETE /organizations/current/invitations/:id — revoke (soft delete)
  app.delete(
    '/organizations/current/invitations/:id',
    requireAuth,
    rl,
    requireRole('owner', 'admin'),
    async (req, res) => {
      try {
        const r = await pool.query(
          `UPDATE invitations SET revoked_at = NOW()
           WHERE id = $1 AND organization_id = $2
             AND revoked_at IS NULL AND accepted_at IS NULL
           RETURNING id`,
          [req.params.id, req.auth.organizationId]
        );
        if (r.rowCount === 0) {
          return res.status(404).json({ error: 'Invitation not found or already used/revoked' });
        }
        res.status(200).json({ message: 'Invitation revoked' });
      } catch (err) {
        log.error('Revoke invitation failed:', err);
        res.status(500).json({ error: 'Revoke invitation failed' });
      }
    }
  );

  // GET /invitations/:token — anonymous lookup so the registration page
  // can show "Join <org name> as <role>" before the user submits.
  // Returns minimal metadata; never leaks the token hash or other tokens'
  // info.
  app.get('/invitations/:token', authRl, async (req, res) => {
    const hash = hashInvitationToken(req.params.token);
    try {
      const r = await pool.query(
        `SELECT i.email, i.role, i.expires_at, i.accepted_at, i.revoked_at,
                o.name AS organization_name
         FROM invitations i
         JOIN organizations o ON o.id = i.organization_id
         WHERE i.token_hash = $1`,
        [hash]
      );
      if (r.rowCount === 0) {
        return res.status(404).json({ error: 'Invitation not found' });
      }
      const inv = r.rows[0];
      if (inv.revoked_at) return res.status(410).json({ error: 'Invitation revoked' });
      if (inv.accepted_at) return res.status(410).json({ error: 'Invitation already used' });
      if (new Date(inv.expires_at) < new Date()) {
        return res.status(410).json({ error: 'Invitation expired' });
      }
      res.status(200).json({
        email: inv.email,
        role: inv.role,
        organization_name: inv.organization_name,
        expires_at: inv.expires_at,
      });
    } catch (err) {
      log.error('Lookup invitation failed:', err);
      res.status(500).json({ error: 'Lookup failed' });
    }
  });

  // POST /auth/accept-invite — anonymous: registers a new user with the
  // invitation's email and adds them to the org with the invitation's role.
  // Issues a session cookie on success (auto-login).
  //
  // Existing-user case (joining an additional org while logged in) is NOT
  // handled here; use POST /organizations/current/members from an
  // owner/admin's session instead.
  app.post('/auth/accept-invite', authRl, async (req, res) => {
    const { token, password, name } = req.body || {};
    if (!token || typeof token !== 'string') {
      return res.status(400).json({ error: 'token is required' });
    }
    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const hash = hashInvitationToken(token);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inviteResult = await client.query(
        `SELECT id, organization_id, email, role, expires_at, accepted_at, revoked_at
         FROM invitations WHERE token_hash = $1 FOR UPDATE`,
        [hash]
      );
      if (inviteResult.rowCount === 0) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Invitation not found' });
      }
      const inv = inviteResult.rows[0];
      if (inv.revoked_at) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'Invitation revoked' });
      }
      if (inv.accepted_at) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'Invitation already used' });
      }
      if (new Date(inv.expires_at) < new Date()) {
        await client.query('ROLLBACK');
        return res.status(410).json({ error: 'Invitation expired' });
      }

      // Reject if a user with this email already exists — they must use
      // the existing-user path. Avoids ambiguity around "is this the
      // person the inviter meant?".
      const existing = await client.query('SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)', [
        inv.email,
      ]);
      if (existing.rowCount > 0) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error:
            'A user with this email already exists. Please log in and ask an org admin to add you.',
        });
      }

      const passwordHash = await hashPassword(password);
      const userResult = await client.query(
        `INSERT INTO users (email, password_hash, name)
         VALUES ($1, $2, $3)
         RETURNING id, email, name, created_at`,
        [inv.email, passwordHash, name || null]
      );
      const user = userResult.rows[0];

      await client.query(
        `INSERT INTO memberships (user_id, organization_id, role)
         VALUES ($1, $2, $3)`,
        [user.id, inv.organization_id, inv.role]
      );

      await client.query(`UPDATE invitations SET accepted_at = NOW() WHERE id = $1`, [inv.id]);

      const orgResult = await client.query(
        'SELECT id, name, slug FROM organizations WHERE id = $1',
        [inv.organization_id]
      );
      await client.query('COMMIT');

      const sessionToken = signSession(user.id, inv.organization_id);
      setSessionCookie(res, sessionToken);
      res.status(201).json({
        user: { id: user.id, email: user.email, name: user.name },
        organization: { ...orgResult.rows[0], role: inv.role },
      });
    } catch (err) {
      await client.query('ROLLBACK');
      log.error('Accept invitation failed:', err);
      res.status(500).json({ error: 'Accept invitation failed' });
    } finally {
      client.release();
    }
  });

  // GET /organizations/current/api-keys — list keys for the active org
  app.get('/organizations/current/api-keys', requireAuth, rl, async (req, res) => {
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
      log.error('List API keys failed:', err);
      res.status(500).json({ error: 'List API keys failed' });
    }
  });

  // POST /organizations/current/api-keys — create a new API key
  app.post(
    '/organizations/current/api-keys',
    requireAuth,
    rl,
    requireRole('owner', 'admin'),
    apiKeyQuotaMw,
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
        log.error('Create API key failed:', err);
        res.status(500).json({ error: 'Create API key failed' });
      }
    }
  );

  // DELETE /organizations/current/api-keys/:id — revoke (soft delete)
  app.delete(
    '/organizations/current/api-keys/:id',
    requireAuth,
    rl,
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
        log.error('Revoke API key failed:', err);
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
