/**
 * Per-organization quota middleware.
 *
 * Rate limit handles burst traffic; quotas cap standing usage so a single
 * org can't create unbounded subscriptions or API keys (and saturate the
 * connector's process / Redis / pending_retries queue).
 *
 * The effective limit is per-org override (organizations.max_subscriptions,
 * .max_api_keys) if set, else the global env default. Both pieces are
 * fetched in a single query with two scalar subselects.
 *
 * Behavior:
 *   - 429 with X-Quota-Limit / X-Quota-Used headers when at or over limit.
 *   - Fails OPEN on DB error: a transient pool failure shouldn't block
 *     legitimate writes; the underlying handler will likely fail too and
 *     surface the real error.
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
        `SELECT
            (SELECT COUNT(*)::int FROM subscriptions WHERE organization_id = $1) AS used,
            (SELECT max_subscriptions FROM organizations WHERE id = $1) AS override`,
        [req.auth.organizationId]
      );
      const used = r.rows[0].used;
      const effectiveLimit = r.rows[0].override != null ? r.rows[0].override : limit;
      res.setHeader('X-Quota-Limit', String(effectiveLimit));
      res.setHeader('X-Quota-Used', String(used));
      if (used >= effectiveLimit) {
        return res.status(429).json({
          error: 'Subscription quota exceeded for organization',
          quota: 'subscriptions',
          used,
          limit: effectiveLimit,
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
      const r = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM api_keys
             WHERE organization_id = $1 AND revoked_at IS NULL) AS used,
            (SELECT max_api_keys FROM organizations WHERE id = $1) AS override`,
        [req.auth.organizationId]
      );
      const used = r.rows[0].used;
      const effectiveLimit = r.rows[0].override != null ? r.rows[0].override : limit;
      res.setHeader('X-Quota-Limit', String(effectiveLimit));
      res.setHeader('X-Quota-Used', String(used));
      if (used >= effectiveLimit) {
        return res.status(429).json({
          error: 'API key quota exceeded for organization',
          quota: 'api_keys',
          used,
          limit: effectiveLimit,
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
