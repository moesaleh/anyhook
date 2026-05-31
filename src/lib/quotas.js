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

/**
 * Quota check + claim. Without locking, two concurrent /subscribe at
 * the limit boundary both see used < limit and both succeed → over-
 * quota by 1. We take a per-org session-level pg_advisory_lock on a
 * dedicated pooled connection so concurrent requests for the same org
 * serialize their count.
 *
 * The lock is released as soon as the quota DECISION is made (pass or
 * 429), not on the response 'finish'/'close' event — holding a pooled
 * connection across the whole response flush was wasteful and, under
 * load, starved the pool (P2-7). The 'finish'/'close' listeners remain
 * wired as an idempotent safety net for the rare path where the
 * decision logic throws before its explicit release() runs.
 *
 * Residual race (documented): the create handler's INSERT runs in its
 * OWN transaction on a SEPARATE pool connection, so the advisory lock
 * only serializes the COUNT, not count+INSERT atomically. Releasing
 * right after the count (rather than after the INSERT) widens the
 * window in which a sibling request can read a stale count by the few
 * ms between this request's release and its handler's COMMIT — i.e.
 * the boundary can still be overshot by ~1 under extreme concurrency.
 * Closing that fully requires the create handler to run its INSERT in
 * the SAME transaction as a pg_advisory_xact_lock (an app.js change),
 * which is out of scope here. The trade is a much shorter connection
 * hold for a marginally wider (already-present) overshoot window.
 *
 * Falling open on DB error stays unchanged: a transient pool blip
 * shouldn't block legitimate writes.
 */

// Stable namespaces for the per-org advisory locks. Exported so
// other handlers (e.g. /subscribe/bulk) can take the SAME lock as
// the per-request subscriptionQuota middleware — otherwise a bulk
// import could race a single create. Values are arbitrary but
// must be int4 (pg_advisory_lock(int, int)).
const ADVISORY_LOCK_KEY_QUOTAS = 8472394;
const ADVISORY_LOCK_KEY_API_KEYS = 8472395;

/**
 * Threshold at which a quota_warning notification is fired (when the
 * caller wired notifyQuotaWarning + the org has notification_preferences
 * subscribed to that event). 80% feels like a useful "still time to
 * raise the cap before users hit 429". Configurable per-instance via
 * the quotaWarningThreshold option.
 */
const DEFAULT_QUOTA_WARNING_THRESHOLD = 0.8;

function makeSubscriptionQuotaCheck({
  pool,
  log,
  limit = DEFAULTS.subscriptions,
  notifyQuotaWarning,
  quotaWarningThreshold = DEFAULT_QUOTA_WARNING_THRESHOLD,
} = {}) {
  if (!pool) throw new Error('makeSubscriptionQuotaCheck: pool is required');
  return async function subscriptionQuota(req, res, next) {
    if (!req.auth || !req.auth.organizationId) return next();
    try {
      // Take a per-org session-level advisory lock so concurrent
      // requests for the same org serialize their count. We use a
      // session-level lock (not pg_advisory_xact_lock) because we are
      // not inside an explicit transaction on this connection; the lock
      // is released explicitly the moment the quota decision is made.
      const lockClient = await pool.connect();
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try {
          // Mirror the lock key exactly: lock uses hashtext($2::text),
          // so unlock MUST too, or pg_advisory_unlock returns false and
          // the session lock rides back onto the pooled connection
          // (P0-3). pg_advisory_lock(int, int) needs both args int4.
          await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2::text))', [
            ADVISORY_LOCK_KEY_QUOTAS,
            req.auth.organizationId,
          ]);
        } catch (e) {
          if (log) log.error('Failed to unlock quota advisory lock', { err: e.message });
        } finally {
          lockClient.release();
        }
      };
      // Safety net only: the happy/decision paths below call release()
      // explicitly. These listeners catch the case where the decision
      // logic throws after acquiring the lock; release() is idempotent
      // via the `released` guard.
      res.on('finish', release);
      res.on('close', release);
      try {
        await lockClient.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [
          ADVISORY_LOCK_KEY_QUOTAS,
          req.auth.organizationId,
        ]);
      } catch (err) {
        if (log) log.error('Quota advisory lock failed (failing open)', { err: err.message });
        await release();
        return next();
      }

      const r = await lockClient.query(
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
        await release();
        return res.status(429).json({
          error: 'Subscription quota exceeded for organization',
          quota: 'subscriptions',
          used,
          limit: effectiveLimit,
        });
      }

      // Fire a quota_warning notification once an org crosses the
      // configured threshold. Cooldown is enforced atomically via a
      // conditional UPDATE on organizations.last_quota_warning_at —
      // only one concurrent request "wins" the slot, so back-to-back
      // /subscribe calls don't spam the operator. This UPDATE is the
      // last op that benefits from the per-org lock window (it shares
      // the cooldown slot), so it runs before release() below.
      if (
        notifyQuotaWarning &&
        effectiveLimit > 0 &&
        used / effectiveLimit >= quotaWarningThreshold
      ) {
        try {
          const claim = await lockClient.query(
            `UPDATE organizations
             SET last_quota_warning_at = NOW()
             WHERE id = $1
               AND (last_quota_warning_at IS NULL
                    OR last_quota_warning_at < NOW() - INTERVAL '1 hour')
             RETURNING 1`,
            [req.auth.organizationId]
          );
          if (claim.rowCount > 0) {
            // Fire-and-forget — don't block the API on notification IO.
            try {
              notifyQuotaWarning(req.auth.organizationId, used, effectiveLimit);
            } catch (e) {
              if (log) log.error('quota_warning callback threw', { err: e.message });
            }
          }
        } catch (err) {
          if (log) log.error('quota_warning claim failed', { err: err.message });
        }
      }

      // Decision made (under limit) — release the lock + return the
      // connection to the pool NOW rather than waiting for the response
      // to flush (P2-7). The create handler runs on its own connection,
      // so it does not need this one.
      await release();
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
      const lockClient = await pool.connect();
      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        try {
          await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2::text))', [
            ADVISORY_LOCK_KEY_API_KEYS,
            req.auth.organizationId,
          ]);
        } catch (e) {
          if (log) log.error('Failed to unlock api-key quota lock', { err: e.message });
        } finally {
          lockClient.release();
        }
      };
      // Safety net only — the decision paths below release() explicitly
      // so the pooled connection isn't held across the response flush
      // (P2-7). release() is idempotent via the `released` guard.
      res.on('finish', release);
      res.on('close', release);
      try {
        await lockClient.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [
          ADVISORY_LOCK_KEY_API_KEYS,
          req.auth.organizationId,
        ]);
      } catch (err) {
        if (log)
          log.error('API key quota advisory lock failed (failing open)', { err: err.message });
        await release();
        return next();
      }

      const r = await lockClient.query(
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
        await release();
        return res.status(429).json({
          error: 'API key quota exceeded for organization',
          quota: 'api_keys',
          used,
          limit: effectiveLimit,
        });
      }
      // Decision made (under limit) — release the lock + return the
      // connection NOW rather than on response flush (P2-7).
      await release();
      return next();
    } catch (err) {
      if (log) log.error('API key quota check failed (failing open)', { err: err.message });
      return next();
    }
  };
}

module.exports = {
  makeSubscriptionQuotaCheck,
  makeApiKeyQuotaCheck,
  DEFAULTS,
  ADVISORY_LOCK_KEY_QUOTAS,
  ADVISORY_LOCK_KEY_API_KEYS,
};
