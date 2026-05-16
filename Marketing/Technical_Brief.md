# AnyHook — Technical Brief

A deep-dive for architects, CTOs, and SREs evaluating AnyHook as a production component.

## System Overview

AnyHook is composed of **three stateless Node.js microservices** sharing a **Kafka event bus**, **Postgres** for durable state, and **Redis** for hot subscription cache. A separate **Next.js dashboard** consumes the same Postgres database via the management API.

```
                ┌─────────────────────────────────────────────────────┐
                │  Dashboard (Next.js 16 / React 19 / TS / Tailwind)  │
                └─────────────────────────────────────────────────────┘
                                          │
                                          ▼
        ┌─────────────────────────────────────────────────────────────┐
        │  Subscription Management API (Express 5, Node 22)           │
        │  Port 3001 (public) · Port 9090 (metrics/health, internal)  │
        │  • OpenAPI 3.1 spec served at /openapi.yaml                 │
        │  • Auth: cookie + Bearer API key + Admin key                │
        │  • Writes Kafka publishes via outbox_events in same tx      │
        └─────────────────────────────────────────────────────────────┘
                          │                          │
            ┌─────────────┘                          └─────────────┐
            │                                                      │
            ▼                                                      ▼
   ┌────────────────┐    Kafka topics:               ┌────────────────────┐
   │  Postgres 17   │    • subscription_events       │  Redis 7           │
   │  ─────────────  │    • update_events            │  ────────────────  │
   │  • users        │    • unsubscribe_events       │  • sub:{id} cache  │
   │  • orgs         │    • connection_events        │  • rate-limit ctrs │
   │  • members      │    • dlq_events               │                    │
   │  • subscriptions│                               │                    │
   │  • api_keys     │                               │                    │
   │  • invitations  │                               │                    │
   │  • deliveries   │                               │                    │
   │  • pending_     │                               │                    │
   │    retries      │                               │                    │
   │  • outbox_      │                               │                    │
   │    events       │                               │                    │
   │  • notification_│                               │                    │
   │    attempts     │                               │                    │
   └────────────────┘                               └────────────────────┘
            ▲                                                      ▲
            │                                                      │
            └────────────────────────┬─────────────────────────────┘
                                     │
                       ┌─────────────┴──────────────┐
                       │                            │
                       ▼                            ▼
            ┌──────────────────────┐     ┌──────────────────────┐
            │ Subscription         │     │ Webhook              │
            │ Connector            │     │ Dispatcher           │
            │ ────────────────     │     │ ────────────────     │
            │ • Kafka consumer     │     │ • Kafka consumer     │
            │ • Opens upstream     │     │ • Sends webhooks     │
            │   GraphQL / WS conns │     │ • Drains:            │
            │ • Reload-from-Redis  │     │     - pending_retries│
            │   on startup         │     │     - outbox_events  │
            │ • Pluggable handlers │     │     - notif_attempts │
            └──────────────────────┘     └──────────────────────┘
                       │                            │
                       ▼                            ▼
              GraphQL/WebSocket             HTTPS POST + HMAC
              upstream sources              to customer webhooks
```

## Services

### Subscription Management API (`src/subscription-management/`)

- Express 5 application factory pattern: `app.js` exports `buildApp({ pool, redis, producer, admin, ... })`; `index.js` constructs real clients and connects them.
- Routes mounted: `/auth/*`, `/organizations/*`, `/subscriptions/*`, `/deliveries/*`, `/health`, `/health/live`, `/openapi.yaml`, `/redis/*` (admin-gated), `/kafka/topics/*` (admin-gated).
- Auth resolved per request from `anyhook_session` cookie (JWT) or `Authorization: Bearer ak_...` header.
- Writes to Postgres + outbox publish to Kafka happen in the **same transaction** for write integrity.
- Per-org rate limit middleware reads an in-memory cache (TTL configurable) for org overrides; per-IP rate limit on auth endpoints.

### Subscription Connector (`src/subscription-connector/`)

- Kafka consumer for `subscription_events`, `update_events`, `unsubscribe_events`.
- On startup, scans Redis for `sub:*` keys and re-establishes connections (reload-from-Redis pattern). Critical filter: `MATCH 'sub:*'` so the connector doesn't try to parse rate-limit counters as subscription JSON.
- Handlers in `src/subscription-connector/handlers/`:
  - `graphqlHandler.js` — Apollo Client + `graphql-ws` for GraphQL subscriptions.
  - `webSocketHandler.js` — raw `ws` for WebSocket sources.
- Per-handler reconnect on upstream errors; the connector process itself stays up.
- Publishes incoming events to Kafka `connection_events` topic, keyed by subscription ID.
- Metrics: `connector_subscription_events_total{topic, outcome}` counter.

### Webhook Dispatcher (`src/webhook-dispatcher/`)

- Kafka consumer for `connection_events` → sends to webhook URL via axios.
- Retry policy: 15 min → 1 h → 2 h → 6 h → 12 h → 24 h, persisted in `pending_retries`.
- DLQ: final attempts that fail land in `delivery_events` with `status='dlq'` and the actual HTTP context; admins notified via configured notification channels.
- Background pollers (all multi-pod safe via `FOR UPDATE SKIP LOCKED`):
  - `pending_retries` — schedules due retries.
  - `outbox_events` — drains pending Kafka publishes written by the API.
  - `notification_attempts` — retries failed admin notifications (email, Slack).
- HMAC signing: `X-AnyHook-Signature: t=<unix>,v1=<hex>` with per-subscription secrets.
- Best-effort delivery logging: Postgres failure does not block webhook send.
- Payload storage capped at 10 KB to prevent table bloat; full payload still sent to receiver.
- Metrics: `webhook_deliveries_total{status}`, `webhook_delivery_duration_seconds`, `webhook_pending_retries`, `outbox_pending_total{topic}`, `notification_attempts_pending_total{status}`.

## Data Model

Key Postgres tables (17 migrations total):

- `users` — accounts; password is scrypt-hashed; `last_totp_step` for replay protection; `token_version` for session invalidation; encrypted `totp_secret`.
- `organizations` — tenants; per-org rate-limit overrides and quotas (`max_subscriptions`, `max_api_keys`, `last_quota_warning_at`).
- `organization_members` — many-to-many with role (owner / admin / member).
- `subscriptions` — id, organization_id, connection_type, args (JSONB), webhook_url, webhook_secret, status, created_at.
- `api_keys` — long-lived tokens; first 11 chars stored as `key_prefix` for identification; revocable.
- `invitations` — email + role + token; expirable + revocable.
- `password_reset_tokens` — token + user_id + expiry.
- `delivery_events` — every webhook attempt: timestamp, status, status code, response_time_ms, payload_size, retry_count, event_id (groups retries).
- `pending_retries` — scheduled retries: subscription_id, next_attempt_at, locked_at, lock_token.
- `outbox_events` — Kafka publishes pending drain: topic, payload, delivered_at, locked_at.
- `notification_attempts` — DLQ notifications pending retry: channel, payload, status, next_attempt_at.

## Kafka Topology

Topics:

| Topic | Producer | Consumer | Purpose |
|-------|----------|----------|---------|
| `subscription_events` | API (via outbox) | Connector | New subscription created |
| `update_events` | API (via outbox) | Connector | Subscription updated (reload connection) |
| `unsubscribe_events` | API (via outbox) | Connector | Subscription deleted (close connection) |
| `connection_events` | Connector | Dispatcher | Event from upstream → send webhook |
| `dlq_events` | Dispatcher | (Future analytics) | Failed deliveries |

Messages are **keyed by subscription ID** so the same subscription always lands on the same partition, enabling horizontal scaling: up to N consumer pods per service, one per partition. `KAFKA_PARTITIONS` is configurable; `npm run kafka:alter-partitions` propagates increases to existing topics.

## Security Architecture

| Concern | Defense |
|---------|---------|
| **SSRF** on subscription/webhook URLs | Validate against loopback / RFC 1918 / RFC 6598 CGNAT / RFC 3927 link-local / IPv6 ULA / IPv6 link-local. `inet_aton`-aware so attackers can't smuggle private IPs through integer/octal notations. Toggleable via `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` for local dev only. |
| **Webhook forgery** at the receiver | HMAC-SHA256 signature in `X-AnyHook-Signature: t=<unix>,v1=<hex>` header, per-subscription rotating secrets. Receivers verify timestamp recency + signature. |
| **TOTP secret leak via DB dump** | AES-256-GCM envelope encryption with scrypt-derived key. `TOTP_SECRET_KEY_OLD` / `TOTP_SECRET_KEY` support zero-downtime rotation (old key reads + re-encrypts on next verify). |
| **Backup-code brute-force after DB leak** | HMAC-SHA256 with server-side `BACKUP_CODE_PEPPER`. Codes single-use; consumption is atomic. |
| **CSRF** | SameSite=lax cookies + JSON-only API surface. |
| **Credential stuffing** on `/auth/login` + `/auth/register` | Per-IP rate limit (default 10 req/60s/IP). |
| **Noisy tenant overwhelming the system** | Per-org rate limit (default 600 req/60s/org); optional per-user-per-org variant. |
| **Quota oversubscription under concurrency** | Postgres advisory-lock around quota claim. |
| **Session theft / lateral movement** | `token_version` invalidation on logout, password change, or 2FA disable invalidates every outstanding cookie on every device. |
| **Stale 2FA codes / replay** | `users.last_totp_step` records the most recently verified TOTP step; codes can only verify once. |
| **Metrics-leak surface** | `/metrics` lives on the internal port 9090, not exposed publicly by docker-compose. |
| **Data tier exposure** | Postgres / Redis / Kafka bind to 127.0.0.1 by default. `DATA_BIND=0.0.0.0` only when intentional. |

## Reliability & Correctness

- **Transactional outbox**: API writes Kafka publishes into `outbox_events` table inside the same DB transaction as the subscription change. Dispatcher drains pending rows. A Kafka outage delays but never loses events; a DB rollback never leaves an orphan Kafka message.
- **Reload-from-Redis**: connector restart reloads all `sub:*` keys from Redis and re-establishes connections.
- **Best-effort delivery logging**: Postgres outage during a webhook send doesn't block the send. Recovery: the dispatcher's poll loop catches up.
- **Multi-pod-safe pollers**: every Postgres poller uses `FOR UPDATE SKIP LOCKED` with a `locked_at` claim. Lock timeouts (default 60 s for outbox, 300 s for retries/notifications) reclaim work from crashed pods.
- **Healthcheck separation**: `/health/live` (process alive) is split from `/health` (deps healthy). A Postgres blip returns 503 from `/health` (good — load balancer drains) but doesn't restart the container (good — saves cascade restarts).
- **Connection pool sizing**: each Node service uses `pg max: 20`, so a saturated pool in one service can't take down another.

## Operability

- **Prometheus alerts** at `prometheus/alerts.yml` with corresponding runbook entries:
  - `anyhook-api-down`, `anyhook-api-latency-high`, `anyhook-api-error-rate`
  - `anyhook-dispatcher-down`, `anyhook-outbox-backlog`
  - `anyhook-webhook-failures`, `anyhook-retry-queue-growing`
  - `anyhook-connector-down`, `anyhook-connector-event-errors`
  - `anyhook-event-loop-lag`
- **Runbook** at `docs/RUNBOOK.md` — each alert has a diagnostic command, likely root cause, mitigation, and escalation path.
- **Diagnostic SQL** is checked into the runbook (outbox backlog by topic, active retries by subscription, notification attempts by channel/status, quota usage by org).
- **Structured logging** (Winston): JSON in production, colored single-line in development. `LOG_LEVEL` env-controlled.

## Performance & Scale Levers

| Lever | Default | Where |
|-------|---------|-------|
| Kafka partitions per topic | 8 | `KAFKA_PARTITIONS` |
| Retry polling | 30 s | `RETRY_POLL_INTERVAL_MS` |
| Outbox polling | 1 s | `OUTBOX_POLL_INTERVAL_MS` |
| Notification retry polling | 60 s | `NOTIFICATION_POLL_INTERVAL_MS` |
| Per-org rate limit | 600 req / 60 s | `RATE_LIMIT_REQUESTS` / `_WINDOW_SEC` |
| Per-IP auth limit | 10 req / 60 s | `AUTH_RATE_LIMIT_REQUESTS` / `_WINDOW_SEC` |
| Per-org subscription quota | 100 | `ORG_MAX_SUBSCRIPTIONS` |
| Per-org API-key quota | 10 | `ORG_MAX_API_KEYS` |
| Stored payload size cap | 10 KB | dispatcher constant |
| pg connection pool | 20 per service | service code |

Horizontal scale: bump `KAFKA_PARTITIONS`, run more connector + dispatcher pods. Vertical scale: Postgres + Redis + Kafka scale independently.

## Deployment

- **Docker images** (built via included `Dockerfile`):
  - `ghcr.io/moesaleh/anyhook:latest` for all three Node services (entrypoint varies by `command`).
  - `ghcr.io/moesaleh/anyhook-dashboard:latest` for the Next.js dashboard.
- **`docker-compose.yml`** brings up all six services (3 app + Postgres + Redis + Kafka).
- **Migration**: `npm run migrate` runs `node-pg-migrate up`. Migrations are forward-only; the migration table is `pgmigrations`.
- **CI/CD**: `.github/workflows/` runs lint, format, tests, builds images, and pushes to GHCR on merge.

## API Surface (selected)

- `POST /auth/login`, `/auth/register`, `/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`
- `GET/PUT /auth/me`, `POST /auth/password`, `POST /auth/2fa/*`
- `GET/POST /organizations`, `GET /organizations/current`, `POST /organizations/current/invitations`, `POST /organizations/current/api-keys`
- `GET/POST/PUT/DELETE /subscriptions`, `GET /subscriptions/:id`, `GET /subscriptions/:id/status`, `GET /subscriptions/status/all`
- `GET /subscriptions/:id/deliveries`, `GET /subscriptions/:id/deliveries/stats`, `GET /deliveries/stats`
- `GET /health`, `GET /health/live`, `GET /metrics` (internal), `GET /openapi.yaml`

Full spec: `docs/openapi.yaml`.

## Testing Posture

- **Backend unit tests** (Jest): 252+ in `tests/lib/` covering api-keys, email, envelope encryption, invitations, jwt, notifications, password-reset, passwords, quotas, rate-limit, slug, subscription-cache, totp, url-validation, webhook-signature.
- **Backend integration tests** (Supertest, real Postgres): in `tests/integration/` — auth, subscriptions, organizations, invitations, password, quotas, two-factor.
- **Frontend unit tests** (Vitest + React Testing Library): 73+ in `dashboard/src/components/`.
- **E2E tests** (Playwright): `dashboard/e2e/` — login + register render + form behavior.
- **CI gating**: lint, format, all of the above on every PR.

## Roadmap-Relevant Detail

- Pluggable handler interface in the connector means SSE, MQTT, gRPC streaming can be added with a single new `Handler` class.
- `outbox_pending_total` gauge exists in the dispatcher; alert rule TBD.
- Toast / notification system in the dashboard is a small surface; design done, implementation queued.
- E2E expansion (wizard, delete flow, 2FA enrollment) is the next testing priority.
- Performance work targets virtualized lists for orgs with 1,000+ subscriptions.

---

*For business-side framing, see the [Executive Summary](./Executive_Summary.md). For target-market scenarios, see [Use Cases](./Use_Cases.md).*
