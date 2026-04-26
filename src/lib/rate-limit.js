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

function makeRateLimit({
  redisClient,
  limit,
  windowSec,
  prefix,
  logger,
  keyFn,
  pool,
} = {}) {
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
    // resolved an organizationId (i.e. authenticated), and (c) we're using
    // the default keyFn. ipKeyFn-based limits are pre-auth and don't have
    // an org to override against.
    let effectiveLimit = cfg.limit;
    let effectiveWindow = cfg.windowSec;
    if (pool && req.auth && req.auth.organizationId && cfg.keyFn === defaultKeyFn) {
      try {
        const r = await pool.query(
          'SELECT rate_limit_requests, rate_limit_window_sec FROM organizations WHERE id = $1',
          [req.auth.organizationId]
        );
        if (r.rowCount > 0) {
          const row = r.rows[0];
          if (row.rate_limit_requests != null) effectiveLimit = row.rate_limit_requests;
          if (row.rate_limit_window_sec != null) effectiveWindow = row.rate_limit_window_sec;
        }
      } catch (err) {
        // Silent fallback to defaults — DB blip shouldn't break rate limit
        if (logger) logger.warn('Rate limit override lookup failed', { err: err.message });
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

module.exports = { makeRateLimit, defaultKeyFn, ipKeyFn, DEFAULTS };
