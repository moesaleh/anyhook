/**
 * Generic rate limit middleware, backed by Redis.
 *
 * Fixed-window counter per (key, time-bucket). The `key` is extracted from
 * the request via a pluggable keyFn — defaults to req.auth.organizationId
 * (per-org limit on authenticated routes), but can be ipKeyFn for
 * anonymous endpoints like login/register, or any other extractor.
 *
 * Behavior:
 *   - keyFn returning a falsy value => skip (no key context, defer to next).
 *   - Sets standard X-RateLimit-Limit / -Remaining / -Reset headers.
 *   - On Redis failure: fails OPEN. A Redis blip should not block legit
 *     traffic; we'd rather over-serve than under-serve.
 *
 * Apply in the route chain at the right point:
 *   - For authenticated org-scoped routes:
 *       requireAuth, rateLimit (default keyFn reads req.auth.organizationId)
 *   - For anonymous routes (login/register):
 *       authRateLimit (keyFn = ipKeyFn)
 */

const DEFAULTS = {
  limit: 600, // requests
  windowSec: 60, // per minute
  prefix: 'ratelimit',
};

/**
 * Default key extractor: per-organization. Falsy when there's no req.auth,
 * which causes the middleware to skip — that's the right behavior because
 * unauthenticated routes will be rejected by the auth layer instead.
 */
function defaultKeyFn(req) {
  return req.auth && req.auth.organizationId;
}

/**
 * IP key extractor for anonymous endpoints.
 *
 * Honors the leftmost X-Forwarded-For when present (typical reverse-proxy
 * setup). Otherwise falls back to req.ip / req.connection.remoteAddress
 * / 'unknown'. Express's req.ip is only correct when `app.set('trust proxy',
 * ...)` is configured; otherwise prefer XFF directly.
 *
 * Returns a string (IP) or 'unknown' so the middleware never receives a
 * falsy key for an anonymous request — we DO want to count anonymous
 * traffic, even when we can't identify the source.
 */
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

function makeRateLimit({ redisClient, limit, windowSec, prefix, logger, keyFn } = {}) {
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
    if (!subject) {
      // No key context — defer to whatever runs after. Don't double-deny.
      return next();
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / cfg.windowSec);
    const key = `${cfg.prefix}:${subject}:${bucket}`;
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
        logger.error('Rate limit check failed (failing open)', { err: err.message, subject });
      }
      return next();
    }

    res.setHeader('X-RateLimit-Limit', String(cfg.limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, cfg.limit - count)));
    res.setHeader('X-RateLimit-Reset', String(resetAt));

    if (count > cfg.limit) {
      res.setHeader('Retry-After', String(Math.max(0, resetAt - nowSec)));
      return res.status(429).json({
        error: 'Rate limit exceeded',
        limit: cfg.limit,
        windowSec: cfg.windowSec,
        retryAfter: Math.max(0, resetAt - nowSec),
      });
    }

    return next();
  };
}

module.exports = { makeRateLimit, defaultKeyFn, ipKeyFn, DEFAULTS };
