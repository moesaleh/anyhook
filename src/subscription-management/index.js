require('dotenv').config({ path: './.env' });
const express = require('express');
const { Pool } = require('pg');
const redis = require('@redis/client');
const { KafkaClient, Producer, Admin } = require('kafka-node');
const { exec } = require('child_process'); // For running migrations
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());

// Enable CORS for the dashboard frontend
app.use((req, res, next) => {
    const allowedOrigin = process.env.DASHBOARD_URL || 'http://localhost:3000';
    res.header('Access-Control-Allow-Origin', allowedOrigin);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

// Get port from environment variable or use default
const PORT = process.env.PORT || 3001;

// PostgreSQL connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});

// Redis connection
const redisClient = redis.createClient({
    url: process.env.REDIS_URL,
});

// Connect Redis client
redisClient.on('error', (err) => console.error('Redis Client Error', err));

(async () => {
    await redisClient.connect(); // Ensure Redis client is connected
    console.log('Redis client connected');
})();

// Initialize Kafka client and create topics
const kafkaClient = new KafkaClient({ kafkaHost: process.env.KAFKA_HOST });
const producer = new Producer(kafkaClient);
const admin = new Admin(kafkaClient);  // Kafka Admin for topic management

producer.on('ready', async () => {
    console.log('Kafka producer ready');
    
    // Create required topics
    const topics = [
        { topic: 'connection_events', partitions: 1, replicationFactor: 1 },
        { topic: 'webhook_events', partitions: 1, replicationFactor: 1 },
        { topic: 'dead_letter_queue', partitions: 1, replicationFactor: 1 }
    ];

    producer.createTopics(topics, (error, result) => {
        if (error) {
            console.error('Error creating Kafka topics:', error);
            return;
        }
        console.log('Kafka topics created successfully:', result);
    });
});

producer.on('error', (err) => {
    console.error('Kafka producer error:', err);
});

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
app.get('/subscriptions/:id/status', async (req, res) => {
    const { id } = req.params;
    try {
        // Check PostgreSQL for the subscription record
        const dbResult = await pool.query('SELECT * FROM subscriptions WHERE subscription_id = $1', [id]);
        if (dbResult.rows.length === 0) {
            return res.status(404).json({ error: 'Subscription not found' });
        }
        const subscription = dbResult.rows[0];

        // Check Redis cache — presence means the connector service has it loaded
        const cached = await redisClient.get(id);
        const isConnected = cached !== null;

        res.status(200).json({
            subscription_id: id,
            db_status: subscription.status,
            connected: isConnected,
            cached_at: isConnected ? JSON.parse(cached).created_at : null,
            checked_at: new Date().toISOString(),
        });
    } catch (err) {
        console.error('Error checking subscription status:', err);
        res.status(500).json({ error: 'Failed to check subscription status' });
    }
});

// Get status for all subscriptions (bulk)
app.get('/subscriptions/status/all', async (req, res) => {
    try {
        const dbResult = await pool.query('SELECT subscription_id, status FROM subscriptions');
        const keys = await redisClient.keys('*');
        const connectedIds = new Set(keys);

        const statuses = dbResult.rows.map((row) => ({
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
        res.status(500).json({ error: 'Failed to check subscription statuses' });
    }
});

// Delivery Events: Get delivery history for a subscription (paginated, filterable)
app.get('/subscriptions/:id/deliveries', async (req, res) => {
    const { id } = req.params;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const status = req.query.status || 'all';
    const offset = (page - 1) * limit;

    try {
        let whereClause = 'WHERE subscription_id = $1';
        const params = [id];

        if (status !== 'all') {
            whereClause += ' AND status = $2';
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
        res.status(500).json({ error: 'Failed to fetch delivery history' });
    }
});

// Delivery Events: Get aggregated stats for a subscription
app.get('/subscriptions/:id/deliveries/stats', async (req, res) => {
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
             WHERE subscription_id = $1`,
            [id]
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
        res.status(500).json({ error: 'Failed to fetch delivery stats' });
    }
});

// Delivery Events: Get global delivery stats (for dashboard)
app.get('/deliveries/stats', async (req, res) => {
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
             FROM delivery_events`
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
        res.status(500).json({ error: 'Failed to fetch delivery stats' });
    }
});

// PostgreSQL: Get all subscriptions
app.get('/subscriptions', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM subscriptions');
        res.status(200).json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to retrieve subscriptions' });
    }
});

// PostgreSQL: Delete all subscriptions
app.delete('/subscriptions', async (req, res) => {
    try {
        // Delete all subscriptions from PostgreSQL
        const result = await pool.query('DELETE FROM subscriptions RETURNING *');

        if (result.rowCount > 0) {
            console.log(`All subscriptions deleted successfully. Deleted rows: ${result.rowCount}`);
            res.status(200).json({ message: 'All subscriptions deleted successfully', deleted: result.rowCount });
        } else {
            res.status(404).json({ message: 'No subscriptions found to delete' });
        }
    } catch (err) {
        console.error('Error deleting all subscriptions:', err);
        res.status(500).json({ error: 'Failed to delete subscriptions' });
    }
});

// PostgreSQL: Get subscription by ID
app.get('/subscriptions/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const result = await pool.query('SELECT * FROM subscriptions WHERE subscription_id = $1', [id]);
        if (result.rows.length > 0) {
            res.status(200).json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Subscription not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to retrieve subscription' });
    }
});

// PostgreSQL: Update subscription
app.put('/subscriptions/:id', async (req, res) => {
    const { id } = req.params;
    const { connection_type, args, webhook_url } = req.body;
    try {
        const queryText = `UPDATE subscriptions SET connection_type = $1, args = $2, webhook_url = $3 WHERE subscription_id = $4 RETURNING *`;
        const values = [connection_type, args, webhook_url, id];
        const result = await pool.query(queryText, values);

        if (result.rows.length > 0) {
            // Update Redis cache as well
            redisClient.set(id, JSON.stringify(result.rows[0]));
            res.status(200).json(result.rows[0]);
        } else {
            res.status(404).json({ error: 'Subscription not found' });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update subscription' });
    }
});

// PostgreSQL: Subscribe (Create Subscription)
app.post('/subscribe', async (req, res) => {
    const { connection_type, args, webhook_url } = req.body;
    const subscriptionId = uuidv4();

    console.log(`[Subscribe API] - Incoming request to create subscription. Connection Type: ${connection_type}, Webhook URL: ${webhook_url}`);

    try {
        console.log(`[Subscribe API] - Saving subscription to PostgreSQL. Subscription ID: ${subscriptionId}`);

        // Save subscription to PostgreSQL
        const queryText = `INSERT INTO subscriptions (subscription_id, connection_type, args, webhook_url) VALUES ($1, $2, $3, $4) RETURNING *`;
        const values = [subscriptionId, connection_type, args, webhook_url];
        const result = await pool.query(queryText, values);

        console.log(`[Subscribe API] - Subscription saved to PostgreSQL. Subscription ID: ${subscriptionId}, Data:`, result.rows[0]);

        // Save subscription to Redis
        await redisClient.set(subscriptionId, JSON.stringify(result.rows[0]));
        console.log(`[Subscribe API] - Subscription saved to Redis. Subscription ID: ${subscriptionId}`);

        // Publish subscription ID to Kafka
        const payloads = [{ topic: 'subscription_events', messages: subscriptionId }];
        producer.send(payloads, (err, data) => {
            if (err) {
                console.error(`[Subscribe API] - Error publishing subscription to Kafka. Subscription ID: ${subscriptionId}`, err);
            } else {
                console.log(`[Subscribe API] - Subscription published to Kafka successfully. Subscription ID: ${subscriptionId}, Data:`, data);
            }
        });

        res.status(201).json({ subscriptionId, message: 'Subscription created' });
    } catch (err) {
        console.error(`[Subscribe API] - Error creating subscription:`, err);
        res.status(500).json({ error: 'Failed to create subscription' });
    }
});

// PostgreSQL: Unsubscribe (Delete Subscription)
app.post('/unsubscribe', async (req, res) => {
    const { subscription_id } = req.body;

    console.log(`[Unsubscribe API] - Incoming request to delete subscription. Subscription ID: ${subscription_id}`);

    try {
        // Delete subscription from PostgreSQL
        await pool.query(`DELETE FROM subscriptions WHERE subscription_id = $1`, [subscription_id]);
        console.log(`[Unsubscribe API] - Subscription deleted from PostgreSQL. Subscription ID: ${subscription_id}`);

        // Publish subscription ID to Kafka
        const payloads = [{ topic: 'unsubscribe_events', messages: subscription_id }];
        producer.send(payloads, (err, data) => {
            if (err) {
                console.error(`[Unsubscribe API] - Error publishing unsubscription to Kafka. Subscription ID: ${subscription_id}`, err);
            } else {
                console.log(`[Unsubscribe API] - Unsubscription published to Kafka successfully. Subscription ID: ${subscription_id}, Data:`, data);
            }
        });

        res.status(200).json({ message: 'Unsubscribed successfully' });
    } catch (err) {
        console.error(`[Unsubscribe API] - Error deleting subscription:`, err);
        res.status(500).json({ error: 'Failed to unsubscribe' });
    }
});

// Redis: Add value to a key
app.post('/redis', async (req, res) => {
    const { key, value } = req.body;

    if (!key || !value) {
        return res.status(400).json({ error: 'Key and value are required' });
    }

    try {
        await redisClient.set(key, JSON.stringify(value));
        res.status(200).json({ message: `Key '${key}' added to Redis with value`, key, value });
    } catch (err) {
        console.error('Error adding value to Redis', err);
        res.status(500).json({ error: 'Failed to add value to Redis' });
    }
});

// Redis: Get all cached data
app.get('/redis', async (req, res) => {
    try {
        const keys = await redisClient.keys('*');
        if (keys.length === 0) {
            return res.status(200).json({ message: 'No data found in Redis' });
        }

        const multi = redisClient.multi();
        keys.forEach((key) => {
            multi.get(key);
        });

        const replies = await multi.exec();
        const result = keys.reduce((obj, key, index) => {
            obj[key] = JSON.parse(replies[index]);
            return obj;
        }, {});
        res.status(200).json(result);
    } catch (err) {
        console.error('Error retrieving Redis data', err);
        res.status(500).json({ error: 'Failed to retrieve data from Redis' });
    }
});

// Redis: Get by key
app.get('/redis/:key', async (req, res) => {
    const { key } = req.params;
    try {
        const data = await redisClient.get(key);
        if (data) {
            res.status(200).json(JSON.parse(data));
        } else {
            res.status(404).json({ error: 'Key not found' });
        }
    } catch (err) {
        console.error('Error retrieving Redis key', err);
        res.status(500).json({ error: 'Failed to retrieve data from Redis' });
    }
});

// Redis: Delete by key
app.delete('/redis/:key', async (req, res) => {
    const { key } = req.params;
    try {
        const result = await redisClient.del(key);
        if (result === 1) {
            res.status(200).json({ message: `Key '${key}' deleted from Redis` });
        } else {
            res.status(404).json({ message: `Key '${key}' not found in Redis` });
        }
    } catch (err) {
        console.error('Error deleting Redis key', err);
        res.status(500).json({ error: 'Failed to delete key from Redis' });
    }
});

// Redis: Flush all cached data
app.delete('/redis', async (req, res) => {
    try {
        await redisClient.flushAll();
        res.status(200).json({ message: 'Redis cache flushed' });
    } catch (err) {
        console.error('Error flushing Redis cache', err);
        res.status(500).json({ error: 'Failed to flush Redis cache' });
    }
});

// Redis: Reload cache from PostgreSQL
app.post('/redis/reload', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM subscriptions');
        await redisClient.flushAll(); // Clear Redis cache before reload

        for (const subscription of result.rows) {
            await redisClient.set(subscription.subscription_id, JSON.stringify(subscription));
        }

        res.status(200).json({ message: 'Redis cache reloaded from PostgreSQL' });
    } catch (err) {
        console.error('Error reloading Redis cache', err);
        res.status(500).json({ error: 'Failed to reload Redis from PostgreSQL' });
    }
});

// Kafka: List all topics
app.get('/kafka/topics', (req, res) => {
    admin.listTopics((err, data) => {
        if (err) {
            res.status(500).json({ error: 'Failed to list Kafka topics' });
        } else {
            const topics = Object.keys(data[1].metadata);
            res.status(200).json({ topics });
        }
    });
});

// Kafka: Delete topic
app.delete('/kafka/topics/:topic', (req, res) => {
    const { topic } = req.params;
    admin.delete([topic], (err, data) => {
        if (err) {
            res.status(500).json({ error: `Failed to delete Kafka topic ${topic}` });
        } else {
            res.status(200).json({ message: `Kafka topic ${topic} deleted` });
        }
    });
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

// Function to create Kafka topics
function createKafkaTopics() {
    return new Promise((resolve, reject) => {
        const topicsToCreate = [
            {
                topic: 'subscription_events',
                partitions: 1,
                replicationFactor: 1,
            },
            {
                topic: 'unsubscribe_events',
                partitions: 1,
                replicationFactor: 1,
            },
            {
                topic: 'connection_events',
                partitions: 1,
                replicationFactor: 1,
            },
        ];

        admin.createTopics(topicsToCreate, (err, result) => {
            if (err) {
                console.error('Error creating Kafka topics:', err);
                reject(err);
            } else {
                console.log('Kafka topics created successfully:', result);
                resolve();
            }
        });
    });
}

// Run migrations and create Kafka topics before starting the server
(async () => {
    try {
        await applyMigrations();
        await createKafkaTopics();

        // Start the server after successful migrations and topic creation
        app.listen(PORT, () => {
            console.log(`Subscription Management Service listening on port ${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start Subscription Management service:', err);
    }
})();