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

/**
 * Whether to trust client-supplied X-Forwarded-For. Gated on the SAME
 * signal Express uses (app.js: `app.set('trust proxy', …)` keyed off
 * process.env.TRUST_PROXY). Any non-empty TRUST_PROXY value enables it,
 * matching app.js's `if (trustProxyEnv) { … }`. Read at call time so a
 * test or a runtime config can toggle it without re-importing.
 */
function trustsProxy() {
  return !!process.env.TRUST_PROXY;
}

/** Leftmost X-Forwarded-For token, trimmed, or null when absent/empty. */
function firstXffToken(req) {
  const xff = req.headers && req.headers['x-forwarded-for'];
  if (typeof xff !== 'string' || xff.length === 0) return null;
  const first = xff.split(',')[0];
  return first && first.trim() ? first.trim() : null;
}

/**
 * Resolve the rate-limit subject for IP-keyed (pre-auth) routes.
 *
 * SECURITY (P2-5): X-Forwarded-For is client-supplied and trivially
 * spoofable. Honoring its first token unconditionally let an attacker
 * with no proxy in front of them forge a different "IP" per request and
 * sidestep per-IP login/2FA throttling (or poison a victim's bucket).
 * We therefore only trust XFF when TRUST_PROXY is set — i.e. when there
 * actually IS a reverse proxy and Express is configured to trust it
 * (the same gate app.js applies). In that mode Express has already
 * resolved req.ip from the proxy chain, so req.ip is the canonical,
 * trustworthy value and is preferred.
 *
 * Untrusted mode: ignore XFF and key off req.ip (the real socket peer).
 * XFF is consulted only as a LAST resort when no socket-level address
 * is identifiable at all — that branch can't be abused to evade limits
 * any more than the catch-all 'unknown' bucket it replaces, and it
 * preserves behavior for callers that pass only headers.
 */
function ipKeyFn(req) {
  const firstXff = firstXffToken(req);

  // Trusting a real proxy: Express already resolved req.ip from the
  // proxy chain, so it's the canonical value. Prefer it; only fall back
  // to XFF defensively if req.ip wasn't populated.
  if (trustsProxy()) {
    if (req.ip) return req.ip;
    if (firstXff) return firstXff;
  } else if (req.ip) {
    // Untrusted: the real socket peer wins — never key off a forged
    // header when we have a genuine address.
    return req.ip;
  }

  if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  // Last resort: no socket-level address. XFF here is no worse than the
  // 'unknown' bucket it replaces and keeps header-only callers working.
  if (firstXff) return firstXff;
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
const RATE_LIMIT_OVERRIDE_TTL_MS = parseInt(process.env.RATE_LIMIT_OVERRIDE_TTL_MS, 10) || 5000;
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

/**
 * Atomic fixed-window increment.
 *
 * The naive `INCR` then separate `EXPIRE key (only when count===1)` is
 * two round trips: a crash / Redis failover / dropped connection in the
 * gap strands a TTL-less key that counts forever, permanently rate-
 * limiting the org behind that bucket (P2-2). We collapse both into a
 * single atomic operation:
 *
 *   - Preferred: a Lua script (INCR + conditional PEXPIRE) via EVAL —
 *     one server-side, atomic round trip. PEXPIRE (ms) so we can reuse
 *     the same `ttlMs` unit regardless of window size.
 *   - Fallback: the original INCR + conditional EXPIRE, used only when
 *     the client doesn't expose `eval` (e.g. the unit-test stub). The
 *     fallback keeps the historical "expire once per bucket" behavior
 *     so existing tests stay valid; production clients take the atomic
 *     path.
 *
 * Returns the post-increment count. Throws on Redis error so the caller
 * can fail open exactly as before.
 */
const INCR_EXPIRE_LUA =
  "local c = redis.call('INCR', KEYS[1]) " +
  "if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end " +
  'return c';

async function atomicIncrWithExpire(redisClient, key, ttlMs) {
  if (typeof redisClient.eval === 'function') {
    // node-redis v4/v5 EVAL signature: eval(script, { keys, arguments }).
    // ARGV/KEYS are strings on the wire; the script's redis.call coerces.
    const res = await redisClient.eval(INCR_EXPIRE_LUA, {
      keys: [key],
      arguments: [String(ttlMs)],
    });
    return typeof res === 'number' ? res : Number(res);
  }
  // Non-atomic fallback (no EVAL support). Same two-step behavior the
  // module shipped with; only reached by stubs lacking eval().
  const count = await redisClient.incr(key);
  if (count === 1) {
    // Keep EXPIRE in seconds here to match the legacy call shape the
    // unit tests assert against (expireCalls records seconds).
    await redisClient.expire(key, Math.ceil(ttlMs / 1000));
  }
  return count;
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
      // Atomic INCR + (first-hit) PEXPIRE in one operation so a crash
      // between the two can't strand a TTL-less key (P2-2). TTL is the
      // legacy windowSec*2 grace, expressed in ms.
      count = await atomicIncrWithExpire(redisClient, key, effectiveWindow * 2 * 1000);
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
