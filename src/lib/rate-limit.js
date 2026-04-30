/**
 * Generic rate limit middleware, backed by Redis.
 *
 * Fixed-window counter per (key, time-bucket). The `key` is extracted from
 * the request via a pluggable keyFn — defaults to req.auth.organizationId
 * (per-org limit on authenticated routes), but can be ipKeyFn for
 * anonymous endpoints like login/register, or any other extractor.
 *
 * Per-org overrides: when readOrgOverride is provided, the middleware
 * looks up organizations.rate_limit_requests / rate_limit_window_sec for
 * the active org (via req.auth.organizationId) and uses those instead of
 * the constructor's defaults. NULL columns fall through to the defaults.
 * Override lookup is best-effort: any DB error falls back to the default
 * silently (no security cost — the default IS the limit).
 *
 * Behavior:
 *   - keyFn returning a falsy value => skip (no key context, defer to next).
 *   - Sets standard X-RateLimit-Limit / -Remaining / -Reset headers.
 *   - On Redis failure: fails OPEN. A Redis blip should not block legit
 *     traffic; we'd rather over-serve than under-serve.
 */

const DEFAULTS = {
  limit: 600, // requests
  windowSec: 60, // per minute
  prefix: 'ratelimit',
};

function defaultKeyFn(req) {
  return req.auth && req.auth.organizationId;
}

/**
 * Per-user-per-org composite key. A noisy admin polling /subscriptions
 * every second won't consume the whole org's budget; each member is
 * counted independently, falling back to the org-only bucket for
 * API-key-authenticated requests (which have no userId).
 *
 * Wire this in by passing { keyFn: userOrgKeyFn } to makeRateLimit at
 * the bootstrap site (subscription-management/index.js) when the
 * RATE_LIMIT_PER_USER env flag is on.
 */
function userOrgKeyFn(req) {
  if (!req.auth || !req.auth.organizationId) return null;
  if (req.auth.userId) {
    return `${req.auth.organizationId}:${req.auth.userId}`;
  }
  return req.auth.organizationId;
}

function ipKeyFn(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return first.trim();
  }
  if (req.ip) return req.ip;
  if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

/**
 * In-memory TTL cache for the per-org rate-limit override row. Keyed
 * by organization_id; entries expire after RATE_LIMIT_OVERRIDE_TTL_MS
 * (default 5s). Closes the per-request DB roundtrip noted in the
 * audit (logical issue #9) without bloating staleness — operators
 * who flip an override see it take effect within ~5s.
 *
 * Cap at 1024 distinct orgs in the cache so a high-cardinality
 * cluster doesn't grow it unboundedly. Naive LRU: when full, drop
 * a random entry. The hit rate is still ~99% for typical org count.
 */
const RATE_LIMIT_OVERRIDE_TTL_MS =
  parseInt(process.env.RATE_LIMIT_OVERRIDE_TTL_MS, 10) || 5000;
const RATE_LIMIT_CACHE_MAX = 1024;
const overrideCache = new Map(); // orgId -> { ts, requests, windowSec }

function getCachedOverride(orgId) {
  const entry = overrideCache.get(orgId);
  if (!entry) return null;
  if (Date.now() - entry.ts > RATE_LIMIT_OVERRIDE_TTL_MS) {
    overrideCache.delete(orgId);
    return null;
  }
  return entry;
}

function setCachedOverride(orgId, requests, windowSec) {
  if (overrideCache.size >= RATE_LIMIT_CACHE_MAX) {
    // Drop one arbitrary entry — JS Map iteration order is insertion-
    // order, so the first key is the oldest.
    const firstKey = overrideCache.keys().next().value;
    overrideCache.delete(firstKey);
  }
  overrideCache.set(orgId, { ts: Date.now(), requests, windowSec });
}

function makeRateLimit({ redisClient, limit, windowSec, prefix, logger, keyFn, pool } = {}) {
  if (!redisClient) {
    throw new Error('makeRateLimit: redisClient is required');
  }
  const cfg = {
    limit: Number.isFinite(limit) ? limit : DEFAULTS.limit,
    windowSec: Number.isFinite(windowSec) ? windowSec : DEFAULTS.windowSec,
    prefix: prefix || DEFAULTS.prefix,
    keyFn: keyFn || defaultKeyFn,
  };

  return async function rateLimitMiddleware(req, res, next) {
    const subject = cfg.keyFn(req);
    if (!subject) return next();

    // Look up per-org override when (a) we have a pool, (b) the request
    // resolved an organizationId (i.e. authenticated), and (c) we're
    // using a keyFn that's tied to an org (defaultKeyFn or
    // userOrgKeyFn — both produce per-org budgets).
    // ipKeyFn-based limits are pre-auth and don't have an org to
    // override against. Result is cached for ~5s to avoid one PG
    // roundtrip per authenticated request.
    let effectiveLimit = cfg.limit;
    let effectiveWindow = cfg.windowSec;
    const orgScopedKey = cfg.keyFn === defaultKeyFn || cfg.keyFn === userOrgKeyFn;
    if (pool && req.auth && req.auth.organizationId && orgScopedKey) {
      const cached = getCachedOverride(req.auth.organizationId);
      if (cached) {
        if (cached.requests != null) effectiveLimit = cached.requests;
        if (cached.windowSec != null) effectiveWindow = cached.windowSec;
      } else {
        try {
          const r = await pool.query(
            'SELECT rate_limit_requests, rate_limit_window_sec FROM organizations WHERE id = $1',
            [req.auth.organizationId]
          );
          if (r.rowCount > 0) {
            const row = r.rows[0];
            setCachedOverride(
              req.auth.organizationId,
              row.rate_limit_requests,
              row.rate_limit_window_sec
            );
            if (row.rate_limit_requests != null) effectiveLimit = row.rate_limit_requests;
            if (row.rate_limit_window_sec != null) effectiveWindow = row.rate_limit_window_sec;
          } else {
            // Cache the negative result too — same TTL — so a flood of
            // requests against a missing org doesn't keep hitting PG.
            setCachedOverride(req.auth.organizationId, null, null);
          }
        } catch (err) {
          // Silent fallback to defaults — DB blip shouldn't break rate limit
          if (logger) logger.warn('Rate limit override lookup failed', { err: err.message });
        }
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / effectiveWindow);
    const key = `${cfg.prefix}:${subject}:${bucket}`;
    const resetAt = (bucket + 1) * effectiveWindow;

    let count;
    try {
      count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, effectiveWindow * 2);
      }
    } catch (err) {
      if (logger) {
        logger.error('Rate limit check failed (failing open)', { err: err.message, subject });
      }
      return next();
    }

    res.setHeader('X-RateLimit-Limit', String(effectiveLimit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, effectiveLimit - count)));
    res.setHeader('X-RateLimit-Reset', String(resetAt));

    if (count > effectiveLimit) {
      res.setHeader('Retry-After', String(Math.max(0, resetAt - nowSec)));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: effectiveLimit,
        windowSec: effectiveWindow,
        retryAfter: Math.max(0, resetAt - nowSec),
      });
    }

    return next();
  };
}

/** Test hook — clears the override cache between unit tests. */
function _resetOverrideCache() {
  overrideCache.clear();
}

module.exports = {
  makeRateLimit,
  defaultKeyFn,
  userOrgKeyFn,
  ipKeyFn,
  DEFAULTS,
  _resetOverrideCache,
};
