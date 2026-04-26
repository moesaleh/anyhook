/**
 * Per-organization quota middleware.
 *
 * Rate limit handles burst traffic; quotas cap standing usage so a single
 * org can't create unbounded subscriptions or API keys (and saturate the
 * connector's process / Redis / pending_retries queue).
 *
 * These factories are constructed once with a configured limit and used
 * as Express middleware before the relevant CREATE handler. They run a
 * single SELECT COUNT(*) scoped to req.auth.organizationId; on the
 * happy path that's a few microseconds against an indexed column.
 *
 * Behavior:
 *   - 429 with X-Quota-Limit / X-Quota-Used headers when at or over limit.
 *   - Fails OPEN on DB error: a transient pool failure shouldn't block
 *     legitimate writes; the underlying handler will likely fail too and
 *     surface the real error.
 *
 * Future: per-org overrides via an organizations.max_subscriptions column.
 */

const DEFAULTS = {
  subscriptions: 100,
  apiKeys: 10,
};

function makeSubscriptionQuotaCheck({ pool, log, limit = DEFAULTS.subscriptions } = {}) {
  if (!pool) throw new Error('makeSubscriptionQuotaCheck: pool is required');
  return async function subscriptionQuota(req, res, next) {
    if (!req.auth || !req.auth.organizationId) return next();
    try {
      const r = await pool.query(
        'SELECT COUNT(*)::int AS n FROM subscriptions WHERE organization_id = $1',
        [req.auth.organizationId]
      );
      const used = r.rows[0].n;
      res.setHeader('X-Quota-Limit', String(limit));
      res.setHeader('X-Quota-Used', String(used));
      if (used >= limit) {
        return res.status(429).json({
          error: 'Subscription quota exceeded for organization',
          quota: 'subscriptions',
          used,
          limit,
        });
      }
      return next();
    } catch (err) {
      if (log) log.error('Subscription quota check failed (failing open)', { err: err.message });
      return next();
    }
  };
}

function makeApiKeyQuotaCheck({ pool, log, limit = DEFAULTS.apiKeys } = {}) {
  if (!pool) throw new Error('makeApiKeyQuotaCheck: pool is required');
  return async function apiKeyQuota(req, res, next) {
    if (!req.auth || !req.auth.organizationId) return next();
    try {
      // Only count active (not revoked) keys against the cap. Revoked keys
      // are tombstones for audit; they shouldn't block new key creation.
      const r = await pool.query(
        `SELECT COUNT(*)::int AS n FROM api_keys
         WHERE organization_id = $1 AND revoked_at IS NULL`,
        [req.auth.organizationId]
      );
      const used = r.rows[0].n;
      res.setHeader('X-Quota-Limit', String(limit));
      res.setHeader('X-Quota-Used', String(used));
      if (used >= limit) {
        return res.status(429).json({
          error: 'API key quota exceeded for organization',
          quota: 'api_keys',
          used,
          limit,
        });
      }
      return next();
    } catch (err) {
      if (log) log.error('API key quota check failed (failing open)', { err: err.message });
      return next();
    }
  };
}

module.exports = { makeSubscriptionQuotaCheck, makeApiKeyQuotaCheck, DEFAULTS };
