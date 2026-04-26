/**
 * Pluggable email transport.
 *
 * Two transports:
 *   - smtp: real outbound mail via nodemailer. Activates when SMTP_HOST
 *     is set in env. Reads SMTP_PORT (default 587), SMTP_USER, SMTP_PASS,
 *     SMTP_SECURE ('true' for port 465 / TLS).
 *   - noop: no-op + logs the would-be email body. Default when SMTP_HOST
 *     is unset. Lets dev keep shipping without an SMTP relay configured.
 *
 * Endpoints that issue tokens (invitations, password reset) check
 * `transport.enabled` and:
 *   - if enabled: send the email and OMIT the raw token from the API
 *     response (the user gets the token in their inbox).
 *   - if disabled: keep returning the raw token in the API response so
 *     the dashboard / curl can still complete the flow.
 *
 * EMAIL_FROM env sets the From: address; defaults to "noreply@anyhook.local".
 */

let nodemailer = null;
function loadNodemailer() {
  if (!nodemailer) {
    // Lazy require so tests / no-SMTP setups don't pay the load cost.
    nodemailer = require('nodemailer');
  }
  return nodemailer;
}

function makeEmailTransport({ env = process.env, log } = {}) {
  const host = env.SMTP_HOST;
  const from = env.EMAIL_FROM || 'noreply@anyhook.local';

  if (!host) {
    return {
      enabled: false,
      from,
      async send({ to, subject, text }) {
        if (log) {
          log.info('Email transport disabled (no SMTP_HOST); would have sent:', {
            to,
            subject,
            text_preview: text && text.slice(0, 200),
          });
        }
        return { delivered: false, reason: 'no_transport' };
      },
    };
  }

  const port = parseInt(env.SMTP_PORT, 10) || 587;
  const secure = env.SMTP_SECURE === 'true' || port === 465;
  const auth =
    env.SMTP_USER && env.SMTP_PASS ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined;

  const transporter = loadNodemailer().createTransport({
    host,
    port,
    secure,
    auth,
  });

  return {
    enabled: true,
    from,
    async send({ to, subject, text, html }) {
      try {
        const info = await transporter.sendMail({ from, to, subject, text, html });
        return { delivered: true, messageId: info.messageId };
      } catch (err) {
        // Caller decides whether to fail-closed or fail-open. We never
        // throw to keep the surface predictable.
        if (log) log.error('SMTP send failed', { err: err.message, to, subject });
        return { delivered: false, reason: 'smtp_error', error: err.message };
      }
    },
  };
}

module.exports = { makeEmailTransport };
