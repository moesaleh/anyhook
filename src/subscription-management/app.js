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
const { makeSubscriptionQuotaCheck, makeApiKeyQuotaCheck } = require('../lib/quotas');
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

  // Health check
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

  // List org's subscriptions
  app.get('/subscriptions', requireAuth, rateLimit, async (req, res) => {
    try {
      const result = await pool.query(
        'SELECT * FROM subscriptions WHERE organization_id = $1 ORDER BY created_at DESC',
        [req.auth.organizationId]
      );
      res.status(200).json(result.rows.map(withoutSecret));
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
        log.error(`[Update API] - Failed to publish update_events for ${id}`, kafkaErr);
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
