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
 * Look up + dispatch every enabled notification_preference for the
 * given org and event type. Per-channel failures are isolated.
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
      try {
        if (pref.channel === 'email') {
          const r = await sendEmailNotification(emailTransport, pref, event);
          return { id: pref.id, channel: pref.channel, ...r };
        }
        if (pref.channel === 'slack') {
          const r = await sendSlackNotification(pref, event);
          return { id: pref.id, channel: pref.channel, ...r };
        }
        return { id: pref.id, delivered: false, reason: 'unknown_channel' };
      } catch (err) {
        log.error(`Notification dispatch threw for pref ${pref.id}:`, err.message);
        return { id: pref.id, delivered: false, reason: 'exception', error: err.message };
      }
    })
  );

  const summary = results.map(r => (r.status === 'fulfilled' ? r.value : { delivered: false }));
  const delivered = summary.filter(r => r.delivered).length;
  log.info(
    `Notifications dispatched for org=${organizationId} event=${eventName}: ${delivered}/${summary.length} delivered`
  );
  return summary;
}

module.exports = {
  dispatchNotification,
  formatSlackPayload,
  formatEmailBody,
};
