# AnyHook — Feature Highlights

A capability-by-capability breakdown of what AnyHook does, written for engineers and technical evaluators who want proof before they pilot.

---

## 1. Real-Time Subscription Wizard

Create a new subscription in under a minute with a guided 4-step wizard.

- **Step 1 — Connection Type**: Visual cards for GraphQL or WebSocket.
- **Step 2 — Source Config**: Endpoint URL, GraphQL query editor, WebSocket initial message, event-type filter, dynamic key-value custom headers.
- **Step 3 — Webhook**: Webhook URL with format validation (HTTP/HTTPS only, public networks only).
- **Step 4 — Review & Submit**: Full configuration summary with confirmation page and subscription ID.

Form state validated per step; back/next navigation preserves your input.

---

## 2. Subscription Management Console

A searchable, sortable, filterable table for every subscription in your organization.

- **Search** by ID, webhook URL, or endpoint URL.
- **Sort** by type, status, webhook URL, created date.
- **Filter** by connection type (GraphQL/WebSocket) and live status (Connected/Disconnected/Active).
- **Pagination** at 10 rows per page; auto-refresh every 10 seconds.
- **Copy-to-clipboard** for subscription IDs and webhook URLs.
- **Inline delete** with confirmation dialog.
- **Connection-type badges**: pink for GraphQL, blue for WebSocket — recognizable at a glance.
- **Empty state** with a clear call-to-action to create your first subscription.

---

## 3. Live Subscription Detail View

Three tabs surface every dimension of a subscription's behavior:

### Overview tab
- **Connection Status** card with live state badge, Redis cache status, uptime counter, last-check timestamp.
- **Source** card showing connection type icon, endpoint URL with copy, event filter (WebSocket).
- **Destination** card showing webhook URL with copy, HTTP method, retry-policy summary.
- **Delivery Stats** card with success rate, success/failure/retry counts, average latency, and 24 h / 7 d aggregations.

### Configuration tab
- GraphQL query or WebSocket message displayed as a syntax-highlighted code block with one-click copy.
- Custom headers displayed as a key-value table.
- Full JSON args available with copy-to-clipboard.

### Activity tab
- Visual data-flow diagram: **Source → AnyHook → Webhook**, color-coded by connection state.
- Connection-state timeline with animated indicators.
- Real delivery-history table (not a placeholder): timestamp, status code, response time, payload size, retry count.
- Click any row to expand and inspect the full JSON request/response payload.
- Filter by delivery status; pagination at 15 rows per page.
- Live/Pause toggle for auto-refresh polling.

---

## 4. Production-Grade Delivery Pipeline

The webhook dispatcher is the operational heart of AnyHook.

- **Kafka-backed event bus** decouples source connections from delivery; pods on either side can scale horizontally.
- **Exponential backoff retries**: 15 min → 1 h → 2 h → 6 h → 12 h → 24 h. Six attempts total spread across a day; covers virtually every transient receiver outage.
- **`pending_retries` table** persists scheduled retries across restarts; `FOR UPDATE SKIP LOCKED` makes multi-pod scaling safe.
- **Dead-letter queue (DLQ)**: messages that exhaust retries land in the `delivery_events` table with `status='dlq'` and the actual final HTTP context (status code, body, response headers).
- **Best-effort logging**: a Postgres outage doesn't block webhook delivery itself.
- **Per-delivery `event_id`** groups the original attempt with its retries for clean activity tracking.
- **10 KB payload truncation** at storage time prevents the deliveries table from bloating; in-flight delivery bodies aren't artificially capped.
- **HMAC-SHA256 signatures** on every outgoing request via the `X-AnyHook-Signature` header (`t=<unix>,v1=<hex>`), with per-subscription rotating secrets.

---

## 5. Transactional Outbox

The API writes Kafka publishes into an `outbox_events` table inside the same Postgres transaction as the subscription change. A drainer in the dispatcher consumes pending rows and forwards them to Kafka. The result: **no orphan subscriptions** (DB written but Kafka missed) and **no zombie connections** (Kafka written but DB missed).

- Polling interval, batch size, and lock timeout are all environment-tunable.
- Multi-pod safe via `FOR UPDATE SKIP LOCKED`.
- Backlog and lag metrics exposed to Prometheus.

---

## 6. Real-Time Status & Health Monitoring

- **`GET /health`** — Postgres + Redis connectivity check (used for Kubernetes readiness probes).
- **`GET /health/live`** — process liveness (returns 200 as long as the Express loop is responsive).
- **`GET /subscriptions/:id/status`** — Redis cache hit means the connection is live.
- **`GET /subscriptions/status/all`** — one round-trip to get live state for every subscription in the org; powers the dashboard list view's badges.
- **Dashboard `ServiceHealth` component** — green/red dots for Postgres and Redis, refreshes every 30 s.
- **`LiveIndicator` component** — polling dot + last-updated relative timestamp + polling-interval display.
- **`StatusBadge` component** — animated ping pulse when live, configurable size.

---

## 7. Analytics & Metrics

- **Per-subscription** stats: total events delivered, success rate, average webhook response time, 24 h and 7 d windows.
- **Org-wide** stats on the dashboard: Total Deliveries, Success Rate, Avg Latency, Last 7 d.
- **Prometheus metrics** on internal port 9090:
  - `webhook_deliveries_total{status}` (success / retrying / failed / dlq)
  - `webhook_delivery_duration_seconds` histogram
  - `webhook_pending_retries` gauge
  - `outbox_pending_total{topic}` gauge
  - `notification_attempts_pending_total{status}` gauge
  - `connector_subscription_events_total{topic,outcome}` counter
  - `nodejs_eventloop_lag_p99_seconds` gauge (built into prom-client)

---

## 8. Multi-Tenant Authentication & Authorization

- **Sessions**: HttpOnly JWT cookies, 7-day expiry, SameSite=lax, JWT secret rotation invalidates everything.
- **API keys** with metadata, expiry, revocation, and `ak_<32-char-base64url>` format.
- **Role-based access** within an organization: owner / admin / member. Owners can demote or remove other owners but never the last one — preventing accidental org lockouts.
- **Multi-org support**: a user can be a member of many orgs and switch between them; quotas and rate limits are per-org.
- **Email invitations**: create, list, revoke, accept; anonymous accept page at `/invitations/[token]`.
- **Password reset**: anonymous `/forgot-password` request and `/reset-password` flows with email-delivered tokens.
- **2FA via TOTP** (RFC 6238) with single-use 64-bit backup codes. Settings panel for enable/verify/disable/regenerate. Login flow handles `needs_2fa` second-step state. Replay protection via `users.last_totp_step`.
- **token_version invalidation**: logout, password change, or 2FA disable invalidates every outstanding cookie on every device.

---

## 9. Security Hardening

- **SSRF defense** baked into URL validation: refuses loopback, RFC 1918 private, RFC 6598 CGNAT, RFC 3927 link-local, IPv6 ULA, IPv6 link-local. Handles `inet_aton`-style integer-encoded IPs and other obfuscations.
- **HMAC-signed webhooks** with per-subscription secrets, returned once at creation time.
- **Envelope encryption** for TOTP secrets in Postgres (AES-256-GCM, scrypt-derived key). Supports `TOTP_SECRET_KEY_OLD` and `TOTP_SECRET_KEY` for zero-downtime key rotation.
- **Backup-code peppering** via `BACKUP_CODE_PEPPER`: a DB-only leak can't be brute-forced offline.
- **CSRF mitigation**: SameSite=lax cookies + JSON-only API surface.
- **Rate limits**:
  - Per-IP rate limit on `/auth/login` + `/auth/register` (default 10 req/60s/IP) — the primary credential-stuffing surface.
  - Per-org rate limit on every other authenticated endpoint (default 600 req/60s/org).
  - Optional per-user-per-org variant for orgs with chatty admins.
  - In-memory cache for the per-org override row so the middleware doesn't issue a PG round-trip per request.
- **Quotas**: per-org caps on active subscriptions and active API keys, claimed under a Postgres advisory lock so concurrent creates can't oversubscribe.

---

## 10. Operational Maturity

- **OpenAPI 3.1 spec** at `docs/openapi.yaml` covering every endpoint, served at `GET /openapi.yaml`.
- **Prometheus alerting bundle** at `prometheus/alerts.yml`.
- **Paged runbook** at `docs/RUNBOOK.md` mapping each alert to a diagnostic command, likely root cause, mitigation, and escalation. Sample alerts:
  - `anyhook-api-down`
  - `anyhook-api-latency-high`
  - `anyhook-api-error-rate`
  - `anyhook-dispatcher-down`
  - `anyhook-outbox-backlog`
  - `anyhook-webhook-failures`
  - `anyhook-retry-queue-growing`
  - `anyhook-connector-down`
  - `anyhook-connector-event-errors`
  - `anyhook-event-loop-lag`
- **Structured Winston logging**: JSON in production, colored single-line in development; log level via `LOG_LEVEL` env.
- **Healthcheck separation**: liveness (process responsive) is split from readiness (deps healthy) so a Postgres blip doesn't cascade restarts across the stack.
- **Internal metrics port** (default 9090): not exposed publicly via docker-compose; only reachable inside the Docker network.
- **Data tier binding**: Postgres, Redis, Kafka bind to 127.0.0.1 by default; flip `DATA_BIND=0.0.0.0` only when you actually need external access.

---

## 11. Developer Experience

- **One-command bootstrap**: `git clone && cp .env.example .env && docker-compose up -d`.
- **Hot-reload dev mode**: `npm run dev` runs Express on nodemon; `cd dashboard && npm run dev` runs Next.js.
- **Comprehensive `.env.example`**: every tunable documented inline.
- **Migration tooling**: `npm run migrate` runs `node-pg-migrate up`.
- **Kafka topic management**: `npm run kafka:alter-partitions` for capacity scaling.
- **GitHub Actions CI/CD pipeline** building all four images.
- **ESLint + Prettier** enforced.
- **Test coverage** with multiple harnesses:
  - Jest unit tests for backend libs (252+ passing).
  - Supertest integration tests against real Postgres (auth, subscriptions, organizations, invitations, password, quotas, two-factor).
  - Vitest + React Testing Library for components (73+ passing).
  - Playwright E2E for login + register render and form behavior.

---

## 12. Horizontal Scalability

- **Connector** consumes Kafka `subscription_events` / `unsubscribe_events` / `update_events`; events are keyed by `subscriptionId` so the same subscription always lands on the same partition.
- **Dispatcher** consumes Kafka `connection_events`; same partitioning scheme.
- Multiple pods of each service can run in parallel — one per Kafka partition — with no coordination required.
- `KAFKA_PARTITIONS` is a single env var; `npm run kafka:alter-partitions` propagates increases to existing topics.
- All Postgres pollers (outbox, pending_retries, notification_attempts) use `FOR UPDATE SKIP LOCKED` for multi-pod-safe coordination.

---

## 13. Fault Tolerance

- **Reload-from-Redis**: on connector restart, all active subscriptions are reloaded from Redis and connections re-established. No subscription is silently dropped.
- **Outbox**: every Kafka publish is durable in Postgres first; a Kafka outage delays but doesn't lose events.
- **Best-effort delivery logging**: a Postgres outage during a webhook attempt doesn't block the attempt itself.
- **DLQ as a hospice**: messages aren't deleted on retry exhaustion — they're moved to `delivery_events` with `status='dlq'` and admin-notified. Operators can re-publish manually if needed.
- **Connection-pool isolation**: each Node service uses `pg max: 20`; saturation in one service can't take down another.

---

*See the [Technical Brief](./Technical_Brief.md) for deeper architectural detail, or the [Use Cases](./Use_Cases.md) for industry-specific scenarios.*
