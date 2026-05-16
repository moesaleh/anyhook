# AnyHook — Product Overview

AnyHook is a **subscription-proxy platform**: it accepts a GraphQL subscription or WebSocket connection on one side, and reliably delivers every event from that stream to an HTTPS webhook on the other side. Around that core, AnyHook ships a complete operational surface: a dashboard, multi-tenant auth, delivery analytics, retries, signing, and observability.

## Product Pillars

### 1. Connect anything that streams

- **GraphQL subscriptions** — full Apollo / `graphql-ws` compatibility.
- **WebSocket connections** — raw socket support with optional initial message and event-type filtering.
- **Pluggable handler architecture** — the connector layer is built around a `Handler` interface, so additional source types (SSE, gRPC streaming, MQTT) can be added without touching the rest of the system.

### 2. Deliver everything reliably

- **At-least-once delivery** to webhook URLs via Kafka-backed event bus.
- **Exponential-backoff retry policy**: 15 min → 1 h → 2 h → 6 h → 12 h → 24 h.
- **Dead-letter queue (DLQ)** for messages that exhaust retries; admins are notified.
- **HMAC-SHA256 signed webhook bodies** (`X-AnyHook-Signature: t=...,v1=...`) — receivers can verify authenticity without sharing secrets in URLs.
- **Per-subscription webhook secrets** rotated independently.

### 3. See everything that happens

- **Real-time dashboard** built with Next.js 16, React 19, and Tailwind 4.
- **Subscription Detail view** with three tabs: Overview, Configuration, Activity.
- **Live connection status badges** with animated pulse, uptime counter, and last-check timestamp.
- **Service Health indicator** in the header (Postgres + Redis dots, polls every 30 s).
- **Delivery logs**: per-attempt timestamp, status code, response time, payload size, retry count.
- **Payload inspector**: click any row to expand request/response JSON (truncated to 10 KB to protect the DB).
- **Filter & paginate** delivery history by status (success / failed / retrying / DLQ).

### 4. Stay safe in production

- **SSRF defense**: subscription URLs and webhook URLs are validated to reject loopback (127.x), private (10/172.16/192.168), link-local (169.254), CGNAT (100.64/10), IPv6 ULA, and link-local addresses. `inet_aton`-aware, so attackers can't smuggle private IPs through alternate notations.
- **Webhook HMAC signing** so receivers can verify the request came from your AnyHook instance.
- **Envelope encryption for TOTP secrets** (AES-256-GCM derived via scrypt) with online key rotation.
- **Backup code peppering** via `BACKUP_CODE_PEPPER`, so a DB-only leak can't be brute-forced.
- **Per-IP rate limits** on `/auth/login` and `/auth/register` to thwart credential stuffing.
- **Per-org rate limits** and standing quotas on subscriptions + API keys.
- **CSRF mitigation** via SameSite=lax cookies and JSON-only API.

### 5. Multi-tenant from day one

- **Organizations** as the primary tenant boundary.
- **Roles**: owner, admin, member — owners can demote/remove other owners but never the last one.
- **Multi-org support**: users can belong to and switch between many organizations.
- **Email invitations** with token-based accept flow.
- **Per-org quotas**: max active subscriptions, max API keys (advisory-locked atomic claims so concurrent creates can't oversubscribe).
- **Per-org rate-limit overrides** stored in `organizations` table, cached in-memory.

### 6. Self-service authentication

- **Email/password login** with secure password hashing (scrypt).
- **Two-factor auth (TOTP, RFC 6238)** with single-use 64-bit backup codes.
- **TOTP replay guard** via `users.last_totp_step` to prevent code reuse.
- **API keys** (`Authorization: Bearer ak_...`) for programmatic access.
- **Session cookies** (HttpOnly JWT, 7-day expiry, SameSite=lax).
- **Password reset** via email-delivered tokens.
- **`token_version` invalidation**: logout / password change / 2FA disable invalidates every outstanding cookie.

## Feature Matrix

| # | Capability | Status | Notes |
|---|------------|--------|-------|
| 1 | **Subscription Creation Wizard** | ✅ Shipped | 4-step flow with progress indicator, GraphQL query editor, custom headers, format validation |
| 2 | **Subscription List & Management** | ✅ Shipped | Searchable, sortable, filterable, paginated table with inline delete and copy-to-clipboard |
| 3 | **Subscription Detail View** | ✅ Shipped | 3-tab layout (Overview / Configuration / Activity) with live status, code blocks, data-flow diagram |
| 4 | **Real-time Status Indicators** | ✅ Shipped | Animated ping badges, bulk-status endpoint, service health polling every 30 s |
| 5 | **Edit/Update Subscription** | ✅ Shipped | Single-page form reusing wizard step components, Kafka update_events to reload live connections |
| 6 | **Dashboard Analytics & Metrics** | ✅ Shipped | Delivery counter, success rate, avg latency, 24 h / 7 d aggregations on dashboard and detail |
| 7 | **Webhook Delivery Logs** | ✅ Shipped | Per-attempt history, payload inspector, retry tracking, DLQ status, filterable + paginated |
| 8 | Notifications & Alerts | 🛣 Roadmap | Toast system, banner alerts, DLQ alerts, optional Slack/email |
| 9 | **Dark Mode & Theming** | 🟡 Partial | Dark classes implemented; manual toggle + system-pref detection coming |
| 10 | **Error Handling & Resilience** | 🟡 Partial | Error banners, retry buttons, loading states, global boundary; offline/timeout polish coming |
| 11 | Bulk Operations | 🛣 Roadmap | Multi-select, bulk delete, bulk pause/resume |
| 12 | Export & Import | 🛣 Roadmap | JSON/CSV export, JSON import |
| 13 | **Testing & Quality** | 🟡 Partial | 73 frontend + 252 backend unit tests + integration suites; E2E expansion in progress |
| 14 | Performance Optimizations | 🛣 Roadmap | Virtualized lists, request dedup, optimistic UI, service-worker caching |
| 15 | **Authentication & Authorization** | ✅ Shipped | Sessions, API keys, 2FA, multi-org, invitations, quotas, SSRF defense, HMAC signing |

**Completed: 9/15 · Partial: 3/15 · Roadmap: 3/15**

## Technology Snapshot

| Layer | Stack |
|-------|-------|
| API service | Node.js 22, Express 5, kafkajs, pg, @redis/client, prom-client |
| Connector | Node.js 22, kafkajs, `@apollo/client`, `graphql-ws`, `ws` |
| Dispatcher | Node.js 22, axios, kafkajs, nodemailer |
| Dashboard | Next.js 16, React 19, TypeScript 5.9, Tailwind 4 |
| Data | Postgres 17, Redis 7, Kafka 3.9 (Bitnami) |
| Observability | Prometheus metrics on internal port 9090; structured Winston logs (JSON in prod) |
| Auth | JWT cookies, API keys, TOTP 2FA, scrypt password hashing |
| Tests | Jest (backend), Vitest + React Testing Library (frontend), Playwright (E2E), Supertest (integration) |

## What's in the box

- 3 Docker images: `subscription-management`, `subscription-connector`, `webhook-dispatcher`, plus a `dashboard` image.
- A complete `docker-compose.yml` you can launch in one command.
- An OpenAPI 3.1 spec covering every endpoint.
- A Prometheus alerting bundle (`prometheus/alerts.yml`) and an on-call **RUNBOOK** mapping each alert to a diagnostic command, likely root cause, and escalation path.
- 17 versioned database migrations.

## Roadmap Highlights

- **Notifications & Alerts**: in-app toast system + opt-in Slack/email notifications for DLQ events and error states.
- **Bulk Operations**: multi-select with bulk pause/resume/delete for power users.
- **Export & Import**: round-trip JSON/CSV for environment migrations and backups.
- **Performance**: virtualized tables for 1,000+ subscription tenants and service-worker caching.
- **Pluggable handlers**: roadmap items include SSE and MQTT source types.

---

*Architecture details: [Technical_Brief.md](./Technical_Brief.md) · Use cases: [Use_Cases.md](./Use_Cases.md)*
