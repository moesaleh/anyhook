require('dotenv').config({ path: './.env' });
process.env.KAFKAJS_NO_PARTITIONER_WARNING = '1';
const express = require('express');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const redis = require('@redis/client');
const { Kafka, logLevel } = require('kafkajs');
const { exec } = require('child_process'); // For running migrations
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { mountAuthRoutes } = require('./auth');

function parseBrokers(envValue) {
  return (envValue || 'localhost:9092')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

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

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Enable CORS for the dashboard frontend. Credentials enabled so the
// session cookie travels — Access-Control-Allow-Origin therefore CANNOT
// be '*'; the dashboard origin must be set explicitly via DASHBOARD_URL.
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

// Get port from environment variable or use default
const PORT = process.env.PORT || 3001;

// PostgreSQL connection with pool config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// Redis connection
const redisClient = redis.createClient({
  url: process.env.REDIS_URL,
});

// Connect Redis client
redisClient.on('error', err => console.error('Redis Client Error', err));

(async () => {
  await redisClient.connect(); // Ensure Redis client is connected
  console.log('Redis client connected');
})();

// Initialize Kafka client (kafkajs)
const kafka = new Kafka({
  clientId: 'subscription-management',
  brokers: parseBrokers(process.env.KAFKA_HOST),
  logLevel: logLevel.WARN,
});
const producer = kafka.producer({ allowAutoTopicCreation: false });
const admin = kafka.admin();

// --- Input validation helpers ---

const VALID_CONNECTION_TYPES = ['graphql', 'websocket'];

// Allow loopback/private targets only when explicitly opted in (dev convenience).
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true';

/**
 * Returns true if the hostname is a loopback, private, link-local, or
 * cloud-metadata address. Used to block SSRF against internal infra
 * (Redis, Kafka, the API itself, AWS/GCP IMDS at 169.254.169.254, etc).
 */
function isPrivateOrLoopbackHost(hostname) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost')) return true;

  // IPv6: loopback, unspecified, link-local (fe80::/10), unique-local (fc00::/7)
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  // IPv4-mapped IPv6 → fall through to the v4 check below
  const v4MappedMatch = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4Candidate = v4MappedMatch ? v4MappedMatch[1] : h;

  const ipv4Match = v4Candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + IMDS
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }

  return false;
}

function isValidUrl(str, { allowedProtocols = ['http:', 'https:', 'ws:', 'wss:'] } = {}) {
  try {
    const url = new URL(str);
    if (!allowedProtocols.includes(url.protocol)) return false;
    if (!ALLOW_PRIVATE_TARGETS && isPrivateOrLoopbackHost(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
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

// --- Consistent error response helper ---

function errorResponse(res, statusCode, message) {
  return res.status(statusCode).json({ error: message });
}

// --- Admin-key middleware (fails closed: denies if ADMIN_API_KEY is unset) ---

function requireAdminKey(req, res, next) {
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) {
    return errorResponse(res, 503, 'Admin endpoints disabled: ADMIN_API_KEY not configured');
  }
  if (req.headers['x-admin-key'] !== adminKey) {
    return errorResponse(res, 403, 'Forbidden: invalid or missing admin key');
  }
  next();
}

// Mount auth + tenancy routes (/auth/*, /organizations/*) and pull
// requireAuth middleware so the subscription/delivery endpoints below
// can scope to the caller's org.
const { requireAuth } = mountAuthRoutes(app, { pool });

// Health check endpoint
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

// Get subscription status (checks Redis cache for live connection state)
app.get('/subscriptions/:id/status', requireAuth, async (req, res) => {
  const { id } = req.params;
  try {
    // Check PostgreSQL for the subscription record (status only — never the secret)
    const dbResult = await pool.query(
      'SELECT subscription_id, status, created_at FROM subscriptions WHERE subscription_id = $1 AND organization_id = $2',
      [id, req.auth.organizationId]
    );
    if (dbResult.rows.length === 0) {
      return errorResponse(res, 404, 'Subscription not found');
    }
    const subscription = dbResult.rows[0];

    // Check Redis cache — presence means the connector service has it loaded
    const cached = await redisClient.get(id);
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
    console.error('Error checking subscription status:', err);
    errorResponse(res, 500, 'Failed to check subscription status');
  }
});

// Get status for all subscriptions (bulk) — uses SCAN instead of KEYS
app.get('/subscriptions/status/all', requireAuth, async (req, res) => {
  try {
    const dbResult = await pool.query(
      'SELECT subscription_id, status FROM subscriptions WHERE organization_id = $1',
      [req.auth.organizationId]
    );

    // Use SCAN for safe iteration instead of KEYS *
    const connectedIds = new Set();
    let cursor = 0;
    do {
      const result = await redisClient.scan(cursor, { COUNT: 100 });
      cursor = result.cursor;
      for (const key of result.keys) {
        connectedIds.add(key);
      }
    } while (cursor !== 0);

    const statuses = dbResult.rows.map(row => ({
      subscription_id: row.subscription_id,
      db_status: row.status,
      connected: connectedIds.has(row.subscription_id),
    }));

    res.status(200).json({
      statuses,
      checked_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error checking statuses:', err);
    errorResponse(res, 500, 'Failed to check subscription statuses');
  }
});

// Delivery Events: Get delivery history for a subscription (paginated, filterable)
app.get('/subscriptions/:id/deliveries', requireAuth, async (req, res) => {
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

    // Get total count for pagination
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM delivery_events ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    // Get paginated results
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
    console.error('Error fetching deliveries:', err);
    errorResponse(res, 500, 'Failed to fetch delivery history');
  }
});

// Delivery Events: Get aggregated stats for a subscription
app.get('/subscriptions/:id/deliveries/stats', requireAuth, async (req, res) => {
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
    console.error('Error fetching delivery stats:', err);
    errorResponse(res, 500, 'Failed to fetch delivery stats');
  }
});

// Delivery Events: Get aggregated delivery stats for the active organization
app.get('/deliveries/stats', requireAuth, async (req, res) => {
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
    console.error('Error fetching global delivery stats:', err);
    errorResponse(res, 500, 'Failed to fetch delivery stats');
  }
});

// PostgreSQL: Get all subscriptions for the active organization
app.get('/subscriptions', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM subscriptions WHERE organization_id = $1 ORDER BY created_at DESC',
      [req.auth.organizationId]
    );
    res.status(200).json(result.rows.map(withoutSecret));
  } catch (err) {
    console.error(err);
    errorResponse(res, 500, 'Failed to retrieve subscriptions');
  }
});

// PostgreSQL: Delete all subscriptions (admin-only, requires X-Admin-Key header)
app.delete('/subscriptions', requireAdminKey, async (req, res) => {
  try {
    // Delete all subscriptions from PostgreSQL
    const result = await pool.query('DELETE FROM subscriptions RETURNING *');

    if (result.rowCount > 0) {
      console.log(`All subscriptions deleted successfully. Deleted rows: ${result.rowCount}`);
      res
        .status(200)
        .json({ message: 'All subscriptions deleted successfully', deleted: result.rowCount });
    } else {
      errorResponse(res, 404, 'No subscriptions found to delete');
    }
  } catch (err) {
    console.error('Error deleting all subscriptions:', err);
    errorResponse(res, 500, 'Failed to delete subscriptions');
  }
});

// PostgreSQL: Get subscription by ID (scoped to caller's org)
app.get('/subscriptions/:id', requireAuth, async (req, res) => {
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
    console.error(err);
    errorResponse(res, 500, 'Failed to retrieve subscription');
  }
});

// PostgreSQL: Update subscription (with validation, scoped to caller's org)
app.put('/subscriptions/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const validationErrors = validateSubscriptionInput(req.body);
  if (validationErrors.length > 0) {
    return errorResponse(res, 400, validationErrors.join('; '));
  }

  const { connection_type, args, webhook_url } = req.body;
  try {
    const queryText = `UPDATE subscriptions
                           SET connection_type = $1, args = $2, webhook_url = $3
                           WHERE subscription_id = $4 AND organization_id = $5
                           RETURNING *`;
    const values = [connection_type, args, webhook_url, id, req.auth.organizationId];
    const result = await pool.query(queryText, values);

    if (result.rows.length > 0) {
      // Update Redis cache as well (full row WITH secret — internal only)
      await redisClient.set(id, JSON.stringify(result.rows[0]));

      // Notify the connector to tear down + reopen with the new config.
      // Without this, the connector keeps the old upstream connection
      // open with the stale query/headers indefinitely.
      try {
        await producer.send({
          topic: 'update_events',
          messages: [{ value: id }],
        });
      } catch (kafkaErr) {
        console.error(`[Update API] - Failed to publish update_events for ${id}`, kafkaErr);
      }

      res.status(200).json(withoutSecret(result.rows[0]));
    } else {
      errorResponse(res, 404, 'Subscription not found');
    }
  } catch (err) {
    console.error(err);
    errorResponse(res, 500, 'Failed to update subscription');
  }
});

// PostgreSQL: Subscribe (Create Subscription, scoped to caller's org)
app.post('/subscribe', requireAuth, async (req, res) => {
  const validationErrors = validateSubscriptionInput(req.body);
  if (validationErrors.length > 0) {
    return errorResponse(res, 400, validationErrors.join('; '));
  }

  const { connection_type, args, webhook_url } = req.body;
  const subscriptionId = uuidv4();
  // 32 random bytes -> 64-char hex secret. Generated app-side so the value
  // is known at INSERT time and can be returned in the response. The DB
  // column has NOT NULL, no default, so this must be provided.
  const webhookSecret = crypto.randomBytes(32).toString('hex');

  console.log(
    `[Subscribe API] - Incoming request to create subscription. Connection Type: ${connection_type}, Webhook URL: ${webhook_url}, Org: ${req.auth.organizationId}`
  );

  try {
    // Save subscription to PostgreSQL (with org_id)
    const queryText = `INSERT INTO subscriptions
                            (subscription_id, organization_id, connection_type, args, webhook_url, webhook_secret)
                           VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`;
    const values = [
      subscriptionId,
      req.auth.organizationId,
      connection_type,
      args,
      webhook_url,
      webhookSecret,
    ];
    const result = await pool.query(queryText, values);

    console.log(
      `[Subscribe API] - Subscription saved to PostgreSQL. Subscription ID: ${subscriptionId}`
    );

    // Save subscription to Redis (with secret — connector + dispatcher
    // need it). Never returned via the public GET endpoints.
    await redisClient.set(subscriptionId, JSON.stringify(result.rows[0]));
    console.log(
      `[Subscribe API] - Subscription saved to Redis. Subscription ID: ${subscriptionId}`
    );

    // Publish subscription ID to Kafka. Awaited so we know the connector
    // will see it; if Kafka is down, we surface 500 rather than returning
    // 201 for a subscription the connector will never open.
    try {
      await producer.send({
        topic: 'subscription_events',
        messages: [{ value: subscriptionId }],
      });
      console.log(
        `[Subscribe API] - Subscription published to Kafka. Subscription ID: ${subscriptionId}`
      );
    } catch (kafkaErr) {
      console.error(
        `[Subscribe API] - Failed to publish subscription_events for ${subscriptionId}`,
        kafkaErr
      );
      return errorResponse(
        res,
        500,
        'Subscription created in DB but Kafka publish failed; connector will not open until reconciled'
      );
    }

    // ONLY place where webhook_secret is exposed to the API caller.
    // Receivers should store it and use it to verify X-AnyHook-Signature.
    res.status(201).json({
      subscriptionId,
      webhook_secret: webhookSecret,
      message: 'Subscription created. Save webhook_secret — it is shown only once.',
    });
  } catch (err) {
    console.error(`[Subscribe API] - Error creating subscription:`, err);
    errorResponse(res, 500, 'Failed to create subscription');
  }
});

// PostgreSQL: Unsubscribe (Delete Subscription, scoped to caller's org)
app.post('/unsubscribe', requireAuth, async (req, res) => {
  const { subscription_id } = req.body;

  if (!subscription_id || typeof subscription_id !== 'string') {
    return errorResponse(res, 400, 'subscription_id is required');
  }

  console.log(
    `[Unsubscribe API] - Incoming request to delete subscription. Subscription ID: ${subscription_id}, Org: ${req.auth.organizationId}`
  );

  try {
    // Delete subscription from PostgreSQL (org-scoped)
    const deleteResult = await pool.query(
      `DELETE FROM subscriptions WHERE subscription_id = $1 AND organization_id = $2`,
      [subscription_id, req.auth.organizationId]
    );
    if (deleteResult.rowCount === 0) {
      return errorResponse(res, 404, 'Subscription not found');
    }
    console.log(
      `[Unsubscribe API] - Subscription deleted from PostgreSQL. Subscription ID: ${subscription_id}`
    );

    // Publish to Kafka so the connector closes the upstream connection.
    // Best-effort: if Kafka is down we still return 200 (the row is gone
    // from PG; the connector will eventually reconcile via Redis sweep).
    try {
      await producer.send({
        topic: 'unsubscribe_events',
        messages: [{ value: subscription_id }],
      });
    } catch (kafkaErr) {
      console.error(
        `[Unsubscribe API] - Failed to publish unsubscribe_events for ${subscription_id}`,
        kafkaErr
      );
    }

    res.status(200).json({ message: 'Unsubscribed successfully' });
  } catch (err) {
    console.error(`[Unsubscribe API] - Error deleting subscription:`, err);
    errorResponse(res, 500, 'Failed to unsubscribe');
  }
});

// --- Admin/Debug endpoints (require X-Admin-Key; ADMIN_API_KEY must be configured) ---

// Redis: Add value to a key
app.post('/redis', requireAdminKey, async (req, res) => {
  const { key, value } = req.body;

  if (!key || !value) {
    return errorResponse(res, 400, 'Key and value are required');
  }

  try {
    await redisClient.set(key, JSON.stringify(value));
    res.status(200).json({ message: `Key '${key}' added to Redis with value`, key, value });
  } catch (err) {
    console.error('Error adding value to Redis', err);
    errorResponse(res, 500, 'Failed to add value to Redis');
  }
});

// Redis: Get all cached data (uses SCAN instead of KEYS)
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
    console.error('Error retrieving Redis data', err);
    errorResponse(res, 500, 'Failed to retrieve data from Redis');
  }
});

// Redis: Get by key
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
    console.error('Error retrieving Redis key', err);
    errorResponse(res, 500, 'Failed to retrieve data from Redis');
  }
});

// Redis: Delete by key
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
    console.error('Error deleting Redis key', err);
    errorResponse(res, 500, 'Failed to delete key from Redis');
  }
});

// Redis: Flush all cached data
app.delete('/redis', requireAdminKey, async (req, res) => {
  try {
    await redisClient.flushAll();
    res.status(200).json({ message: 'Redis cache flushed' });
  } catch (err) {
    console.error('Error flushing Redis cache', err);
    errorResponse(res, 500, 'Failed to flush Redis cache');
  }
});

// Redis: Reload cache from PostgreSQL
app.post('/redis/reload', requireAdminKey, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM subscriptions');
    await redisClient.flushAll(); // Clear Redis cache before reload

    for (const subscription of result.rows) {
      await redisClient.set(subscription.subscription_id, JSON.stringify(subscription));
    }

    res.status(200).json({ message: 'Redis cache reloaded from PostgreSQL' });
  } catch (err) {
    console.error('Error reloading Redis cache', err);
    errorResponse(res, 500, 'Failed to reload Redis from PostgreSQL');
  }
});

// Kafka: List all topics
app.get('/kafka/topics', requireAdminKey, async (req, res) => {
  try {
    const topics = await admin.listTopics();
    res.status(200).json({ topics });
  } catch (err) {
    console.error('Failed to list Kafka topics', err);
    errorResponse(res, 500, 'Failed to list Kafka topics');
  }
});

// Kafka: Delete topic
app.delete('/kafka/topics/:topic', requireAdminKey, async (req, res) => {
  const { topic } = req.params;
  try {
    await admin.deleteTopics({ topics: [topic] });
    res.status(200).json({ message: `Kafka topic ${topic} deleted` });
  } catch (err) {
    console.error(`Failed to delete Kafka topic ${topic}`, err);
    errorResponse(res, 500, `Failed to delete Kafka topic ${topic}`);
  }
});

// Function to apply database migrations
function applyMigrations() {
  return new Promise((resolve, reject) => {
    console.log('Applying database migrations...');
    exec('npm run migrate', (err, stdout, stderr) => {
      if (err) {
        console.error('Error applying migrations:', stderr);
        reject(err);
      } else {
        console.log('Migrations applied successfully:', stdout);
        resolve();
      }
    });
  });
}

// Function to create Kafka topics (idempotent — kafkajs returns false if
// the topic already exists, which is not an error)
async function createKafkaTopics() {
  const topicsToCreate = [
    { topic: 'subscription_events', numPartitions: 1, replicationFactor: 1 },
    { topic: 'unsubscribe_events', numPartitions: 1, replicationFactor: 1 },
    { topic: 'connection_events', numPartitions: 1, replicationFactor: 1 },
    { topic: 'update_events', numPartitions: 1, replicationFactor: 1 },
    { topic: 'dlq_events', numPartitions: 1, replicationFactor: 1 },
  ];
  const created = await admin.createTopics({
    topics: topicsToCreate,
    waitForLeaders: true,
  });
  console.log(`Kafka topics ready (created=${created}, idempotent)`);
}

// Run migrations, connect Kafka, create topics, then start the HTTP server.
let server;
(async () => {
  try {
    await applyMigrations();
    await admin.connect();
    await producer.connect();
    await createKafkaTopics();

    server = app.listen(PORT, () => {
      console.log(`Subscription Management Service listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start Subscription Management service:', err);
    process.exit(1);
  }
})();

// Graceful shutdown — close all clients in parallel, then exit. Use
// allSettled so a failing close doesn't leave others hanging.
async function shutdown(signal) {
  console.log(`Subscription management received ${signal}, shutting down gracefully...`);
  const forceExit = setTimeout(() => {
    console.error('Shutdown timeout exceeded, forcing exit');
    process.exit(1);
  }, 10000);
  try {
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.allSettled([
      producer.disconnect(),
      admin.disconnect(),
      redisClient.quit(),
      pool.end(),
    ]);
  } catch (err) {
    console.error('Error during shutdown:', err);
  } finally {
    clearTimeout(forceExit);
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
