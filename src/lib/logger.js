/**
 * Shared Winston logger factory.
 *
 * Production: JSON output (one log line per record) — easy to ingest into
 * ELK, Loki, Datadog, etc.
 * Development: pretty colored output — easy to scan during local dev.
 *
 * Usage:
 *   const { createLogger } = require('../lib/logger');
 *   const log = createLogger('subscription-management');
 *   log.info('Server starting', { port: 3001 });
 *   log.error('Failed to connect', { err: err.message });
 *
 * Level controlled by LOG_LEVEL env var (default 'info').
 */

const winston = require('winston');

function createLogger(service) {
  const isProd = process.env.NODE_ENV === 'production';

  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { service },
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      isProd
        ? winston.format.json()
        : winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, service: svc, ...rest }) => {
              const extras = Object.keys(rest).length > 0 ? ' ' + JSON.stringify(rest) : '';
              return `${timestamp} ${level} [${svc}] ${message}${extras}`;
            })
          )
    ),
    transports: [new winston.transports.Console()],
  });
}

module.exports = { createLogger };
