/**
 * Per-organization rate limit, backed by Redis.
 *
 * Fixed-window counter per (organizationId, time-bucket). Simpler than
 * sliding-window logs and good enough for protecting the API and the
 * pending_retries queue from a single tenant.
 *
 * Behavior:
 *   - Skips requests with no req.auth (those will be rejected by the
 *     auth middleware that runs after — never deny without context).
 *   - Sets standard X-RateLimit-Limit / -Remaining / -Reset headers.
 *   - On Redis failure: fails OPEN. A Redis blip should not block legit
 *     traffic; we'd rather over-serve than under-serve.
 *
 * Apply AFTER requireAuth in the route's middleware chain:
 *   app.get('/foo', requireAuth, rateLimit, handler)
 */

const DEFAULTS = {
  limit: 600, // requests
  windowSec: 60, // per minute
  prefix: 'ratelimit',
};

function makeRateLimit({ redisClient, limit, windowSec, prefix, logger } = {}) {
  if (!redisClient) {
    throw new Error('makeRateLimit: redisClient is required');
  }
  const cfg = {
    limit: Number.isFinite(limit) ? limit : DEFAULTS.limit,
    windowSec: Number.isFinite(windowSec) ? windowSec : DEFAULTS.windowSec,
    prefix: prefix || DEFAULTS.prefix,
  };

  return async function rateLimitMiddleware(req, res, next) {
    if (!req.auth || !req.auth.organizationId) {
      // No auth context — let the next layer handle the rejection. Don't
      // double-deny here; that hides the real reason.
      return next();
    }

    const orgId = req.auth.organizationId;
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / cfg.windowSec);
    const key = `${cfg.prefix}:${orgId}:${bucket}`;
    const resetAt = (bucket + 1) * cfg.windowSec;

    let count;
    try {
      count = await redisClient.incr(key);
      if (count === 1) {
        // 2x window so the key sticks around briefly past the bucket boundary
        // for debugging — Redis cleans it up naturally.
        await redisClient.expire(key, cfg.windowSec * 2);
      }
    } catch (err) {
      // Fail OPEN on Redis failure. Surface the failure in logs/metrics.
      if (logger) {
        logger.error('Rate limit check failed (failing open)', { err: err.message, orgId });
      }
      return next();
    }

    res.setHeader('X-RateLimit-Limit', String(cfg.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, cfg.limit - count)));
    res.setHeader('X-RateLimit-Reset', String(resetAt));

    if (count > cfg.limit) {
      res.setHeader('Retry-After', String(Math.max(0, resetAt - nowSec)));
      return res.status(429).json({
        error: 'Rate limit exceeded for organization',
        limit: cfg.limit,
        windowSec: cfg.windowSec,
        retryAfter: Math.max(0, resetAt - nowSec),
      });
    }

    return next();
  };
}

module.exports = { makeRateLimit, DEFAULTS };
