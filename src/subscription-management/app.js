/**
 * Express app factory.
 *
 * Constructs and returns an Express app with all middleware + routes
 * attached. All side-effecting clients (pg pool, redis, kafka producer/admin)
 * are passed in — none are created here. That makes the app testable: the
 * integration suite passes a real pg pool + an in-memory Redis + no-op
 * Kafka clients, and exercises the routes via supertest.
 *
 * The bootstrap entry point (./index.js) is the only place that constructs
 * real clients and connects them.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const promClient = require('prom-client');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { isValidUrl } = require('../lib/url-validation');
const {
  makeSubscriptionQuotaCheck,
  makeApiKeyQuotaCheck,
  ADVISORY_LOCK_KEY_QUOTAS,
} = require('../lib/quotas');
const { makeEmailTransport } = require('../lib/email');
const {
  subscriptionCacheKey,
  subscriptionIdFromKey,
  SUBSCRIPTION_KEY_PATTERN,
} = require('../lib/subscription-cache');
const { mountAuthRoutes } = require('./auth');

// Read OpenAPI spec at module load. Errors during read fall back to a
// stub so the rest of the app still mounts (the spec is non-critical).
let OPENAPI_YAML = null;
try {
  OPENAPI_YAML = fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.yaml'), 'utf-8');
} catch {
  OPENAPI_YAML = 'openapi: 3.1.0\ninfo: { title: AnyHook, version: 0.0.0 }\npaths: {}\n';
}

const VALID_CONNECTION_TYPES = ['graphql', 'websocket'];

/**
 * Strip the per-subscription webhook signing secret before returning
 * subscription rows to API callers. Secrets are shown ONCE at creation
 * time (in the POST /subscribe response) and never again.
 */
function withoutSecret(row) {
  if (!row || typeof row !== 'object') return row;
  // eslint-disable-next-line no-unused-vars
  const { webhook_secret, ...rest } = row;
  return rest;
}

function validateSubscriptionInput(body) {
  const errors = [];
  const { connection_type, args, webhook_url } = body || {};

  if (!connection_type || !VALID_CONNECTION_TYPES.includes(connection_type)) {
    errors.push(`connection_type must be one of: ${VALID_CONNECTION_TYPES.join(', ')}`);
  }

  if (!args || typeof args !== 'object') {
    errors.push('args must be a JSON object');
  } else {
    if (!args.endpoint_url || !isValidUrl(args.endpoint_url)) {
      errors.push(
        'args.endpoint_url must be a valid public URL (private/loopback addresses are blocked)'
      );
    }
    if (connection_type === 'graphql' && (!args.query || typeof args.query !== 'string')) {
      errors.push('args.query is required for graphql subscriptions');
    }
  }

  if (!webhook_url || !isValidUrl(webhook_url, { allowedProtocols: ['http:', 'https:'] })) {
    errors.push(
      'webhook_url must be a valid public http/https URL (private/loopback addresses are blocked)'
    );
  }

  return errors;
}

function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({ error: message });
}

/**
 * Build an Express app.
 *
 * Required deps:
 *   pool           — pg.Pool
 *   redisClient    — connected Redis client (real or in-memory mock)
 *   producer       — kafkajs producer (real or noop)
 *   admin          — kafkajs admin (real or noop)
 *   log            — winston logger
 *   rateLimit      — per-org rate limit middleware (or noop)
 *   authRateLimit  — per-IP rate limit middleware (or noop)
 *   requireAdminKey — express middleware enforcing X-Admin-Key
 */
function createApp({
  pool,
  redisClient,
  producer,
  admin,
  log,
  rateLimit,
  authRateLimit,
  requireAdminKey,
  // Optional: inject a pre-built email transport. If omitted, the SMTP
  // env vars (SMTP_HOST, etc.) are read via makeEmailTransport. Tests
  // pass a fake to exercise delivered/no_transport/smtp_error branches.
  emailTransport,
}) {
  const app = express();

  // trust proxy: when behind a reverse proxy (nginx, ALB, Cloudflare),
  // req.ip reflects X-Forwarded-For. Set TRUST_PROXY=1 to enable.
  const trustProxyEnv = process.env.TRUST_PROXY;
  if (trustProxyEnv) {
    const n = Number(trustProxyEnv);
    app.set('trust proxy', Number.isFinite(n) ? n : trustProxyEnv === 'true');
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // HTTP request duration histogram. Records on response 'finish' so we
  // capture the actual latency including handler + DB time.
  // Idempotent: register only once per process even if createApp is called
  // multiple times in tests.
  let httpRequestDuration = promClient.register.getSingleMetric('http_request_duration_seconds');
  if (!httpRequestDuration) {
    httpRequestDuration = new promClient.Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    });
  }
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const route = req.route?.path || req.path || 'unknown';
      httpRequestDuration.observe(
        { method: req.method, route, status_code: res.statusCode },
        seconds
      );
    });
    next();
  });

  // CORS — credentials enabled so the session cookie travels.
  app.use((req, res, next) => {
    const allowedOrigin = process.env.DASHBOARD_URL || 'http://localhost:3000';
    res.header('Access-Control-Allow-Origin', allowedOrigin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Key');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  // Per-org standing quotas. Tunable via env; default 100 subs / 10 active
  // API keys per org. These run BEFORE the create handler, returning 429
  // with X-Quota-Limit / X-Quota-Used headers when at the cap.
  const subscriptionQuota = makeSubscriptionQuotaCheck({
    pool,
    log,
    limit: parseInt(process.env.ORG_MAX_SUBSCRIPTIONS, 10) || undefined,
  });
  const apiKeyQuota = makeApiKeyQuotaCheck({
    pool,
    log,
    limit: parseInt(process.env.ORG_MAX_API_KEYS, 10) || undefined,
  });

  // SMTP transport — no-op when SMTP_HOST unset (dev / tests). Tests
  // can pass a pre-built `emailTransport` to simulate delivered /
  // smtp_error / no_transport branches.
  const transport = emailTransport || makeEmailTransport({ log });

  const { requireAuth } = mountAuthRoutes(app, {
    pool,
    rateLimit,
    authRateLimit,
    apiKeyQuota,
    emailTransport: transport,
    quotaLimits: {
      subscriptions: parseInt(process.env.ORG_MAX_SUBSCRIPTIONS, 10) || 100,
      apiKeys: parseInt(process.env.ORG_MAX_API_KEYS, 10) || 10,
    },
  });

  // OpenAPI spec — public, served as both YAML and JSON-from-YAML for
  // tooling. Use any spec viewer (Swagger UI, Redoc, Stoplight, etc.)
  // pointed at GET /openapi.yaml.
  app.get('/openapi.yaml', (req, res) => {
    res.setHeader('Content-Type', 'application/yaml');
    res.send(OPENAPI_YAML);
  });

  // /metrics is served on a SEPARATE internal port (METRICS_PORT, default
  // 9090) by ./index.js — matches the worker pattern in
  // src/lib/metrics-server.js, so docker-compose only maps the public API
  // port and Prometheus reaches metrics over the internal network.
  // Historically /metrics was here on port 3001 and unauthenticated; that
  // leaked route names + latency histograms to anyone who reached the API
  // host. See docs/openapi.yaml + .env.example for the new setup.

  // Liveness probe — does the process answer? Doesn't probe deps.
  // Used by docker-compose's healthcheck so a Postgres/Redis blip
  // doesn't cascade the entire stack to "unhealthy" + restart loops.
  // (Container orchestrators want liveness ≠ readiness for exactly
  // this reason: restart-on-liveness, drop-from-LB-on-readiness.)
  app.get('/health/live', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Readiness probe — checks downstream deps. The dashboard's
  // ServiceHealth panel hits this so users see real connectivity
  // status. Returns 503 (degraded) when any dep is down so a load
  // balancer / readiness probe pulls the pod from rotation while
  // leaving the container running for liveness purposes.
  app.get('/health', async (req, res) => {
    const health = { status: 'ok', timestamp: new Date().toISOString(), services: {} };
    try {
      await pool.query('SELECT 1');
      health.services.postgres = 'connected';
    } catch {
      health.services.postgres = 'disconnected';
      health.status = 'degraded';
    }
    try {
      await redisClient.ping();
      health.services.redis = 'connected';
    } catch {
      health.services.redis = 'disconnected';
      health.status = 'degraded';
    }
    res.status(health.status === 'ok' ? 200 : 503).json(health);
  });

  // Subscription status (live connection state via Redis)
  app.get('/subscriptions/:id/status', requireAuth, rateLimit, async (req, res) => {
    const { id } = req.params;
    try {
      const dbResult = await pool.query(
        'SELECT subscription_id, status, created_at FROM subscriptions WHERE subscription_id = $1 AND organization_id = $2',
        [id, req.auth.organizationId]
      );
      if (dbResult.rows.length === 0) {
        return errorResponse(res, 404, 'Subscription not found');
      }
      const subscription = dbResult.rows[0];
      const cached = await redisClient.get(subscriptionCacheKey(id));
      const isConnected = cached !== null;

      let cachedAt = null;
      if (isConnected) {
        try {
          cachedAt = JSON.parse(cached).created_at;
        } catch {
          cachedAt = null;
        }
      }

      res.status(200).json({
        subscription_id: id,
        db_status: subscription.status,
        connected: isConnected,
        cached_at: cachedAt,
        checked_at: new Date().toISOString(),
      });
    } catch (err) {
      log.error('Error checking subscription status:', err);
      errorResponse(res, 500, 'Failed to check subscription status');
    }
  });

  // Bulk status — SCAN with MATCH so we only return subscription cache
  // entries (sub:*), not rate-limit counters or other keys sharing the
  // Redis instance.
  app.get('/subscriptions/status/all', requireAuth, rateLimit, async (req, res) => {
    try {
      const dbResult = await pool.query(
        'SELECT subscription_id, status FROM subscriptions WHERE organization_id = $1',
        [req.auth.organizationId]
      );

      const connectedIds = new Set();
      let cursor = 0;
      do {
        const result = await redisClient.scan(cursor, {
          MATCH: SUBSCRIPTION_KEY_PATTERN,
          COUNT: 100,
        });
        cursor = result.cursor;
        for (const key of result.keys) {
          const id = subscriptionIdFromKey(key);
          if (id) connectedIds.add(id);
        }
      } while (cursor !== 0);

      const statuses = dbResult.rows.map(row => ({
        subscription_id: row.subscription_id,
        db_status: row.status,
        connected: connectedIds.has(row.subscription_id),
      }));

      res.status(200).json({ statuses, checked_at: new Date().toISOString() });
    } catch (err) {
      log.error('Error checking statuses:', err);
      errorResponse(res, 500, 'Failed to check subscription statuses');
    }
  });

  // Delivery history per subscription
  app.get('/subscriptions/:id/deliveries', requireAuth, rateLimit, async (req, res) => {
    const { id } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const status = req.query.status || 'all';
    const offset = (page - 1) * limit;

    try {
      let whereClause = 'WHERE subscription_id = $1 AND organization_id = $2';
      const params = [id, req.auth.organizationId];
      if (status !== 'all') {
        whereClause += ' AND status = $3';
        params.push(status);
      }
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM delivery_events ${whereClause}`,
        params
      );
      const total = parseInt(countResult.rows[0].count);

      const dataParams = [...params, limit, offset];
      const dataResult = await pool.query(
        `SELECT * FROM delivery_events ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        dataParams
      );

      res.status(200).json({
        deliveries: dataResult.rows,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      log.error('Error fetching deliveries:', err);
      errorResponse(res, 500, 'Failed to fetch delivery history');
    }
  });

  // Per-subscription delivery stats
  app.get('/subscriptions/:id/deliveries/stats', requireAuth, rateLimit, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        `SELECT
            COUNT(*)::int AS total_deliveries,
            COUNT(*) FILTER (WHERE status = 'success')::int AS successful,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
            COUNT(*) FILTER (WHERE status = 'retrying')::int AS retrying,
            COUNT(*) FILTER (WHERE status = 'dlq')::int AS dlq,
            ROUND(
                COUNT(*) FILTER (WHERE status = 'success')::numeric
                / NULLIF(COUNT(*), 0) * 100, 1
            ) AS success_rate,
            ROUND(AVG(response_time_ms) FILTER (WHERE response_time_ms IS NOT NULL))::int AS avg_response_time_ms,
            MAX(created_at) AS last_delivery_at,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS deliveries_24h,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS deliveries_7d
         FROM delivery_events
         WHERE subscription_id = $1 AND organization_id = $2`,
        [id, req.auth.organizationId]
      );
      const stats = result.rows[0];
      res.status(200).json({
        total_deliveries: stats.total_deliveries,
        successful: stats.successful,
        failed: stats.failed,
        retrying: stats.retrying,
        dlq: stats.dlq,
        success_rate: parseFloat(stats.success_rate) || 0,
        avg_response_time_ms: stats.avg_response_time_ms,
        last_delivery_at: stats.last_delivery_at,
        deliveries_24h: stats.deliveries_24h,
        deliveries_7d: stats.deliveries_7d,
      });
    } catch (err) {
      log.error('Error fetching delivery stats:', err);
      errorResponse(res, 500, 'Failed to fetch delivery stats');
    }
  });

  // Time-series buckets for the dashboard sparklines.
  //
  // GET /deliveries/timeseries?range=24h|7d&buckets=24 (default 24h, 24 buckets)
  //
  // Returns N evenly-spaced buckets covering the requested range,
  // org-scoped, with success / failed / total counts per bucket so
  // the dashboard can render a trend without re-aggregating client-
  // side. Empty buckets are emitted as zero so the X-axis is dense.
  app.get('/deliveries/timeseries', requireAuth, rateLimit, async (req, res) => {
    const range = req.query.range === '7d' ? '7 days' : '24 hours';
    const numBuckets = Math.min(168, Math.max(2, parseInt(req.query.buckets, 10) || 24));
    try {
      // Postgres generate_series + width_bucket would also work, but
      // the explicit start/end + interval arithmetic keeps the SQL
      // legible and lets pg_advisory clients reason about it.
      const result = await pool.query(
        `WITH params AS (
            SELECT
              NOW() - $1::interval AS start_ts,
              NOW()                  AS end_ts,
              $2::int                AS n
         ),
         bucket_edges AS (
            SELECT
              g AS idx,
              start_ts + (g::numeric * (end_ts - start_ts) / n) AS bucket_start,
              start_ts + ((g+1)::numeric * (end_ts - start_ts) / n) AS bucket_end
            FROM params, generate_series(0, params.n - 1) g
         )
         SELECT
           e.idx,
           e.bucket_start,
           COUNT(de.delivery_id) FILTER (WHERE de.status = 'success')::int AS successful,
           COUNT(de.delivery_id) FILTER (WHERE de.status IN ('failed','dlq'))::int AS failed,
           COUNT(de.delivery_id)::int AS total
         FROM bucket_edges e
         LEFT JOIN delivery_events de
           ON de.organization_id = $3
          AND de.created_at >= e.bucket_start
          AND de.created_at <  e.bucket_end
         GROUP BY e.idx, e.bucket_start
         ORDER BY e.idx`,
        [range, numBuckets, req.auth.organizationId]
      );
      res.status(200).json({
        range,
        buckets: result.rows.map(r => ({
          bucket_start: r.bucket_start,
          successful: r.successful,
          failed: r.failed,
          total: r.total,
        })),
      });
    } catch (err) {
      log.error('Error fetching delivery timeseries:', err);
      errorResponse(res, 500, 'Failed to fetch delivery timeseries');
    }
  });

  // Org-wide delivery stats
  app.get('/deliveries/stats', requireAuth, rateLimit, async (req, res) => {
    try {
      const result = await pool.query(
        `SELECT
            COUNT(*)::int AS total_deliveries,
            COUNT(*) FILTER (WHERE status = 'success')::int AS successful,
            COUNT(*) FILTER (WHERE status = 'failed' OR status = 'dlq')::int AS failed,
            ROUND(
                COUNT(*) FILTER (WHERE status = 'success')::numeric
                / NULLIF(COUNT(*), 0) * 100, 1
            ) AS success_rate,
            ROUND(AVG(response_time_ms) FILTER (WHERE response_time_ms IS NOT NULL))::int AS avg_response_time_ms,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS deliveries_24h,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS deliveries_7d
         FROM delivery_events
         WHERE organization_id = $1`,
        [req.auth.organizationId]
      );
      const stats = result.rows[0];
      res.status(200).json({
        total_deliveries: stats.total_deliveries,
        successful: stats.successful,
        failed: stats.failed,
        success_rate: parseFloat(stats.success_rate) || 0,
        avg_response_time_ms: stats.avg_response_time_ms,
        deliveries_24h: stats.deliveries_24h,
        deliveries_7d: stats.deliveries_7d,
      });
    } catch (err) {
      log.error('Error fetching global delivery stats:', err);
      errorResponse(res, 500, 'Failed to fetch delivery stats');
    }
  });

  // List org's subscriptions.
  //
  // Backwards-compatible response shape:
  //   - No `?page=` provided  -> array of subscriptions (legacy).
  //   - `?page=N` provided    -> { subscriptions, total, page, pages }
  //                              envelope, paginated server-side.
  // Optional `?limit=L` (default 25, max 100) controls page size.
  // Optional `?search=q` does a case-insensitive ILIKE across
  // subscription_id / webhook_url / args->>'endpoint_url'.
  //
  // The dashboard's subscription list opts into the paginated form so
  // a 10k-subscription org doesn't pay 5MB of JSON per refresh.
  app.get('/subscriptions', requireAuth, rateLimit, async (req, res) => {
    const paged = req.query.page !== undefined;
    try {
      if (!paged) {
        // Legacy path — full array.
        const result = await pool.query(
          'SELECT * FROM subscriptions WHERE organization_id = $1 ORDER BY created_at DESC',
          [req.auth.organizationId]
        );
        return res.status(200).json(result.rows.map(withoutSecret));
      }

      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
      const offset = (page - 1) * limit;
      const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';

      const params = [req.auth.organizationId];
      let where = 'WHERE organization_id = $1';
      if (search.length > 0) {
        params.push(`%${search}%`);
        where +=
          ` AND (subscription_id::text ILIKE $${params.length}` +
          ` OR webhook_url ILIKE $${params.length}` +
          ` OR (args->>'endpoint_url') ILIKE $${params.length})`;
      }

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS total FROM subscriptions ${where}`,
        params
      );
      const total = countResult.rows[0].total;

      const dataParams = [...params, limit, offset];
      const dataResult = await pool.query(
        `SELECT * FROM subscriptions ${where}
         ORDER BY created_at DESC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        dataParams
      );

      res.status(200).json({
        subscriptions: dataResult.rows.map(withoutSecret),
        total,
        page,
        pages: Math.max(1, Math.ceil(total / limit)),
      });
    } catch (err) {
      log.error(err);
      errorResponse(res, 500, 'Failed to retrieve subscriptions');
    }
  });

  // Admin: delete all subscriptions across all orgs.
  //
  // Cleans up the full chain so connectors don't keep stale connections
  // open and dispatchers don't keep retrying:
  //   1. DELETE rows from subscriptions (delivery_events / pending_retries
  //      cascade via FK).
  //   2. DELETE every sub:* Redis key (so connector reload from Redis
  //      doesn't resurrect them, and the live status endpoint doesn't
  //      report them as connected).
  //   3. Publish unsubscribe_events for each so the connectors close
  //      their open upstream connections — without this, a wipe leaves
  //      every active GraphQL/WebSocket source connected to a sub that
  //      no longer exists.
  app.delete('/subscriptions', requireAdminKey, async (req, res) => {
    try {
      const deleted = await pool.query('DELETE FROM subscriptions RETURNING subscription_id');

      // Best-effort: clear sub:* keys + emit unsubscribe events. We
      // don't fail the API call if any of these fail (operator wanted
      // a wipe; rolling back the DB delete is worse).
      let cursor = 0;
      const cacheKeys = [];
      do {
        const scan = await redisClient.scan(cursor, {
          MATCH: SUBSCRIPTION_KEY_PATTERN,
          COUNT: 100,
        });
        cursor = scan.cursor;
        cacheKeys.push(...scan.keys);
      } while (cursor !== 0);
      if (cacheKeys.length > 0) {
        await Promise.allSettled(cacheKeys.map(k => redisClient.del(k)));
      }

      if (deleted.rowCount > 0) {
        const events = deleted.rows.map(r => ({
          key: r.subscription_id,
          value: r.subscription_id,
        }));
        try {
          await producer.send({ topic: 'unsubscribe_events', messages: events });
        } catch (kafkaErr) {
          log.error('Admin wipe: failed to publish unsubscribe_events', kafkaErr.message);
        }
      }

      log.info(`Admin wipe: rows=${deleted.rowCount}, redis_keys_cleared=${cacheKeys.length}`);
      res.status(200).json({
        message: 'All subscriptions deleted',
        deleted: deleted.rowCount,
        redis_keys_cleared: cacheKeys.length,
      });
    } catch (err) {
      log.error('Error deleting all subscriptions:', err);
      errorResponse(res, 500, 'Failed to delete subscriptions');
    }
  });

  // Get subscription by id (org-scoped)
  app.get('/subscriptions/:id', requireAuth, rateLimit, async (req, res) => {
    const { id } = req.params;
    try {
      const result = await pool.query(
        'SELECT * FROM subscriptions WHERE subscription_id = $1 AND organization_id = $2',
        [id, req.auth.organizationId]
      );
      if (result.rows.length > 0) {
        res.status(200).json(withoutSecret(result.rows[0]));
      } else {
        errorResponse(res, 404, 'Subscription not found');
      }
    } catch (err) {
      log.error(err);
      errorResponse(res, 500, 'Failed to retrieve subscription');
    }
  });

  // Update subscription (org-scoped) — publishes update_events on success
  app.put('/subscriptions/:id', requireAuth, rateLimit, async (req, res) => {
    const { id } = req.params;
    const validationErrors = validateSubscriptionInput(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, 400, validationErrors.join('; '));
    }
    const { connection_type, args, webhook_url } = req.body;
    try {
      const result = await pool.query(
        `UPDATE subscriptions
           SET connection_type = $1, args = $2, webhook_url = $3
           WHERE subscription_id = $4 AND organization_id = $5
           RETURNING *`,
        [connection_type, args, webhook_url, id, req.auth.organizationId]
      );
      if (result.rows.length === 0) {
        return errorResponse(res, 404, 'Subscription not found');
      }
      await redisClient.set(subscriptionCacheKey(id), JSON.stringify(result.rows[0]));
      try {
        // key=id so all events for this subscription land on the same
        // partition → the same connector pod handles them in order.
        await producer.send({
          topic: 'update_events',
          messages: [{ key: id, value: id }],
        });
      } catch (kafkaErr) {
        // Symmetric with POST /subscribe: signal the failure to the
        // caller. The DB and Redis are now ahead of the connector
        // (which won't receive the update_events message and will
        // keep using the old config). Returning 200 here would let
        // the dashboard claim "saved" while the live connection
        // silently runs the previous config.
        log.error(`[Update API] - Failed to publish update_events for ${id}`, kafkaErr);
        return errorResponse(
          res,
          500,
          'Subscription updated in DB but Kafka publish failed; ' +
            'connector still running previous config until reconciled'
        );
      }
      res.status(200).json(withoutSecret(result.rows[0]));
    } catch (err) {
      log.error(err);
      errorResponse(res, 500, 'Failed to update subscription');
    }
  });

  // Create subscription
  app.post('/subscribe', requireAuth, rateLimit, subscriptionQuota, async (req, res) => {
    const validationErrors = validateSubscriptionInput(req.body);
    if (validationErrors.length > 0) {
      return errorResponse(res, 400, validationErrors.join('; '));
    }
    const { connection_type, args, webhook_url } = req.body;
    const subscriptionId = uuidv4();
    const webhookSecret = crypto.randomBytes(32).toString('hex');

    log.info(
      `[Subscribe API] - Incoming request to create subscription. Connection Type: ${connection_type}, Webhook URL: ${webhook_url}, Org: ${req.auth.organizationId}`
    );

    try {
      const result = await pool.query(
        `INSERT INTO subscriptions
           (subscription_id, organization_id, connection_type, args, webhook_url, webhook_secret)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [subscriptionId, req.auth.organizationId, connection_type, args, webhook_url, webhookSecret]
      );

      log.info(
        `[Subscribe API] - Subscription saved to PostgreSQL. Subscription ID: ${subscriptionId}`
      );
      await redisClient.set(subscriptionCacheKey(subscriptionId), JSON.stringify(result.rows[0]));
      log.info(`[Subscribe API] - Subscription saved to Redis. Subscription ID: ${subscriptionId}`);

      try {
        await producer.send({
          topic: 'subscription_events',
          messages: [{ key: subscriptionId, value: subscriptionId }],
        });
        log.info(
          `[Subscribe API] - Subscription published to Kafka. Subscription ID: ${subscriptionId}`
        );
      } catch (kafkaErr) {
        log.error(
          `[Subscribe API] - Failed to publish subscription_events for ${subscriptionId}`,
          kafkaErr
        );
        return errorResponse(
          res,
          500,
          'Subscription created in DB but Kafka publish failed; connector will not open until reconciled'
        );
      }

      res.status(201).json({
        subscriptionId,
        webhook_secret: webhookSecret,
        message: 'Subscription created. Save webhook_secret — it is shown only once.',
      });
    } catch (err) {
      log.error(`[Subscribe API] - Error creating subscription:`, err);
      errorResponse(res, 500, 'Failed to create subscription');
    }
  });

  // Bulk-create subscriptions.
  //
  // POST /subscribe/bulk
  //   body: { subscriptions: [ { connection_type, args, webhook_url }, ... ] }
  //
  // - Capped at MAX_BULK_SIZE per request so a single call can't blow
  //   past the org quota by orders of magnitude.
  // - Per-entry validation: invalid entries return { index, error };
  //   valid entries proceed independently. The whole call is NOT
  //   transactional — partial success is allowed (matches the
  //   "import 100 from a JSON; 3 had bad URLs, ignore those" UX).
  // - Quota: takes the same advisory lock the per-request quota
  //   middleware uses; counts current usage + bulk size against the
  //   org's effective limit. 429 if the request would put us over.
  // - Each successful entry produces its own webhook_secret, returned
  //   ONCE in the response.
  const MAX_BULK_SIZE = 100;
  app.post('/subscribe/bulk', requireAuth, rateLimit, async (req, res) => {
    const { subscriptions: entries } = req.body || {};
    if (!Array.isArray(entries) || entries.length === 0) {
      return errorResponse(res, 400, 'subscriptions must be a non-empty array');
    }
    if (entries.length > MAX_BULK_SIZE) {
      return errorResponse(
        res,
        400,
        `Maximum ${MAX_BULK_SIZE} subscriptions per request (got ${entries.length})`
      );
    }

    // Per-org advisory lock for the duration of the request — same
    // pattern as the per-request quota middleware. Two parallel bulks
    // for the same org serialize.
    const lockClient = await pool.connect();
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await lockClient.query('SELECT pg_advisory_unlock($1, hashtext($2::text))', [
          ADVISORY_LOCK_KEY_QUOTAS,
          req.auth.organizationId,
        ]);
      } catch (e) {
        log.error('Bulk advisory unlock failed', e.message);
      } finally {
        lockClient.release();
      }
    };
    res.on('finish', release);
    res.on('close', release);

    try {
      // Same lock-key as the subscriptionQuota middleware so a
      // concurrent single-row /subscribe and a bulk import for the
      // same org serialize against each other.
      await lockClient.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [
        ADVISORY_LOCK_KEY_QUOTAS,
        req.auth.organizationId,
      ]);

      const usageRow = await lockClient.query(
        `SELECT
            (SELECT COUNT(*)::int FROM subscriptions WHERE organization_id = $1) AS used,
            (SELECT max_subscriptions FROM organizations WHERE id = $1) AS override`,
        [req.auth.organizationId]
      );
      const used = usageRow.rows[0].used;
      const envLimit = parseInt(process.env.ORG_MAX_SUBSCRIPTIONS, 10) || 100;
      const effectiveLimit =
        usageRow.rows[0].override != null ? usageRow.rows[0].override : envLimit;
      if (used + entries.length > effectiveLimit) {
        await release();
        return res.status(429).json({
          error: 'Subscription quota would be exceeded',
          quota: 'subscriptions',
          used,
          limit: effectiveLimit,
          requested: entries.length,
        });
      }

      const results = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        const validationErrors = validateSubscriptionInput(entry);
        if (validationErrors.length > 0) {
          results.push({ index: i, error: validationErrors.join('; ') });
          continue;
        }
        const subscriptionId = uuidv4();
        const webhookSecret = crypto.randomBytes(32).toString('hex');
        try {
          const insRes = await lockClient.query(
            `INSERT INTO subscriptions
               (subscription_id, organization_id, connection_type, args, webhook_url, webhook_secret)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [
              subscriptionId,
              req.auth.organizationId,
              entry.connection_type,
              entry.args,
              entry.webhook_url,
              webhookSecret,
            ]
          );
          await redisClient.set(
            subscriptionCacheKey(subscriptionId),
            JSON.stringify(insRes.rows[0])
          );
          try {
            await producer.send({
              topic: 'subscription_events',
              messages: [{ key: subscriptionId, value: subscriptionId }],
            });
          } catch (kafkaErr) {
            // Same trade-off as per-row /subscribe: DB is the source
            // of truth. We log + record the entry as successful since
            // the row is in DB; an operator can reconcile by running
            // /redis/reload + a Kafka backfill if needed.
            log.error(
              `[Bulk Subscribe] - Kafka publish failed for ${subscriptionId}`,
              kafkaErr.message
            );
          }
          results.push({ index: i, subscriptionId, webhook_secret: webhookSecret });
        } catch (err) {
          log.error(`[Bulk Subscribe] - Failed entry ${i}`, err.message);
          results.push({ index: i, error: 'Insert failed' });
        }
      }

      const successful = results.filter(r => r.subscriptionId).length;
      const failed = results.length - successful;
      res.status(201).json({
        results,
        summary: { total: entries.length, successful, failed },
      });
    } catch (err) {
      log.error('[Bulk Subscribe] - Error processing bulk request:', err);
      errorResponse(res, 500, 'Failed to process bulk subscribe');
    }
  });

  // Unsubscribe (org-scoped)
  app.post('/unsubscribe', requireAuth, rateLimit, async (req, res) => {
    const { subscription_id } = req.body;
    if (!subscription_id || typeof subscription_id !== 'string') {
      return errorResponse(res, 400, 'subscription_id is required');
    }
    log.info(
      `[Unsubscribe API] - Incoming request to delete subscription. Subscription ID: ${subscription_id}, Org: ${req.auth.organizationId}`
    );
    try {
      const deleteResult = await pool.query(
        `DELETE FROM subscriptions WHERE subscription_id = $1 AND organization_id = $2`,
        [subscription_id, req.auth.organizationId]
      );
      if (deleteResult.rowCount === 0) {
        return errorResponse(res, 404, 'Subscription not found');
      }
      log.info(
        `[Unsubscribe API] - Subscription deleted from PostgreSQL. Subscription ID: ${subscription_id}`
      );
      try {
        await producer.send({
          topic: 'unsubscribe_events',
          messages: [{ key: subscription_id, value: subscription_id }],
        });
      } catch (kafkaErr) {
        log.error(
          `[Unsubscribe API] - Failed to publish unsubscribe_events for ${subscription_id}`,
          kafkaErr
        );
      }
      res.status(200).json({ message: 'Unsubscribed successfully' });
    } catch (err) {
      log.error(`[Unsubscribe API] - Error deleting subscription:`, err);
      errorResponse(res, 500, 'Failed to unsubscribe');
    }
  });

  // --- Admin/Debug endpoints ---

  app.post('/redis', requireAdminKey, async (req, res) => {
    const { key, value } = req.body;
    if (!key || !value) {
      return errorResponse(res, 400, 'Key and value are required');
    }
    try {
      await redisClient.set(key, JSON.stringify(value));
      res.status(200).json({ message: `Key '${key}' added to Redis with value`, key, value });
    } catch (err) {
      log.error('Error adding value to Redis', err);
      errorResponse(res, 500, 'Failed to add value to Redis');
    }
  });

  app.get('/redis', requireAdminKey, async (req, res) => {
    try {
      const keys = [];
      let cursor = 0;
      do {
        const result = await redisClient.scan(cursor, { COUNT: 100 });
        cursor = result.cursor;
        keys.push(...result.keys);
      } while (cursor !== 0);

      if (keys.length === 0) {
        return res.status(200).json({ message: 'No data found in Redis' });
      }

      const multi = redisClient.multi();
      keys.forEach(key => {
        multi.get(key);
      });

      const replies = await multi.exec();
      const result = keys.reduce((obj, key, index) => {
        try {
          obj[key] = JSON.parse(replies[index]);
        } catch {
          obj[key] = replies[index];
        }
        return obj;
      }, {});
      res.status(200).json(result);
    } catch (err) {
      log.error('Error retrieving Redis data', err);
      errorResponse(res, 500, 'Failed to retrieve data from Redis');
    }
  });

  app.get('/redis/:key', requireAdminKey, async (req, res) => {
    const { key } = req.params;
    try {
      const data = await redisClient.get(key);
      if (data) {
        try {
          res.status(200).json(JSON.parse(data));
        } catch {
          res.status(200).json({ value: data });
        }
      } else {
        errorResponse(res, 404, 'Key not found');
      }
    } catch (err) {
      log.error('Error retrieving Redis key', err);
      errorResponse(res, 500, 'Failed to retrieve data from Redis');
    }
  });

  app.delete('/redis/:key', requireAdminKey, async (req, res) => {
    const { key } = req.params;
    try {
      const result = await redisClient.del(key);
      if (result === 1) {
        res.status(200).json({ message: `Key '${key}' deleted from Redis` });
      } else {
        errorResponse(res, 404, `Key '${key}' not found in Redis`);
      }
    } catch (err) {
      log.error('Error deleting Redis key', err);
      errorResponse(res, 500, 'Failed to delete key from Redis');
    }
  });

  app.delete('/redis', requireAdminKey, async (req, res) => {
    try {
      await redisClient.flushAll();
      res.status(200).json({ message: 'Redis cache flushed' });
    } catch (err) {
      log.error('Error flushing Redis cache', err);
      errorResponse(res, 500, 'Failed to flush Redis cache');
    }
  });

  // POST /redis/reload — repopulate the subscription cache from
  // PostgreSQL.
  //
  // Important: we DON'T flushAll any more — that wiped pending_retries
  // queue rows in flight (they're stored in PG, but the dispatcher
  // looks up webhook URL + secret from Redis at retry time, so a
  // flush would orphan in-flight retries to DLQ). Instead we delete
  // only the namespaced sub:* keys, then re-SET them. Rate-limit and
  // any other Redis-resident state is preserved.
  app.post('/redis/reload', requireAdminKey, async (req, res) => {
    try {
      const result = await pool.query('SELECT * FROM subscriptions');
      // Delete existing sub:* keys without touching anything else.
      let cursor = 0;
      const toDelete = [];
      do {
        const scan = await redisClient.scan(cursor, {
          MATCH: SUBSCRIPTION_KEY_PATTERN,
          COUNT: 100,
        });
        cursor = scan.cursor;
        toDelete.push(...scan.keys);
      } while (cursor !== 0);
      if (toDelete.length > 0) {
        await Promise.all(toDelete.map(k => redisClient.del(k)));
      }
      for (const subscription of result.rows) {
        await redisClient.set(
          subscriptionCacheKey(subscription.subscription_id),
          JSON.stringify(subscription)
        );
      }
      res.status(200).json({
        message: 'Redis subscription cache reloaded from PostgreSQL',
        cleared: toDelete.length,
        loaded: result.rows.length,
      });
    } catch (err) {
      log.error('Error reloading Redis cache', err);
      errorResponse(res, 500, 'Failed to reload Redis from PostgreSQL');
    }
  });

  app.get('/kafka/topics', requireAdminKey, async (req, res) => {
    try {
      const topics = await admin.listTopics();
      res.status(200).json({ topics });
    } catch (err) {
      log.error('Failed to list Kafka topics', err);
      errorResponse(res, 500, 'Failed to list Kafka topics');
    }
  });

  app.delete('/kafka/topics/:topic', requireAdminKey, async (req, res) => {
    const { topic } = req.params;
    try {
      await admin.deleteTopics({ topics: [topic] });
      res.status(200).json({ message: `Kafka topic ${topic} deleted` });
    } catch (err) {
      log.error(`Failed to delete Kafka topic ${topic}`, err);
      errorResponse(res, 500, `Failed to delete Kafka topic ${topic}`);
    }
  });

  return app;
}

module.exports = { createApp, withoutSecret, validateSubscriptionInput };
