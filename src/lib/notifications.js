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
const { guardedAxiosConfig, SsrfBlockedError } = require('./ssrf-guard');

const log = createLogger('notifications');

/**
 * Format a Slack incoming-webhook payload from a notification event.
 * Slack accepts plain `{text, blocks?}` JSON. We use blocks for the
 * structured fields so the receiver can grep them quickly.
 *
 * `eventName` selects the template: 'quota_warning' renders an approaching-
 * cap alert (no subscription/URL fields — the payload carries used/limit, not
 * a delivery), 'failed' a single delivery failure, and 'dlq' (the default for
 * an unknown/absent name) the retries-exhausted DLQ story. Threading the name
 * keeps a quota_warning from masquerading as a DLQ'd delivery.
 */
function formatSlackPayload(event, eventName = 'dlq') {
  if (eventName === 'quota_warning') {
    const lines = [
      `*Subscription quota warning* — raise the cap before requests start 429ing.`,
      `• Usage: ${event.used}/${event.limit} subscriptions`,
      event.organizationName ? `• Organization: ${event.organizationName}` : null,
    ].filter(Boolean);
    return {
      text: `AnyHook: organization at ${event.used}/${event.limit} subscriptions`,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: lines.join('\n') },
        },
      ],
    };
  }

  const headline =
    eventName === 'failed'
      ? `*Webhook delivery failed* — the retry policy is still running.`
      : `*Webhook delivery failed* — moved to DLQ after retries exhausted.`;
  const lines = [
    headline,
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
 * Format an email body for a notification event. Branches on `eventName` so
 * the operator never receives a DLQ incident write-up for a quota warning
 * (which carries used/limit, not a failed delivery). Defaults to the DLQ
 * template for an unknown/absent name.
 */
function formatEmailBody(event, eventName = 'dlq') {
  if (eventName === 'quota_warning') {
    return [
      `Organization is at ${event.used}/${event.limit} subscriptions — raise the`,
      `cap before requests start 429ing.`,
      ``,
      event.organizationName ? `Organization: ${event.organizationName}` : null,
      `Used:  ${event.used}`,
      `Limit: ${event.limit}`,
      ``,
      `No delivery has failed. Increase ORG_MAX_SUBSCRIPTIONS (or the org's`,
      `override) from the AnyHook dashboard before new subscriptions are rejected.`,
    ]
      .filter(line => line !== null)
      .join('\n');
  }

  if (eventName === 'failed') {
    return [
      `A webhook delivery failed. The retry policy is still running — this is`,
      `NOT yet a Dead Letter Queue event.`,
      ``,
      `Subscription: ${event.subscriptionId}`,
      `Webhook URL:  ${event.webhookUrl}`,
      `Event ID:     ${event.eventId}`,
      event.organizationName ? `Organization: ${event.organizationName}` : null,
      ``,
      `If the remaining retries also fail the event will be parked in the Dead`,
      `Letter Queue. Investigate via the AnyHook dashboard.`,
    ]
      .filter(line => line !== null)
      .join('\n');
  }

  return [
    `A webhook delivery has been moved to the Dead Letter Queue after`,
    `exceeding the retry policy.`,
    ``,
    `Subscription: ${event.subscriptionId}`,
    `Webhook URL:  ${event.webhookUrl}`,
    `Event ID:     ${event.eventId}`,
    event.organizationName ? `Organization: ${event.organizationName}` : null,
    ``,
    `The original event is parked in the Dead Letter Queue (dlq_events) and`,
    `will NOT be retried automatically — it awaits an operator redrive.`,
    `Investigate and replay it via the AnyHook dashboard.`,
  ]
    .filter(line => line !== null)
    .join('\n');
}

function formatEmailSubject(event, eventName) {
  if (eventName === 'quota_warning') {
    return `[AnyHook] Subscription quota warning — ${event.used}/${event.limit}`;
  }
  if (eventName === 'failed') {
    return `[AnyHook] Delivery failed — subscription ${String(event.subscriptionId).slice(0, 8)}`;
  }
  return `[AnyHook] DLQ — subscription ${String(event.subscriptionId).slice(0, 8)}`;
}

async function sendEmailNotification(emailTransport, pref, event, eventName) {
  if (!emailTransport || !emailTransport.enabled) {
    return { delivered: false, reason: 'no_transport' };
  }
  return emailTransport.send({
    to: pref.destination,
    subject: formatEmailSubject(event, eventName),
    text: formatEmailBody(event, eventName),
  });
}

async function sendSlackNotification(pref, event, eventName) {
  // Slack webhooks are user-supplied URLs validated at create-time, but a
  // create-time hostname check is defeated by DNS rebinding — the record can
  // re-point at 169.254.169.254 (cloud IMDS) or an RFC1918 host before this
  // request fires. Route the POST through the SSRF guard so we resolve the
  // host NOW, reject any private/IMDS address, pin the socket to the vetted
  // IP, and (critically) cap redirects at 0 so a 302 -> http://169.254...
  // can't bounce us into an exfiltration sink. axios timeouts still cap the
  // worst case at 10s per webhook so a slow Slack workspace doesn't stall
  // the dispatcher.
  let cfg;
  try {
    cfg = await guardedAxiosConfig(pref.destination, {
      timeout: 10_000,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    if (err instanceof SsrfBlockedError) {
      // Blocked at resolve/validate time — never opened the socket. Surface a
      // stable reason; log the host (never the full URL, which can embed a
      // Slack webhook token) so an operator can see what was refused.
      log.warn(
        `Slack notification blocked by SSRF guard for pref ${pref.id}: ${err.reason}` +
          (err.details?.host ? ` (host=${err.details.host})` : '')
      );
      return { delivered: false, reason: 'ssrf_blocked', error: err.reason };
    }
    return { delivered: false, reason: 'http_error', error: err.message };
  }

  try {
    const res = await axios.post(pref.destination, formatSlackPayload(event, eventName), cfg);
    return { delivered: true, status: res.status };
  } catch (err) {
    // With maxRedirects:0 a 3xx is rejected by axios rather than chased; treat
    // it as a (non-)delivery result instead of following it to a private host.
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
 * poller. `eventName` selects the message template (quota_warning /
 * failed / dlq) so the rendered alert matches the actual event.
 * Returns { delivered, reason?, status?, error? }.
 */
async function sendOnWire(pref, event, emailTransport, eventName) {
  if (pref.channel === 'email') {
    return sendEmailNotification(emailTransport, pref, event, eventName);
  }
  if (pref.channel === 'slack') {
    return sendSlackNotification(pref, event, eventName);
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
        sendResult = await sendOnWire(pref, event, emailTransport, eventName);
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
      sendResult = await sendOnWire(pref, row.payload, emailTransport, row.event_name);
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
  // Exported for the persistence/retry state-machine tests (P2-20): sendOnWire
  // is the single wire seam both the synchronous dispatch and the retry poller
  // go through, so a test can stub it to drive transient-failure -> backoff ->
  // success/terminal deterministically without real network or SMTP. Not part
  // of the public dispatch API; the dispatcher only imports the two pollers.
  sendOnWire,
  recordAttempt,
};
