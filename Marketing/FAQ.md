# AnyHook — Frequently Asked Questions

## General

### What is AnyHook in one sentence?
AnyHook is an open-source subscription-proxy server that connects GraphQL subscriptions and WebSocket data sources to HTTPS webhook endpoints with retries, signing, observability, and a multi-tenant dashboard.

### Who builds AnyHook?
AnyHook is an MIT-licensed open-source project hosted at [github.com/SwanBlocks-inc/anyhook](https://github.com/SwanBlocks-inc/anyhook). It is developed by a core team with contributions from the community.

### Is it ready for production?
Yes. AnyHook ships with a transactional outbox, multi-pod-safe pollers, Prometheus metrics, a published alerting bundle, a paged runbook, healthcheck separation (liveness vs. readiness), 252+ backend unit tests, 73+ frontend tests, real-Postgres integration tests, and security defaults that include SSRF defense and HMAC webhook signing.

### What's the license?
MIT. No commercial gate. Self-host freely.

---

## Sources & Destinations

### What sources are supported today?
- **GraphQL subscriptions** (via Apollo Client and `graphql-ws`).
- **WebSocket** connections (raw `ws`, with optional initial message and event-type filtering).

### What's on the roadmap?
Server-Sent Events (SSE), MQTT, and gRPC streaming sources via the connector's pluggable handler interface.

### What destinations are supported?
Any HTTP/HTTPS endpoint. SSRF defense blocks private/loopback/CGNAT/ULA addresses by default.

### Can I attach custom headers to outbound webhooks?
Yes — headers configured on the subscription are forwarded with every webhook request. The HMAC signature header (`X-AnyHook-Signature`) is added automatically.

---

## Reliability

### What's the retry policy?
Six exponential-backoff attempts spread across 24 hours: **15 min → 1 h → 2 h → 6 h → 12 h → 24 h**. After the sixth attempt, the message is dead-lettered.

### How is the dead-letter queue exposed?
Failed deliveries land in the `delivery_events` Postgres table with `status='dlq'` and the actual HTTP context (status code, response body, response headers). They're visible in the dashboard with a purple badge and filterable by status. Admins also receive a notification (email and/or Slack, if configured) for each DLQ event.

### What happens if Kafka is down?
The API uses a **transactional outbox**: Kafka publishes are written to a Postgres `outbox_events` table in the same transaction as the subscription change. A drainer in the dispatcher polls and publishes pending rows. If Kafka is unavailable, events queue in Postgres and drain when Kafka returns. **No events are lost.**

### What happens if Postgres is down?
- API reads/writes that need Postgres return 5xx (correct — readiness probe returns 503, load balancer drains).
- Webhook deliveries continue (the dispatcher uses Kafka and writes to Postgres on a best-effort basis; PG failure does NOT block the HTTP send).
- The connector's existing upstream connections continue producing to Kafka.

### What happens if Redis is down?
- Subscription Connector continues operating with existing connections; it won't be able to reload state on restart.
- API rate limiting falls back to a fail-open posture (configurable).
- Subscription cache misses are handled by falling back to Postgres.

### What happens when a service restarts?
- **Subscription Management**: stateless, starts fresh.
- **Connector**: scans Redis for `sub:*` keys and re-establishes every active connection.
- **Dispatcher**: reads `pending_retries`, `outbox_events`, `notification_attempts` and resumes processing.

---

## Security

### How does AnyHook sign outbound webhooks?
Every webhook request includes an `X-AnyHook-Signature: t=<unix-timestamp>,v1=<hmac-sha256-hex>` header. The HMAC is computed over the request body plus the timestamp, using a per-subscription secret returned **once** at subscription creation time.

### How do I prevent replay attacks at the receiver?
Verify the timestamp is recent (within e.g. 5 minutes) and that the signature matches. AnyHook never reuses the timestamp/body pair; receivers can use the timestamp to dedupe or reject stale requests.

### What's SSRF protection?
AnyHook blocks subscription and webhook URLs that resolve to private/loopback addresses (127.x, RFC 1918 private, RFC 6598 CGNAT, RFC 3927 link-local, IPv6 ULA, IPv6 link-local). It's `inet_aton`-aware, so encoded integer notations like `http://2130706433/` can't smuggle a loopback. Toggle `ALLOW_PRIVATE_WEBHOOK_TARGETS=true` for local development only.

### How are TOTP secrets stored?
AES-256-GCM envelope-encrypted with a scrypt-derived key. The encryption key (`TOTP_SECRET_KEY`) is environment-supplied. Online key rotation is supported via `TOTP_SECRET_KEY_OLD` + `TOTP_SECRET_KEY`: reads fall back to the old key and re-encrypt with the new on next verify.

### How are passwords stored?
Scrypt-hashed with a per-user salt.

### What's the difference between session and API key auth?
- **Session cookie** (`anyhook_session`): HttpOnly JWT, 7-day expiry, SameSite=lax. Used by the dashboard.
- **API key** (`Authorization: Bearer ak_<base64url-32>`): long-lived, revocable, per-org. Used for programmatic access.
- **Admin key** (`X-Admin-Key`): super-admin shared secret in `ADMIN_API_KEY`. Operational tools only.

### Can a stolen session cookie be invalidated?
Yes. Logout, password change, and 2FA disable each increment `users.token_version`. Sessions carry the issuing token_version and are rejected on mismatch — so every outstanding cookie on every device becomes invalid.

### What rate limits are enforced?
- **Per-IP** rate limit on `/auth/login` + `/auth/register` (default 10 req/60s). Tighter because anonymous endpoints are the primary credential-stuffing target.
- **Per-org** rate limit on every other authenticated endpoint (default 600 req/60s). Optional per-user-per-org variant for orgs with chatty admins.
- **Per-org quotas** for active subscriptions and active API keys, claimed under a Postgres advisory lock so concurrent creates can't oversubscribe.

---

## Multi-Tenancy

### What's the tenant model?
**Organizations** are the tenant boundary. Every subscription, API key, and quota is scoped to an org. Users can be members of multiple orgs and switch between them in the dashboard.

### What roles are supported?
- **Owner** — full control. Can manage members and demote/remove other owners. Cannot remove the last owner.
- **Admin** — manage subscriptions, members (non-owners), invitations, API keys.
- **Member** — read-only access to subscriptions and deliveries.

### How do I invite a teammate?
Settings → Members → Invite. AnyHook sends an email (if SMTP is configured) with an accept link. The token expires after a configurable window and is single-use. Invitations can be revoked before acceptance.

### Can I run a single AnyHook instance for many internal teams?
Yes — that's exactly the multi-tenant story. Each team owns an organization with its own subscriptions, members, quotas, and rate limits.

---

## Operations

### How do I monitor AnyHook?
Every service exposes Prometheus metrics on port 9090 (internal). Key metrics:
- `webhook_deliveries_total{status}`
- `webhook_delivery_duration_seconds`
- `webhook_pending_retries`
- `outbox_pending_total{topic}`
- `notification_attempts_pending_total{status}`
- `connector_subscription_events_total{topic,outcome}`
- Standard Node.js metrics (event loop lag, GC, heap, etc.)

The repo ships `prometheus/alerts.yml` with corresponding runbook entries in `docs/RUNBOOK.md`.

### Can I run AnyHook on Kubernetes?
Yes. The images are vanilla container images; the included `docker-compose.yml` translates directly to a Helm chart or kustomize overlay. Stateless services (`subscription-management`, `subscription-connector`, `webhook-dispatcher`) scale via replicas; data tier (Postgres, Redis, Kafka) is brought via your existing operator or managed service.

### How do I scale?
- Increase `KAFKA_PARTITIONS` and run more connector + dispatcher pods. Kafka events are keyed by subscription ID, so the same subscription always lands on the same partition. Pollers use `FOR UPDATE SKIP LOCKED` so multi-pod coordination is automatic.
- Scale Postgres + Redis + Kafka independently per their own playbooks.

### What database migrations are involved?
17 forward-only migrations in `migrations/`, applied via `npm run migrate` (`node-pg-migrate up`). The migration log lives in the `pgmigrations` table.

---

## Pricing & Commercial

### Is AnyHook free?
Yes — fully MIT-licensed and self-hostable. No commercial gate.

### Is there a managed/cloud option?
A managed-cloud offering is in the works for teams that prefer to outsource the operations. Contact the AnyHook team for design-partner access.

### Is commercial support available?
Yes, on a per-engagement basis. Contact the team via the GitHub repo.

---

## Getting Started

### How fast can I have something running?
About one minute on a developer laptop:

```bash
git clone https://github.com/SwanBlocks-inc/anyhook.git
cd anyhook
cp .env.example .env
docker-compose up -d
```

Dashboard at `http://localhost:3000`, API at `http://localhost:3001`.

### What's the smallest production deployment?
- 1 replica each of `subscription-management`, `subscription-connector`, `webhook-dispatcher`.
- 1 Postgres (managed: AWS RDS / GCP Cloud SQL / Azure DB).
- 1 Redis (managed: ElastiCache / Memorystore / Azure Cache).
- 1 Kafka cluster (managed: MSK / Confluent Cloud / Aiven). 8 partitions per topic is a fine starting point.

### How do I integrate AnyHook into my CI/CD?
Standard container workflow. The repo's own GitHub Actions builds and publishes images to GHCR on every push to main. Fork it and point at your registry.

---

## Contributing

### How do I contribute?
Read `CONTRIBUTING.md`. Open an issue first for non-trivial changes. PRs should include tests; the CI gates lint, format, and the full test suite.

### Where do I report a security issue?
See `SECURITY.md`. Do **not** open a public issue for security vulnerabilities.

### Where do I ask a question?
GitHub Discussions on the repo. We aim to answer within a business day.

---

*Couldn't find your question? Open a discussion at github.com/SwanBlocks-inc/anyhook.*
