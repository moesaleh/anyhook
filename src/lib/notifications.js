/**
 * Notification dispatch — email + Slack incoming-webhook.
 *
 * The webhook-dispatcher calls dispatchNotification() after a DLQ
 * event is recorded. We look up enabled notification_preferences for
 * the org, then send to each in parallel via Promise.allSettled so
 * one channel failure doesn't block the others.
 *
 * Best-effort: errors are logged but never thrown back to the caller.
 * The DLQ Kafka publish has already succeeded; the dashboard banner
 * will pick up the new failed-count regardless of whether the
 * out-of-band notifications got through.
 */

const axios = require('axios');
const { createLogger } = require('./logger');

const log = createLogger('notifications');

/**
 * Format a Slack incoming-webhook payload from a notification event.
 * Slack accepts plain `{text, blocks?}` JSON. We use blocks for the
 * structured fields so the receiver can grep them quickly.
 */
function formatSlackPayload(event) {
  const lines = [
    `*Webhook delivery failed* — moved to DLQ after retries exhausted.`,
    `• Subscription: \`${event.subscriptionId}\``,
    `• Webhook URL: ${event.webhookUrl}`,
    `• Event: \`${event.eventId}\``,
    event.organizationName ? `• Organization: ${event.organizationName}` : null,
  ].filter(Boolean);
  return {
    text: `AnyHook: subscription ${event.subscriptionId.slice(0, 8)} delivery failed`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n') },
      },
    ],
  };
}

/**
 * Format an email body for a DLQ event.
 */
function formatEmailBody(event) {
  return [
    `A webhook delivery has been moved to the Dead Letter Queue after`,
    `exceeding the retry policy.`,
    ``,
    `Subscription: ${event.subscriptionId}`,
    `Webhook URL:  ${event.webhookUrl}`,
    `Event ID:     ${event.eventId}`,
    event.organizationName ? `Organization: ${event.organizationName}` : null,
    ``,
    `The original event has been published to the dlq_events Kafka topic`,
    `for downstream processing. Investigate via the AnyHook dashboard.`,
  ]
    .filter(line => line !== null)
    .join('\n');
}

async function sendEmailNotification(emailTransport, pref, event) {
  if (!emailTransport || !emailTransport.enabled) {
    return { delivered: false, reason: 'no_transport' };
  }
  return emailTransport.send({
    to: pref.destination,
    subject: `[AnyHook] DLQ — subscription ${event.subscriptionId.slice(0, 8)}`,
    text: formatEmailBody(event),
  });
}

async function sendSlackNotification(pref, event) {
  // Slack webhooks are user-supplied URLs; we already validated at
  // create-time that they're public-routable. axios timeouts cap the
  // worst case at 10s per webhook so a slow Slack workspace doesn't
  // stall the dispatcher.
  try {
    const res = await axios.post(pref.destination, formatSlackPayload(event), {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
    return { delivered: true, status: res.status };
  } catch (err) {
    return {
      delivered: false,
      reason: 'http_error',
      error: err.message,
      status: err.response?.status,
    };
  }
}

/**
 * Backoff schedule for failed notification attempts (in minutes).
 * Stops after the last entry — the row gets status='dlq' and is
 * never retried again.
 */
const NOTIFICATION_RETRY_INTERVALS = [1, 5, 30, 120]; // 1m, 5m, 30m, 2h
const NOTIFICATION_MAX_ATTEMPTS = NOTIFICATION_RETRY_INTERVALS.length + 1; // 1 initial + N retries

/**
 * Send via the wire (email or Slack). Pure send — doesn't touch the
 * DB. Used by both the synchronous dispatch path and the retry
 * poller. Returns { delivered, reason?, status?, error? }.
 */
async function sendOnWire(pref, event, emailTransport) {
  if (pref.channel === 'email') {
    return sendEmailNotification(emailTransport, pref, event);
  }
  if (pref.channel === 'slack') {
    return sendSlackNotification(pref, event);
  }
  return { delivered: false, reason: 'unknown_channel' };
}

/**
 * Persist a synchronous attempt outcome to notification_attempts.
 * Called by dispatchNotification after each pref's send completes.
 * Schedules a retry on failure (status='failed' + next_attempt_at);
 * marks 'dlq' once max_attempts are exhausted.
 */
async function recordAttempt(pool, prefId, organizationId, channel, destination, eventName, payload, sendResult) {
  const status = sendResult.delivered ? 'delivered' : 'failed';
  const attempts = 1;
  let nextAttemptAt = null;
  if (status === 'failed' && attempts < NOTIFICATION_MAX_ATTEMPTS) {
    const delayMin = NOTIFICATION_RETRY_INTERVALS[attempts - 1];
    nextAttemptAt = new Date(Date.now() + delayMin * 60_000);
  }
  try {
    await pool.query(
      `INSERT INTO notification_attempts
         (organization_id, preference_id, channel, destination,
          event_name, payload, status, attempts, last_error, next_attempt_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        organizationId,
        prefId,
        channel,
        destination,
        eventName,
        JSON.stringify(payload),
        status,
        attempts,
        sendResult.delivered ? null : (sendResult.error || sendResult.reason || 'unknown'),
        nextAttemptAt,
      ]
    );
  } catch (err) {
    log.error('Failed to record notification attempt:', err.message);
  }
}

/**
 * Look up + dispatch every enabled notification_preference for the
 * given org and event type. Per-channel failures are isolated.
 * Each attempt is persisted to notification_attempts so the retry
 * poller can pick up failed ones.
 */
async function dispatchNotification({ pool, emailTransport, organizationId, eventName, payload }) {
  let prefs;
  try {
    const r = await pool.query(
      `SELECT np.id, np.channel, np.destination, np.events, o.name AS organization_name
       FROM notification_preferences np
       LEFT JOIN organizations o ON o.id = np.organization_id
       WHERE np.organization_id = $1 AND np.enabled = TRUE
         AND $2 = ANY(np.events)`,
      [organizationId, eventName]
    );
    prefs = r.rows;
  } catch (err) {
    log.error(`Notification preference lookup failed for org ${organizationId}:`, err.message);
    return [];
  }
  if (prefs.length === 0) return [];

  const event = { ...payload, organizationName: prefs[0].organization_name };

  const results = await Promise.allSettled(
    prefs.map(async pref => {
      let sendResult;
      try {
        sendResult = await sendOnWire(pref, event, emailTransport);
      } catch (err) {
        log.error(`Notification dispatch threw for pref ${pref.id}:`, err.message);
        sendResult = { delivered: false, reason: 'exception', error: err.message };
      }
      // Record the attempt so retries + auditing work.
      await recordAttempt(
        pool,
        pref.id,
        organizationId,
        pref.channel,
        pref.destination,
        eventName,
        event,
        sendResult
      );
      return { id: pref.id, channel: pref.channel, ...sendResult };
    })
  );

  const summary = results.map(r => (r.status === 'fulfilled' ? r.value : { delivered: false }));
  const delivered = summary.filter(r => r.delivered).length;
  log.info(
    `Notifications dispatched for org=${organizationId} event=${eventName}: ${delivered}/${summary.length} delivered`
  );
  return summary;
}

/**
 * Retry poller — drains notification_attempts rows whose status is
 * 'pending' or 'failed' and whose next_attempt_at <= now. Same FOR
 * UPDATE SKIP LOCKED + stale-lock-sweep pattern as pending_retries
 * + outbox_events.
 *
 * Called by the webhook-dispatcher on a setInterval. Returns how many
 * rows it processed (so the dispatcher can adjust its sleep cadence
 * if needed; currently a fixed interval).
 */
async function pollNotificationAttempts({ pool, emailTransport, workerId, batchSize = 25, lockTimeoutMs = 5 * 60_000 }) {
  // Stale-lock sweep — fire-and-forget.
  pool
    .query(
      `UPDATE notification_attempts
       SET locked_at = NULL, locked_by = NULL
       WHERE locked_at IS NOT NULL
         AND locked_at < NOW() - ($1::text || ' milliseconds')::interval`,
      [String(lockTimeoutMs)]
    )
    .catch(err => log.error('Notification stale-lock sweep failed:', err.message));

  let claimed;
  try {
    const result = await pool.query(
      `WITH due AS (
          SELECT id FROM notification_attempts
          WHERE status IN ('pending', 'failed')
            AND locked_at IS NULL
            AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            AND attempts < $3
          ORDER BY next_attempt_at NULLS FIRST, created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE notification_attempts n
       SET locked_at = NOW(), locked_by = $2
       FROM due
       WHERE n.id = due.id
       RETURNING n.*`,
      [batchSize, workerId, NOTIFICATION_MAX_ATTEMPTS]
    );
    claimed = result.rows;
  } catch (err) {
    log.error('Notification claim failed:', err.message);
    return 0;
  }
  if (claimed.length === 0) return 0;

  for (const row of claimed) {
    const pref = {
      id: row.preference_id,
      channel: row.channel,
      destination: row.destination,
    };
    let sendResult;
    try {
      sendResult = await sendOnWire(pref, row.payload, emailTransport);
    } catch (err) {
      sendResult = { delivered: false, reason: 'exception', error: err.message };
    }

    const nextAttempts = row.attempts + 1;
    const delivered = sendResult.delivered;
    const exhausted = !delivered && nextAttempts >= NOTIFICATION_MAX_ATTEMPTS;
    const status = delivered ? 'delivered' : exhausted ? 'dlq' : 'failed';

    let nextAttemptAt = null;
    if (status === 'failed') {
      const idx = Math.min(nextAttempts - 1, NOTIFICATION_RETRY_INTERVALS.length - 1);
      const delayMin = NOTIFICATION_RETRY_INTERVALS[idx];
      nextAttemptAt = new Date(Date.now() + delayMin * 60_000);
    }

    try {
      await pool.query(
        `UPDATE notification_attempts
         SET status = $1, attempts = $2, last_error = $3,
             next_attempt_at = $4,
             locked_at = NULL, locked_by = NULL,
             updated_at = NOW()
         WHERE id = $5`,
        [
          status,
          nextAttempts,
          delivered ? null : (sendResult.error || sendResult.reason || 'unknown'),
          nextAttemptAt,
          row.id,
        ]
      );
    } catch (err) {
      log.error(`Failed to update notification_attempts row ${row.id}:`, err.message);
      // Unlock so the next poll picks it up.
      await pool
        .query(
          'UPDATE notification_attempts SET locked_at = NULL, locked_by = NULL WHERE id = $1',
          [row.id]
        )
        .catch(() => {});
    }
  }
  return claimed.length;
}

module.exports = {
  dispatchNotification,
  pollNotificationAttempts,
  formatSlackPayload,
  formatEmailBody,
  NOTIFICATION_RETRY_INTERVALS,
  NOTIFICATION_MAX_ATTEMPTS,
};
