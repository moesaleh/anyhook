/**
 * Internal HTTP server for /metrics and /health.
 *
 * Used by the worker services (subscription-connector, webhook-dispatcher)
 * which otherwise have no HTTP surface. subscription-management has its own
 * Express server and exposes these routes there directly — it doesn't use
 * this module.
 *
 * Listens on METRICS_PORT (default 9090). Not exposed publicly via
 * docker-compose; only reachable inside the docker network for Prometheus
 * scraping and Docker healthchecks.
 */

const http = require('http');
const promClient = require('prom-client');

// Default Node.js process metrics: heap, event loop lag, GC duration, etc.
// Idempotent — guards against double-collection if startMetricsServer is
// called more than once in the same process.
let defaultsCollected = false;
function ensureDefaultMetrics() {
  if (defaultsCollected) return;
  promClient.collectDefaultMetrics();
  defaultsCollected = true;
}

function startMetricsServer({ port, logger } = {}) {
  ensureDefaultMetrics();
  const listenPort = Number(port || process.env.METRICS_PORT || 9090);

  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics' && req.method === 'GET') {
      try {
        const body = await promClient.register.metrics();
        res.statusCode = 200;
        res.setHeader('Content-Type', promClient.register.contentType);
        res.end(body);
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err && err.message));
      }
      return;
    }
    if (req.url === '/health' && req.method === 'GET') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.listen(listenPort, () => {
    if (logger) {
      logger.info('Metrics server listening', { port: listenPort });
    } else {
      console.log(`Metrics server listening on :${listenPort}`);
    }
  });

  return server;
}

module.exports = { startMetricsServer, promClient };
