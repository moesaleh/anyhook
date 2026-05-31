# AnyHook — Codebase Assessment

**Date:** 2026-05-31
**Scope:** Full repository (backend `src/`, `dashboard/`, `migrations/`, infra, CI)
**Method:** 8 specialist subagents (VoltAgent personas installed in `.claude/agents/`) run in parallel via a read-only workflow. Nothing was executed — this is static analysis. Two findings were additionally confirmed by direct source inspection (noted inline).
**Companion doc:** [`ASSESSMENT-FIX-PLAN.md`](./ASSESSMENT-FIX-PLAN.md) — the tracked, checkbox punch-list derived from this report.

> Severity legend: 🔴 critical · 🟠 high · 🟡 medium · 🔵 low · ⚪ info
> Rating legend: 🟢 Strong/Excellent · 🟡 Adequate · 🟠 Needs improvement · 🔴 At risk

---

## Executive summary

AnyHook is a subscription proxy that bridges GraphQL/WebSocket sources to outbound webhooks in real time, as a multi-tenant SaaS with a management API and a Next.js dashboard. **For a ~7k-LOC project the engineering quality is above the bar** — the transactional-outbox + `FOR UPDATE SKIP LOCKED` resilience patterns, the security primitives, and the data-layer discipline are genuinely strong. **However, it is not production-ready as shipped:** the published Docker image crash-loops on boot, two confirmed latent bugs silently disable features, an end-to-end SSRF gap exposes cloud metadata credentials, and the runtime topology contradicts the README's "high-availability / high-throughput" claims (connector and dispatcher are pinned to a single replica).

### Scorecard

| # | Dimension | Rating |
|---|-----------|--------|
| 1 | Backend code quality & maintainability | 🟢 Strong |
| 2 | Data layer & migrations | 🟢 Strong |
| 3 | Architecture & distributed design | 🟡 Adequate |
| 4 | Security | 🟡 Adequate |
| 5 | Dashboard frontend (Next.js/React) | 🟡 Adequate |
| 6 | Performance & scalability | 🟠 Needs improvement |
| 7 | Testing & QA | 🟠 Needs improvement |
| 8 | Operations & deployment readiness | 🟠 Needs improvement |

### Highest-confidence issues (independent convergence)

These were flagged by **two or more** specialists independently, or confirmed by direct inspection — treat them as the most reliable:

- **Production image crash-loops on boot** — `node-pg-migrate` is a devDependency, pruned from the runtime image, but boot runs `npm run migrate`. *(devops)*
- **`dispatchNotification` not imported in `app.js`** — quota-warning notifications throw and are swallowed. *(code-reviewer + security; **confirmed by inspection**)*
- **Advisory-lock key mismatch in `quotas.js`** — lock uses `hashtext()`, unlock uses the raw UUID → session lock leaks onto pooled connections. *(code-reviewer + postgres; **confirmed by inspection**)*
- **SSRF is create-time only** — no connect-time re-validation and `maxRedirects` left at default → IMDS credential exfiltration. *(security + qa)*
- **Connector/dispatcher can't scale past one replica** — `container_name` pin + every pod reloads all subscriptions from Redis → duplicate upstream connections. *(architecture + performance)*
- **`delivery_events` is unbounded** with a full-table-scan dashboard stats query. *(performance + postgres)*
- **Per-message `info` logging serializes full payloads** on the hot path — cost + PII/secret leakage into logs. *(code-reviewer + performance)*
- **Kafka RF=1 + no producer durability** — single broker SPOF. *(architecture + devops + performance)*

---

## 1. Architecture & Distributed Design — 🟡 Adequate

AnyHook has a coherent, well-reasoned event-driven design: three single-responsibility services over Kafka, a genuinely correct transactional-outbox implementation, and a persistent retry queue + reconnect machinery that survive restarts and are multi-pod-safe via `FOR UPDATE SKIP LOCKED`. The resilience patterns in the data layer are above the bar for a project this size, and the inline comments show real distributed-systems thinking. The architecture is weaker at the edges: the connector reloads source connections from Redis on every pod (breaking horizontal scaling), delivery dedup is a non-atomic check-then-act with no backing unique constraint, the DLQ has no consumer, Kafka has no replication or producer durability, and the README describes a synchronous flow the code has since replaced with the outbox. **Delivery is realistically at-least-once with best-effort dedup, not the exactly-once/ordered impression the docs give.**

### Strengths
- **Transactional outbox** (`src/lib/outbox.js` + migration `20260506` + `app.js` handlers) is implemented correctly: every Kafka publish for `/subscribe`, `/unsubscribe`, `PUT`, bulk, and admin-wipe is `INSERT`ed into `outbox_events` inside the same DB transaction as the subscription row, then drained by a separate worker. Removes the "DB committed but Kafka publish lost" failure mode and keeps the API path off the Kafka critical path.
- **Consistent, sound background-work concurrency**: claim-with-`FOR UPDATE SKIP LOCKED` + `locked_by` + timeout-based stale-lock reclaim, applied uniformly to `pending_retries`, `outbox_events`, and `notification_attempts`. Horizontally scalable for delivery/retry and crash-safe (a dead worker's locked rows are reclaimed on the next sweep).
- **Clean service boundaries + DI composition**: `subscription-management/app.js` is a pure app factory taking `pool`/`redis`/`kafka` as injected deps (real in `index.js`, fakes in tests); Kafka keys pinned to `subscriptionId` for per-partition affinity; consumers use manual offset commit with explicit rationale for commit-on-handled-error vs replay-on-crash.
- **Thoughtful operational design**: liveness (`/health/live`) deliberately separated from readiness (`/health`) to avoid dependency-blip restart cascades; data services bound to `127.0.0.1` by default; metrics on an internal-only port; Prometheus gauges (`outbox_pending_total`, `pending_retries`, `notification_attempts_pending`) expose the exact backlog signals the resilience patterns need.
- **Well-factored reconnect resilience**: a reusable `ReconnectScheduler` with exponential backoff + jitter + cancellation for the WebSocket handler, graphql-ws's built-in retry for GraphQL, and idempotent `connect()`/`disconnect()` to avoid orphaned upstream sockets on redelivery.

### Findings

**🟠 Every connector pod reloads ALL subscriptions from Redis on startup, breaking the horizontal-scaling story**
*Area: `src/subscription-connector/index.js`*
Kafka event handling is partitioned (group `subscription-connector`, key=`subscriptionId`), so each partition's events go to exactly one pod. But the actual upstream source connections live in process memory (`handler.wsClients` / `activeSubscriptions`), and `reloadActiveSubscriptions()` (lines 58–90) runs on **every** pod and does `SCAN MATCH 'sub:*'` over the whole keyspace, then `handler.connect()` for every subscription found. With N connector pods, each active source gets N concurrent upstream connections after a restart/scale event, each delivering into `connection_events` → N-fold duplicate events. The in-code comment frames this only as a SCAN-prefix hygiene issue, not the core multi-pod duplication defect. The README claims HA/partitioned scaling; in practice the connector tier cannot be safely scaled past one pod.
*Recommendation:* Make connection ownership follow partition ownership — connect only to subscriptions whose `subscriptionId` maps to a partition currently assigned to the pod (use the consumer group's assignment), or rebuild connections purely from a per-partition replay/snapshot. Document the single-pod constraint until fixed.

**🟠 Delivery idempotency is a non-atomic check-then-act with no enforcing unique constraint**
*Area: `src/webhook-dispatcher/index.js`, `migrations/20250324000000_create_delivery_events.sql`*
Dedup of redelivered Kafka messages relies on `SELECT 1 FROM delivery_events WHERE subscription_id=$1 AND event_id=$2` (lines 284–302) before sending. There is **no** `UNIQUE` constraint on `(subscription_id, event_id)` — only plain indexes. The check and the subsequent `INSERT` are not atomic, so two near-simultaneous deliveries of the same `event_id` (consumer rebalance window, or any re-entry before the first row lands) can both pass the `SELECT`, both fire the webhook, and both start retry chains. Net guarantee is at-least-once with best-effort dedup — weaker than the README implies.
*Recommendation:* Add a `UNIQUE` index on `delivery_events(subscription_id, event_id)` (or a dedicated `processed_events` table) and treat a unique-violation as the dedup signal (`INSERT … ON CONFLICT DO NOTHING`; if no row inserted, skip). Converts the race into an atomic, DB-enforced guarantee.

**🟡 DLQ is write-only — no consumer, no replay path**
*Area: `src/webhook-dispatcher/index.js` (`sendToDLQ`), `src/subscription-management/index.js` (topic creation)*
`dlq_events` is created and produced to by `sendToDLQ` (line 741), and notifications tell operators the event "has been published to the dlq_events Kafka topic for downstream processing." But nothing subscribes to `dlq_events` (the only `consumer.subscribe` calls are `connection_events` in the dispatcher and subscription/unsubscribe/update in the connector). So "downstream processing" does not exist — messages accumulate until retention expires and are silently dropped. The DLQ is effectively an email/Slack alert + tombstone row, with no redrive/replay (the main operational value of a DLQ).
*Recommendation:* Implement a DLQ consumer/redrive (admin endpoint or worker that re-enqueues a `dlq_events` message into `pending_retries`), or correct the docs/notification wording. At minimum, add a gauge/alert on `dlq_events` lag.

**🟡 Kafka is a single point of failure: replication factor 1 and no producer durability/idempotence**
*Area: `docker-compose.yml`, Kafka producer config in `src/*/index.js`*
Compose runs a single broker and `KAFKA_REPLICATION_FACTOR` defaults to 1 (`subscription-management/index.js:134`), so a broker disk loss loses in-flight events and the whole bus is a SPOF — at odds with the README's HA claim. All three producers are created with only `{ allowAutoTopicCreation: false }`: no `acks:'all'`, no `idempotent:true`, no `maxInFlightRequests` cap (contrast `src/test/kafka/producer.js`, which sets `maxInFlightRequests:1`). A `producer.send` in the outbox drainer can report success on a leader that then loses the write, or reorder on retry. The outbox protects the DB→publish hop but not the publish→broker-durability hop.
*Recommendation:* For non-dev deployments, require a 3-broker cluster (`replicationFactor>=3`, `min.insync.replicas=2`) and configure producers with `acks:'all'` + `idempotent:true`. The outbox's at-least-once promise is only as strong as broker durability.

**🟡 README architecture is stale and omits the system's central resilience components**
*Area: `README.md` vs `src/`*
The README still describes the pre-outbox synchronous flow ("…stores it in PostgreSQL and Redis, and sends an event to Kafka", lines 124–125, 166). The implementation no longer publishes to Kafka inline — it writes to the outbox and a dispatcher worker drains it (`app.js` passes the producer only "for caller compatibility"). The README never mentions the outbox, `pending_retries`, `update_events`, multi-tenancy (organizations/quotas/rate-limit), or the internal metrics server — i.e. it omits the very patterns that define the current architecture. The single-`src/index.js`-entry-point assumption is also outdated (entry points are the three per-service `index.js` files).
*Recommendation:* Refresh the README architecture/flow sections; enumerate all topics (incl. `update_events`); document the real delivery guarantee (at-least-once + dedup) and per-service entry points; note the connector single-pod caveat. Add a `docs/ARCHITECTURE.md` or ADRs.

**🟡 Connector recovery depends on Redis, but Postgres is the durable store the connector never reads**
*Area: `src/subscription-connector/index.js`, `src/subscription-management/app.js` (`/redis/reload`)*
State ownership is split: Postgres is the system of record, Redis a cache. The dispatcher correctly treats Redis as a cache with a Postgres fallback at delivery time (`processClaimedRetry` lines 569–610). The connector does **not**: `reloadActiveSubscriptions()` and `handleMessage()` read subscription config exclusively from Redis. If Redis is flushed, cold, or evicts `sub:*` keys (there's an admin `DELETE /redis`), the connector silently reloads nothing and all live upstream connections go dark until someone hits `/redis/reload`. Recovery is gated on Redis durability rather than the authoritative Postgres data.
*Recommendation:* Give the connector the dispatcher's Postgres fallback: on startup (and on a Redis miss) read the subscription row from Postgres and re-warm Redis, rather than treating a miss as "subscription does not exist."

**🔵 webhook-dispatcher concentrates four unrelated runtime concerns in one 917-line process**
*Area: `src/webhook-dispatcher/index.js`*
The dispatcher simultaneously owns: the `connection_events` consumer (delivery), the `pending_retries` poller, the **outbox drainer** (which publishes events the *connector* consumes — not the dispatcher's domain), and the `notification_attempts` poller. Colocating the outbox drainer couples connector event-delivery health to the dispatcher's deployment/scaling and mixes delivery logic, queue mechanics, and cross-service plumbing. It works and is multi-pod-safe, but cohesion is poor and the blast radius of a dispatcher bug now includes connector event propagation.
*Recommendation:* Extract the outbox drainer (and possibly the notification poller) into its own worker process/module, or at least separate files behind a shared "poller" abstraction. Not urgent at current scale.

### Top recommendations
1. Fix connector multi-pod duplication (bind connections to assigned partitions); until then document the single-replica constraint.
2. Make delivery dedup atomic: `UNIQUE(subscription_id, event_id)` + `INSERT … ON CONFLICT DO NOTHING`.
3. Close the DLQ loop (consumer/redrive or admin replay) and add `dlq_events` lag alerting.
4. Harden the event bus for prod (RF≥3, `min.insync.replicas=2`, `acks:'all'` + `idempotent:true`).
5. Rewrite README architecture/flow to match the outbox implementation; add `docs/ARCHITECTURE.md`/ADRs.
6. Give the connector a Postgres fallback on Redis miss; document ordering caveats (retried events overtake live ones).

---

## 2. Security — 🟡 Adequate

AnyHook is notably security-conscious for its size: parameterized SQL throughout (no injection found), scrypt password hashing with timing-safe comparison, a correct HMAC-SHA256 webhook signing scheme with timestamp/replay protection, JWT `token_version` revocation, a TOTP replay guard, envelope encryption for 2FA secrets, and consistent per-organization scoping on every tenant data query (no IDOR found). **The dominant residual risk is SSRF**: the URL allow-list is robust against numeric/IPv6 encoding tricks but is enforced only at create-time — no DNS-rebinding defense, no outbound redirect cap, no re-validation at connect time. Secondary concerns: per-account auth brute-force (login and 2FA are IP-rate-limited only) and an admin debug endpoint that dumps per-subscription webhook secrets.

### Strengths
- **SQL injection:** every query (`app.js`, `auth.js`, `quotas.js`, `rate-limit.js`, `notifications.js`, dispatcher) uses `pg` parameterization; even `ILIKE` search and dynamic `WHERE` clauses bind via params. No string-concatenated SQL.
- **Credential handling:** scrypt + `crypto.timingSafeEqual` (`passwords.js`), constant dummy-hash on login to prevent enumeration (`auth.js:361–365`), SHA-256 API keys never stored raw, AES-256-GCM envelope encryption for TOTP secrets with key rotation (`envelope.js`), peppered backup-code hashing (`totp.js`).
- **Webhook authenticity:** HMAC over `` `t.body` ``, timing-safe comparison with explicit length pre-check, `maxAgeSec` replay window (`webhook-signature.js:35–73`).
- **Session revocation:** `users.token_version` encoded in the JWT and re-checked every request; bumped on logout, password change, password reset, and 2FA disable.
- **Multi-tenant data access:** subscription, delivery, notification, api-key, and membership queries all filter by `req.auth.organizationId`; mutating routes use `pg_advisory_xact_lock` + `FOR UPDATE`. No missing tenant filter (IDOR) found.

### Findings

**🟠 SSRF: URL validation is create-time only — no DNS-rebinding defense, no redirect cap, no connect-time re-check**
*Area: `src/lib/url-validation.js`, `src/webhook-dispatcher/index.js`, `src/lib/notifications.js`, `src/subscription-connector/handlers/*`*
`isValidUrl()` is a synchronous hostname/IP check with no DNS resolution — the module's own docstring (lines 20–24) admits "an attacker can still defeat it by pointing a public hostname at a private IP (DNS rebinding)… Treat this as the first layer," but no second layer exists. (1) **TOCTOU:** validation runs at `POST /subscribe`; the outbound request happens later in the dispatcher (`axios.post(webhookUrl, …)` at line 392) against the value re-read from Redis/PG, never re-validated. (2) **No redirect cap:** neither the dispatcher nor `notifications.js sendSlackNotification` (`axios.post(pref.destination)`, line 81) sets `maxRedirects`, so axios follows up to 5 — a validated public URL returning `302 Location: http://169.254.169.254/latest/meta-data/iam/security-credentials/` bypasses the entire allow-list and can exfiltrate cloud IMDS credentials. (3) The connector handlers (`graphqlHandler.js:73–89`, `webSocketHandler.js:51`) open connections to `args.endpoint_url` with **no** SSRF check at connect time at all.
*Recommendation:* Resolve the hostname before connecting; reject if **any** resolved A/AAAA is private/loopback/link-local/CGNAT (reuse `isPrivateOrLoopbackHost` on the resolved IPs); pin and connect to that exact IP (custom axios `httpAgent` lookup / undici dispatcher). Set `maxRedirects: 0` on all outbound axios (dispatcher + Slack), or re-run the SSRF check on each redirect `Location`. Add the same guard at connect time in the handlers.

**🟡 Login and 2FA verification are rate-limited per-IP only — no per-account throttling or lockout**
*Area: `src/subscription-management/auth.js` (`/auth/login`, `/auth/2fa/verify-login`), `src/lib/rate-limit.js`*
Both endpoints are protected solely by `authRl`, an IP-keyed fixed-window limiter (~10/60s/IP). No per-account counter or lockout. An attacker rotating source IPs faces no per-target limit: a 6-digit TOTP with a ±1 step window (~3/10⁶ per guess) and a 5-minute pending token is brute-forceable at scale; password credential-stuffing against a specific user is unthrottled per-account. The TOTP replay guard prevents reusing a *captured* code, not online guessing. Additionally, `ipKeyFn` trusts `X-Forwarded-For`'s first token unconditionally (`rate-limit.js:51–56`) regardless of `TRUST_PROXY`, so a single attacker can spoof XFF to mint unlimited rate-limit buckets and evade even the IP limit.
*Recommendation:* Add a per-user failed-attempt counter (Redis or `users.failed_login_count`) with exponential backoff/temporary lockout on both password and 2FA verification. Only honor XFF when behind a trusted proxy (gate on the same `TRUST_PROXY` Express uses); otherwise fall back to `req.ip`.

**🟡 Admin `/redis` debug endpoints expose per-subscription `webhook_secret` verbatim**
*Area: `src/subscription-management/app.js` (`GET /redis`, `GET /redis/:key`)*
The subscription cache stores the full DB row including `webhook_secret`. `GET /redis` (lines 953–986) SCANs all keys and returns every value JSON-parsed; `GET /redis/:key` returns a single value. The `withoutSecret()` scrubber is applied only on the subscription REST routes, never on these admin dumps — so anyone with `ADMIN_API_KEY` can read every tenant's webhook signing secret, defeating the "shown only once" guarantee and enabling forgery of signed deliveries. These endpoints also expose the entire Redis keyspace. Bounded by the admin-key gate, but `ADMIN_API_KEY` is a single static shared secret with no rotation/audit and equal blast radius across all orgs.
*Recommendation:* Redact secret-bearing fields from the `/redis` dump (or remove the bulk endpoint — it's a debug convenience with cross-tenant secret exposure). Never return `webhook_secret` over any endpoint after creation. Scope/remove raw Redis introspection in production.

**🔵 `dispatchNotification` is referenced but never imported in `app.js` — quota_warning notifications silently never fire** *(also found by code-reviewer as 🟠; **confirmed by inspection**)*
*Area: `src/subscription-management/app.js`*
`app.js` imports only `makeEmailTransport` from `../lib/notifications`/`../lib/email` (line 27) but calls `dispatchNotification({…})` inside `notifyQuotaWarning` (line 191). `dispatchNotification` is undefined in scope → `ReferenceError`. It executes in a fire-and-forget promise with a trailing `.catch`, so the error is swallowed/logged rather than crashing — but the operator-facing "you're at 80% of your cap" alert is never delivered. A correctness/availability defect that silently disables a safety signal; the path is untested in this wiring.
*Recommendation:* Add `const { dispatchNotification } = require('../lib/notifications');`. Add a test asserting `notifyQuotaWarning` actually dispatches.

**🔵 Tenant isolation depends entirely on application-layer `WHERE` filters; no DB-level defense-in-depth (RLS)**
*Area: `migrations/` (no Row-Level Security), `app.js`, `auth.js`*
There is no Postgres RLS in any of the 17 migrations. All cross-tenant safety rests on each query including `AND organization_id = $N`. The current code does this consistently (no missing filter found), but the design is brittle: a single future query that forgets the predicate (a JOIN, a new analytics endpoint, an admin tool) becomes an immediate cross-tenant leak with no backstop. The denormalized `organization_id` on `delivery_events` multiplies the places the filter must be remembered.
*Recommendation:* Enable RLS on org-scoped tables (`subscriptions`, `delivery_events`, `api_keys`, `notification_preferences`, `pending_retries`) keyed off a per-request `SET LOCAL app.current_org` from `req.auth.organizationId`. At minimum, add integration tests asserting every org-scoped endpoint returns 404/empty for another org's resource IDs.

**⚪ Shipped `.env.example` contains a real-looking placeholder `JWT_SECRET` that satisfies the length check**
*Area: `.env.example`, `src/lib/jwt.js`*
`jwt.js` correctly enforces `JWT_SECRET >= 32` chars (refuses to boot otherwise). But `.env.example` sets `JWT_SECRET=please_change_me_to_a_long_random_string_at_least_32_characters` (a non-commented, ≥32-char value) while the genuinely sensitive secrets (`BACKUP_CODE_PEPPER`, `TOTP_SECRET_KEY`, `ADMIN_API_KEY`) are commented out. An operator who copies `.env.example` and fills only DB/Redis boots with a publicly-known JWT signing secret → anyone can forge session cookies for any user/org. The length gate passes, so there's no runtime warning. A deployment-hygiene footgun.
*Recommendation:* Comment out `JWT_SECRET` in `.env.example` (like the other secrets) so the app refuses to start until set, or reject the known placeholder at startup. Document a single `crypto.randomBytes` bootstrap step for all secrets.

### Top recommendations
1. Close the SSRF gap end-to-end (resolve-and-pin at connect time + `maxRedirects:0` on all outbound axios). Highest priority for an internet-facing webhook proxy.
2. Add per-account brute-force protection to login + 2FA; stop trusting XFF unless behind a configured trusted proxy.
3. Stop exposing `webhook_secret` over the admin `/redis` dump.
4. Fix the missing `dispatchNotification` import + add a regression test.
5. Add DB-level RLS (or cross-tenant negative tests) so isolation doesn't depend solely on hand-written filters.
6. Harden secret hygiene (comment out placeholder `JWT_SECRET` / reject the default at startup).

---

## 3. Backend Code Quality & Maintainability — 🟢 Strong

The backend is well-architected and unusually disciplined for its size: the outbox + `FOR UPDATE SKIP LOCKED` pattern is applied consistently; error handling around Kafka consumers and webhook delivery is deliberate (manual commits, idempotency checks, best-effort DB logging that never blocks delivery); resource lifecycle (DB pools, sockets, Kafka clients, metrics server, reconnect timers) is closed on graceful shutdown. The code is readable, heavily and accurately commented, and the lib modules are cohesive. **However, two concrete latent bugs escaped the test suite because the integration setup stubs out the exact behaviors they depend on** — a missing import that disables quota-warning notifications, and an advisory-lock unlock/lock argument mismatch that leaks session-level locks onto pooled connections.

### Strengths
- Outbox + `WITH due AS (… FOR UPDATE SKIP LOCKED) UPDATE … RETURNING` claim pattern implemented identically and correctly in all three drainers (dispatcher `pollRetryQueue`/`pollOutbox`, `notifications.pollNotificationAttempts`), incl. stale-lock sweeps and `GREATEST()` guards against retry-count regression.
- Webhook delivery error handling is robust: idempotency check on `(subscription_id, event_id)`, Redis-then-Postgres fallback at retry time, pre-serialized body so the HMAC matches exactly, best-effort `recordDelivery` so logging failures never block delivery.
- Graceful shutdown in every service with `Promise.allSettled` over all clients + a force-exit timeout; reconnect timers cancellable so `disconnect()` can't race a pending reconnect.
- Strong separation of concerns: `app.js` a pure factory taking injected clients (testable via supertest), `index.js` the only place real clients are constructed; lib modules small, single-purpose, unit-tested against RFC vectors.
- Security-sensitive flows careful: constant-time TOTP comparison + replay guard, `token_version` invalidation, per-org advisory locks around owner-demotion and quota checks, SSRF guard covering `inet_aton`/IPv6-mapped bypasses.

### Findings

**🟠 `dispatchNotification` is used in `app.js` but never imported — quota_warning notifications silently never fire** *(confirmed by inspection; see also Security ⚪)*
*Area: `src/subscription-management/app.js`*
`createApp()` wires `notifyQuotaWarning` (lines 190–204) to call `dispatchNotification({…})`, but `app.js` never requires it (only `webhook-dispatcher/index.js` imports it). When an org crosses 80% of its quota, the callback throws `ReferenceError`. The `.catch()` at line 203 can't help — the error is thrown synchronously while evaluating the call expression, before any promise exists — and `quotas.js` wraps the callback in its own try/catch (lines 144–148), so it's swallowed and logged. The feature is completely non-functional in production and fails silently. It escaped tests because the integration setup builds the app without `notifyQuotaWarning` and uses `limit:100000` so the threshold is never crossed.
*Recommendation:* Add `const { dispatchNotification } = require('../lib/notifications');`. Add an integration test driving an org past the warn threshold against a transport spy.

**🟠 Subscription-quota advisory lock is leaked: unlock uses raw orgId while lock uses `hashtext(orgId)`** *(also found by postgres-pro as 🟠; **confirmed by inspection**)*
*Area: `src/lib/quotas.js`*
In `makeSubscriptionQuotaCheck` the lock is acquired with `pg_advisory_lock($1, hashtext($2::text))` (lines 91–94) but released with `pg_advisory_unlock($1, $2)` passing the raw UUID as the second arg (lines 76–81). `pg_advisory_unlock(int4,int4)` will fail to coerce the UUID; the error is caught/logged, and `lockClient.release()` still returns the connection to the pool. Because advisory locks are **session-level**, the lock is never released and rides along with the pooled connection; subsequent requests on that backend accumulate un-released locks. The api-key variant (`makeApiKeyQuotaCheck`, line 174) and `/subscribe/bulk` (line 805) both correctly use `hashtext($2::text)` on **both** sides — making this a clear copy/edit slip. Masked by `tests/lib/quotas.test.js` because the pool stub treats any `pg_advisory_` SQL as a no-op.
*Recommendation:* Change the unlock to `pg_advisory_unlock($1, hashtext($2::text))`. Add a test (real Postgres or a stub distinguishing lock vs unlock keys) asserting `pg_advisory_unlock` returns true.

**🟡 Inconsistent `ROLLBACK` error handling: `auth.js` rollbacks can throw out of the catch and leave the request hanging**
*Area: `src/subscription-management/auth.js`*
`app.js` defensively writes every catch-block rollback as `await client.query('ROLLBACK').catch(() => {})`. `auth.js` does **not** — bare `await client.query('ROLLBACK')` (register line 307, 2fa/verify-setup 612, create-org 841, add-member 952, remove-member 1018, accept-invite 1683). If the underlying failure was connection-level (the common reason for landing in catch), the ROLLBACK itself rejects, escaping the catch. `client.release()` still runs in `finally`, but the response is never sent — the request hangs until socket timeout and the 500 JSON is lost.
*Recommendation:* Standardize on `await client.query('ROLLBACK').catch(() => {})`, or extract a shared `withTransaction(pool, fn)` helper guaranteeing BEGIN/COMMIT/ROLLBACK/release in one place, used across both files.

**🟡 No process-level `unhandledRejection` / `uncaughtException` handlers in any long-running service**
*Area: `src/webhook-dispatcher/index.js`, `src/subscription-connector/index.js`, `src/subscription-management/index.js`*
All three register SIGTERM/SIGINT but none register `process.on('unhandledRejection')` / `'uncaughtException'`. The codebase relies heavily on fire-and-forget promises with `.catch()`; a single missed `.catch()` — or a throw inside a `setInterval` callback — becomes an unhandled rejection. On Node ≥22 the default for `unhandledRejection` is to terminate, so one missed rejection in a poller can crash a worker with no structured log, no metric, and no winston flush.
*Recommendation:* Add `process.on('unhandledRejection', …)` (log) and `'uncaughtException'` (log + orderly shutdown) to each entrypoint; share a small bootstrap helper so all three install the same handlers.

**🟡 Rate-limit counter is non-atomic: `INCR` then a separate `EXPIRE` can leave a TTL-less key, permanently locking out an org**
*Area: `src/lib/rate-limit.js`*
`makeRateLimit` does `count = await redisClient.incr(key)` then, only when `count===1`, `await redisClient.expire(key, windowSec*2)` (lines 163–166). If the process crashes or Redis fails the `EXPIRE` between the two calls, the counter persists with no TTL; every subsequent request increments a key that never resets, so once it exceeds the limit the org is rate-limited forever for that key prefix. Contradicts the module's stated "fail open" intent.
*Recommendation:* Make increment+expire atomic — a small Lua script (INCR + conditional PEXPIRE) or `SET key 0 EX <ttl> NX` then INCR, or pipeline both in a MULTI.

**🔵 Handlers log full decoded source payloads at info level — log noise and potential sensitive-data exposure** *(also found by performance as 🟡)*
*Area: `src/subscription-connector/handlers/webSocketHandler.js`, `graphqlHandler.js`*
Both source handlers log the entire decoded upstream message at info on every event (`webSocketHandler.js:74–77` logs `decodedMessage`; `graphqlHandler.js:114–117` logs `JSON.stringify(data)` per "next"). For a busy subscription that's one full-payload line per event at default `LOG_LEVEL=info` — a throughput concern (synchronous `JSON.stringify` + console transport on the hot path) and a data-governance concern (third-party data with tokens/PII into stdout → ELK/Loki/Datadog).
*Recommendation:* Demote per-message payload logging to `debug`; keep counts/metrics at info, or log a bounded summary (event id, byte size). The prom-client counters already capture throughput.

**🔵 Repeated boilerplate: advisory-lock/release, `parseBrokers`, and Kafka manual-commit blocks are duplicated**
*Area: `src/lib/quotas.js`, `src/subscription-management/app.js`, `src/*/index.js`*
Three near-identical copies of the "connect a lockClient, define idempotent `release()`, attach to res.finish/close, acquire `pg_advisory_lock`" block exist (the two quota checks + `/subscribe/bulk`) — and the divergence between them is exactly what produced the unlock bug above. `parseBrokers()` is copy-pasted in all three entrypoints. The Kafka `eachMessage` wrapper (try handler / inc metric / commit offset+1 / catch+log) is duplicated between connector and dispatcher. Duplication here is a correctness risk, not just style — a fix to one copy leaves the others wrong.
*Recommendation:* Extract `withOrgAdvisoryLock(pool, orgId, key, res, log)`; move `parseBrokers` into a shared `lib/kafka.js`; factor the `eachMessage` manual-commit wrapper into a shared `runConsumer({consumer, handler, metric, log})`.

**⚪ Subscription input validation does not bound `args.headers` / nested structure**
*Area: `src/subscription-management/app.js`*
`validateSubscriptionInput` (lines 59–87) validates `connection_type`, `args.endpoint_url` (via the SSRF guard), `args.query` for graphql, and `webhook_url`, but does not constrain `args.headers` (shape, key/value types, count, total size) even though both handlers spread these into the outbound request. The `express.json` 1mb limit is the only backstop. Informational (the SSRF guard covers the destination), but unbounded/arbitrary-typed headers reaching an outbound client warrants an explicit allowlist/size check.
*Recommendation:* Add a lightweight schema check for `args.headers` (object of string→string, bounded count + total bytes); reject non-string values.

### Top recommendations
1. Fix the two latent bugs first (import `dispatchNotification`; correct `pg_advisory_unlock` to `hashtext($2::text)`) — pair each with a test exercising the previously-stubbed behavior.
2. Standardize transaction teardown across `app.js`/`auth.js` (shared `withTransaction`, or `.catch(() => {})` on every ROLLBACK).
3. Install `unhandledRejection` + `uncaughtException` handlers (wired to graceful shutdown) in all three entrypoints.
4. Make the Redis rate-limit INCR+EXPIRE atomic.
5. Reduce the duplication that is actively causing divergence bugs (`withOrgAdvisoryLock`, `parseBrokers`, `eachMessage` wrapper).
6. Demote per-message payload logging from info to debug.

---

## 4. Performance & Scalability — 🟠 Needs improvement

The data plane has the right architectural bones for scale (Kafka keyed by `subscription_id`, transactional outbox, `FOR UPDATE SKIP LOCKED` queues, partial indexes, per-org override caching), but several concrete bottlenecks cap real throughput well below what "high-throughput real-time system" implies. The two hardest ceilings: **(1)** fixed `container_name` on every worker pins the connector and dispatcher to exactly one instance each, so the 8-partition Kafka layout cannot be parallelized; **(2)** the dispatcher's `eachMessage` with no `partitionsConsumedConcurrently` makes webhook delivery a strictly sequential, head-of-line-blocked loop where one slow/30s-timeout endpoint stalls every other subscription. Combined with unbounded `delivery_events` growth and verbose per-message info logging, the system degrades under load before exhausting CPU. **None of these are deep rewrites — they're config/topology/loop-shape changes.**

### Strengths
- Event bus correctly keyed (`key=subscriptionId` on `connection_events`/`subscription_events`); outbox preserves `message_key` — partition-ready even though the runtime can't yet use it.
- Queue claim pattern well-built for multi-pod scaling (`pending_retries`, `outbox_events`, `notification_attempts`: single-statement CTE + `FOR UPDATE SKIP LOCKED` + stale-lock reclaim, backed by partial indexes, e.g. `idx_pending_retries_due ON (next_attempt_at) WHERE locked_at IS NULL`).
- Sensible hot-path caching: Redis-first subscription lookups with Postgres fallback that re-warms (`processClaimedRetry`); rate-limit per-org override has a 5s in-memory TTL cache bounded at 1024 orgs.
- Bounded outbound IO: axios timeouts everywhere (30s webhook, 10s Slack); delivery latency on a well-bucketed Prometheus histogram (`webhook_delivery_duration_seconds`).
- Correct read indexing for the common dashboard query: `idx_delivery_events_subscription_id (subscription_id, created_at DESC)` and `idx_delivery_events_org_created (organization_id, created_at DESC)`.

### Findings

**🔴 Connector + dispatcher are hard-pinned to a single replica by `container_name` — the 8-partition Kafka layout cannot be parallelized**
*Area: `docker-compose.yml` + `src/subscription-connector/index.js` + `src/webhook-dispatcher/index.js`*
`createKafkaTopics()` provisions 8 partitions per topic "so up to N connector/dispatcher pods can run in parallel" (`subscription-management/index.js:123–148`), and the queue-claim code is explicitly multi-pod-safe. But `docker-compose.yml` sets a fixed `container_name:` on subscription-connector (line 35) and webhook-dispatcher (line 64). `docker compose up --scale subscription-connector=4` fails with a name collision, so the documented horizontal-scaling path is unreachable. Result: all upstream connections live in one connector process, all `connection_events` are consumed by one dispatcher; 7 of 8 partitions per topic go to that single consumer. Scaling ceiling is one CPU core per stage regardless of partition count.
*Recommendation:* Remove `container_name` from the stateless workers (use `deploy.replicas`, Compose `--scale`, or k8s Deployments). Confirm a 2+ replica run rebalances partitions. Document the intended replica count alongside `KAFKA_PARTITIONS`.

**🔴 Webhook delivery is a strictly sequential per-message loop — one slow endpoint head-of-line-blocks every subscription on the consumer**
*Area: `src/webhook-dispatcher/index.js` (`consumer.run eachMessage`, lines 127–152, 322–332)*
The dispatcher uses `eachMessage` with `await handleConnectionEvent(payload)` then `await consumer.commitOffsets(…)`, and `partitionsConsumedConcurrently` is set nowhere. `eachMessage` processes one message at a time across all assigned partitions, and each call does a synchronous `await axios.post(webhookUrl, …, { timeout: 30000 })`. A single unresponsive receiver blocks the entire dispatcher for up to 30s while every other org's events queue behind it. Effective throughput ≈ `ceil(1 / mean_webhook_latency)` deliveries/sec per dispatcher — at 200ms mean ≈ ~5/sec for the whole system (compounded by the single-replica pin). No per-endpoint concurrency, no batching, no independent-partition fan-out.
*Recommendation:* (1) Set `partitionsConsumedConcurrently` to the partition count so independent partitions deliver in parallel; (2) within a partition, decouple delivery from the consume loop with a bounded worker pool (e.g. `p-limit`) so N POSTs proceed concurrently while committing offsets safely. Lower the 30s timeout to 5–10s so a dead endpoint fails fast into the retry queue.

**🟠 All upstream source connections are held in one process's in-memory maps — no sharding, unbounded heap, lost on restart**
*Area: `src/subscription-connector/handlers/{graphqlHandler,webSocketHandler}.js` + `index.js`*
`GraphQLHandler.wsClients/activeSubscriptions` and `WebSocketHandler.wsClients/subscriptions/intentionalClose` are plain objects/Maps on a single instance. Every active upstream for the entire tenant base is one OS socket + closures in that one process. No mechanism distributes subscriptions across instances by partition (and the topology pin prevents >1 anyway). On restart, `reloadActiveSubscriptions()` SCANs every `sub:*` and re-opens ALL from one process — a thundering reconnect storm and a large synchronous startup. Memory/FD limits become the ceiling on total subscriptions; a single crash drops every live connection at once.
*Recommendation:* Shard upstream connections by Kafka partition ownership (each instance only owns subscriptions whose id maps to a partition it consumes). Cap concurrent reconnects on reload (batch with a concurrency limit). Add an open-connection gauge per instance for capacity planning.

**🟠 `delivery_events` grows unbounded with full request/response bodies and no retention or partitioning** *(also found by postgres-pro as 🟠)*
*Area: `migrations/20250324000000_create_delivery_events.sql` + `src/webhook-dispatcher/index.js recordDelivery`*
Every delivery attempt (initial AND each retry) inserts a row storing `request_body` + `response_body` truncated to 10KB each. No retention, TTL, or range partitioning anywhere. At 100 deliveries/sec that's ~8.6M rows/day, each up to ~20KB TEXT — the table and its 4 indexes grow without bound, inflating write latency on the hottest path and bloating the indexes the dashboard depends on. The org-wide `/deliveries/stats` query (`app.js:490–522`) runs lifetime `FILTER` aggregations with no time bound — it scans every row for the org, so its cost rises monotonically forever.
*Recommendation:* Range-partition `delivery_events` by `created_at` (monthly/weekly) + a retention job dropping old partitions (cheap DDL vs row-by-row DELETE). Consider not storing success-case response bodies. Add a rolled-up summary table (per org/day counts + avg latency) so `/deliveries/stats` reads aggregates.

**🟡 Per-message info logging with full payload `JSON.stringify` on every hot-path event** *(also found by code-reviewer as 🔵)*
*Area: handlers + dispatcher + `src/lib/logger.js` (default level 'info')*
Logger defaults to info. Both source handlers log at info on every message AND serialize the full payload; `raiseConnectionEvent` paths plus per-delivery info lines add more. In production JSON mode each event triggers multiple synchronous console writes plus a redundant `JSON.stringify` (the payload is stringified again for Kafka). At high event rates this is meaningful CPU + event-loop blocking on stdout — a cost multiplier on top of the sequential delivery loop.
*Recommendation:* Demote per-message/per-delivery logs to debug; keep info for lifecycle (connect/disconnect/DLQ). Never `JSON.stringify` payloads at info. Confirm production sets `LOG_LEVEL=warn`.

**🟡 Quota + bulk paths hold a dedicated pooled connection for the full HTTP request lifetime under a per-org advisory lock**
*Area: `src/lib/quotas.js` (`makeSubscriptionQuotaCheck`/`makeApiKeyQuotaCheck`) + `app.js /subscribe/bulk`*
The quota middleware does `pool.connect()`, takes a session-level `pg_advisory_lock`, and only releases on res `finish`/`close` — so the connection is checked out for the **entire** request including the downstream INSERT + Redis writes + JSON flush, not just the count query. `/subscribe/bulk` additionally runs up to 100 INSERT + Redis SET round-trips serially while holding the lock. Under a burst, the 20-slot pool can be exhausted by held quota connections, and bulk imports serialize an org's other writes behind one long request. Read-heavy dashboard traffic shares the same 20-connection pool.
*Recommendation:* Shorten the lock hold: acquire `pg_advisory_xact_lock` and run count+INSERT in one short transaction, commit, release — don't hold across the response flush. For bulk, batch INSERTs (multi-row VALUES) and pipeline the Redis SETs. Size the pool per workload (separate read/write pools or raise max).

**🔵 Kafka producer uses defaults — no idempotent producer, no explicit acks, no compression/linger for the high-volume `connection_events` topic**
*Area: `src/subscription-connector/handlers/baseHandler.js raiseConnectionEvent` + producers in `index.js`*
Producers are `kafka.producer({ allowAutoTopicCreation: false })` with no `idempotent:true`, no acks/`maxInFlightRequests` tuning, no compression. `connection_events` is the highest-volume topic (one publish per upstream message) and each `raiseConnectionEvent` sends a single-message batch with no linger/batching, so every source event is its own produce round-trip. Leaves broker throughput and network on the table.
*Recommendation:* Enable compression (gzip/lz4/snappy), especially for `connection_events`; consider `idempotent:true` + `acks:'all'`. Allow kafkajs to batch (don't await each single-message send in lockstep). Re-run the stress harness with compression to quantify.

### Top recommendations
1. Unpin the workers (remove `container_name`; use replicas/`--scale`) — highest-leverage change, unblocks every horizontal-scaling assumption.
2. Make webhook delivery concurrent (`partitionsConsumedConcurrently` + bounded worker pool) and cut the 30s timeout to ~5–10s.
3. Add retention + range-partitioning to `delivery_events`; back `/deliveries/stats` with a rollup table.
4. Shard upstream connections by partition ownership; cap concurrent reconnects on reload.
5. Demote per-message info logs to debug; stop `JSON.stringify`-ing payloads at info.
6. Shorten quota/bulk advisory-lock connection holds; batch bulk inserts + pipeline Redis; right-size the pool.

---

## 5. Data Layer & Migrations — 🟢 Strong

The schema is well-normalized, multi-tenant aware, and shows clear domain expertise: the outbox, `pending_retries`, and `notification_attempts` tables all use the same `FOR UPDATE SKIP LOCKED` + partial-index + stale-lock-sweep pattern, FKs are consistently indexed, and the later migrations are written with explicit, accurate notes about lock behavior and backward compatibility. **The two main risks are operational rather than structural:** an unbounded, unpartitioned `delivery_events` table whose org-wide aggregate has no time bound, and the advisory-lock unlock-key bug that leaks session-level locks. The original 2024 `subscriptions` table predates later conventions (`TIMESTAMP` without time zone, no `gen_random_uuid` default).

### Strengths
- Outbox/DLQ/retry design is textbook: `outbox_events`, `pending_retries`, `notification_attempts` share a clean claim pattern, each backed by a tailored partial index on the unclaimed-and-due subset plus a second for the stale-lock sweep.
- FK + hot-path indexing thorough and intentional: every `organization_id`/`user_id`/`subscription_id` FK has a supporting index; `delivery_events` carries both `(subscription_id, created_at DESC)` and `(organization_id, created_at DESC)`; partial indexes (unused backup_codes, enabled notification_preferences, revoked api_keys) match the code's WHERE clauses.
- Constraint/integrity discipline high: CHECK constraints enumerate every status/role/channel enum; token/secret tables store only SHA-256 hashes with UNIQUE on the hash; security invariants (`email_lower_unique` functional index, `totp_replay_guard` via `last_totp_step`, `token_version`) enforced at the DB layer.
- Migration authoring careful and zero-downtime conscious: the `VARCHAR(255)→TEXT` widening is documented as metadata-only (no rewrite); multi-tenancy backfills via a deterministic Default org then promotes to NOT NULL; the `email_lower_unique` migration deliberately fails loudly on pre-existing case-dup rows instead of silently deleting data.
- Idiomatic types for modern Postgres: `TIMESTAMPTZ` everywhere from 2025 on, JSONB for args/payload, `gen_random_uuid()` PKs, `TEXT[]` for the growable notification taxonomy, `BIGINT` for the TOTP step counter with rationale.

### Findings

**🟠 Subscription-quota advisory lock is never released (lock/unlock key mismatch) → pool connections leak held locks** *(also found by code-reviewer as 🟠; **confirmed by inspection**)*
*Area: `src/lib/quotas.js`*
Lock: `SELECT pg_advisory_lock($1, hashtext($2::text))` (line 92). Release: `SELECT pg_advisory_unlock($1, $2)` passing the raw `req.auth.organizationId` UUID as the int4 arg (lines 76–81) instead of `hashtext($2::text)`. The keys differ, `pg_advisory_unlock` returns false, the lock is NOT released; `lockClient.release()` returns the connection to the pool still holding it. Consequences: (1) every `/subscribe` permanently holds one advisory lock on its pooled connection; once all 20 pooled connections have served a subscribe, the org-level lock on line 92 blocks forever (or until that backend dies) and the failing-open catch silently disables quota enforcement; (2) advisory locks accumulate in `pg_locks`. The comment at lines 78–79 even describes the intended `hashtext` behavior, confirming the literal arg is a mistake. The api-key path does it correctly on both sides.
*Recommendation:* `SELECT pg_advisory_unlock($1, hashtext($2::text))` with the same params. Better: switch both quota paths to `pg_advisory_xact_lock` inside the create handler's transaction so lock lifetime is bounded and cannot leak across pool checkouts. Add a regression test asserting no leftover advisory locks after a 2xx `/subscribe`.

**🟠 `delivery_events` is unbounded and unpartitioned; org-wide stats query has no time predicate → full-table scan that degrades with tenant age** *(also found by performance as 🟠)*
*Area: `migrations/20250324000000_create_delivery_events.sql`, `src/subscription-management/app.js`*
`delivery_events` grows one row per attempt (every webhook, every retry) with no retention/partitioning/cleanup (only jest TRUNCATE between tests). The org dashboard summary (`app.js:493–505`) runs `SELECT COUNT(*) FILTER(…) … WHERE organization_id = $1` with **no** `created_at` bound, so it scans and aggregates every row the org ever produced; the 24h/7d figures are FILTERs over that same full scan. `idx_delivery_events_org_created` helps the bounded queries but cannot help this unbounded aggregate. At modest volume this becomes a multi-second dashboard query and a growing autovacuum/bloat burden. `request_body`/`response_body` TEXT inflate row width.
*Recommendation:* (1) Bound the dashboard summary to a window (e.g. last 30 days) so it uses `idx_delivery_events_org_created`; consider a covering index `(organization_id, created_at DESC, status)` or a rollup/materialized summary table. (2) Range-partition by `created_at` (monthly) with DROP PARTITION aging, or scheduled DELETE older than N days.

**🟡 Inconsistent timestamp type and missing defaults on the original `subscriptions` table**
*Area: `migrations/20240930142437_create_subscriptions_table.sql`*
Uses `created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP` (WITHOUT TIME ZONE), whereas every table from 2025 on uses `TIMESTAMPTZ`. A `timestamp`-without-tz stores wall-clock with no offset; if app servers and DB session run different time zones, `created_at DESC` ordering and `created_at > NOW() - INTERVAL` comparisons become ambiguous. The table also lacks `DEFAULT gen_random_uuid()` on its PK (every later table has it), and originally had `VARCHAR(255)` on `webhook_url`/`connection_type` (since corrected by `20260501`).
*Recommendation:* `ALTER COLUMN created_at TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC'` (pick the zone the data was written in). It's a column rewrite — schedule as a maintenance-window migration. Optionally add the `gen_random_uuid()` default for symmetry.

**🟡 `delivery_events.organization_id` is denormalized but not enforced consistent with `subscriptions.organization_id`**
*Area: `migrations/20260427000000_add_multi_tenancy.sql`*
The migration denormalizes `organization_id` onto `delivery_events` (and `pending_retries`) to keep dashboard plans flat — reasonable, but nothing guarantees a row's `organization_id` matches its subscription's. Both are independent FKs to `organizations`, and `recordDelivery()` inserts whatever `organization_id` the caller passes (sourced from the Redis cache). A bug or stale cache could write a row attributed to the wrong tenant, and because the dashboard filters ONLY on `delivery_events.organization_id`, a mis-attributed row leaks across the tenant boundary in the UI. No composite FK or trigger ties the two together.
*Recommendation:* Add a composite FK `(subscription_id, organization_id) REFERENCES subscriptions(subscription_id, organization_id)` (needs a unique constraint on those columns) so an org/sub mismatch is rejected at INSERT. Same for `pending_retries`. Makes tenant isolation a schema guarantee.

**🔵 `notification_attempts.payload` stores a full event snapshot as JSONB per attempt with no retention**
*Area: `migrations/20260507000000_add_notification_attempts.sql`*
Each attempt persists a JSONB `payload` snapshot so retries can re-issue without re-reading the source. Combined with no retention, every DLQ/failed/quota_warning notification leaves a permanent JSONB row. Volume is far lower than `delivery_events` so not urgent, but it's the same unbounded-growth pattern, and JSONB rows over the TOAST threshold add out-of-line storage. The `idx_notification_attempts_due` partial index correctly narrows to pending/failed + unclaimed, but terminal rows accumulate under the org index.
*Recommendation:* Add a cleanup job deleting terminal (delivered/dlq) rows older than N days, or archive. If the payload only needs a few scalar fields, store those columns explicitly instead of the whole blob.

**🔵 `users.totp_secret` stored in plaintext (acknowledged in-migration); `email_lower` index transition is correct but worth verifying post-deploy**
*Area: `migrations/20260430000000_add_totp_2fa.sql`, `migrations/20260504000000_users_email_lower_unique.sql`*
(1) `totp_secret` is a Base32 TOTP shared secret stored plaintext; the migration flags this as a future KMS/envelope-encryption TODO (lines 13–15). A DB read (backup leak, replica, injection) yields working 2FA secrets, partially defeating 2FA. The repo has `src/lib/envelope.js`, so the primitive exists. (2) The `email_lower_unique` migration drops the bare-column UNIQUE (`users_email_key`) and the old non-unique `idx_users_email_lower`, replacing both with a UNIQUE functional index — correct, and the app already queries `LOWER(email)=LOWER($1)`. Caveat: `DROP CONSTRAINT IF EXISTS`/`DROP INDEX IF EXISTS` rely on the default name `users_email_key`; if an environment named it differently the drop silently no-ops and a redundant unique constraint could linger.
*Recommendation:* (1) Encrypt `totp_secret` at rest using `envelope.js` (store ciphertext + key id), as the migration anticipates. (2) After deploying `email_lower_unique`, verify in each environment (catalog check) that the old constraint/index are actually gone.

### Top recommendations
1. Fix the subscription-quota `pg_advisory_unlock` to use `hashtext($2::text)` (or move to `pg_advisory_xact_lock`).
2. Add retention + partitioning for `delivery_events`.
3. Bound the org-wide dashboard summary to a time window + back it with an index/rollup.
4. Enforce tenant isolation structurally with a composite FK on `delivery_events`/`pending_retries`.
5. Migrate legacy `subscriptions.created_at` to `TIMESTAMPTZ`.
6. Encrypt `users.totp_secret` at rest via `envelope.js`; add a retention sweep for terminal `notification_attempts`.

---

## 6. Testing & Quality Assurance — 🟠 Needs improvement

AnyHook has a genuinely strong test foundation for its security primitives and management API: SSRF `url-validation`, HMAC `webhook-signature`, JWT/TOTP/password libs, and multi-tenant isolation are tested with disciplined negative/edge-case coverage and a mature integration harness (real Postgres + injected Redis/Kafka stubs, supertest). **However, the two services that embody the product's core purpose — the webhook-dispatcher and the subscription-connector — have zero direct tests, and the Jest coverage config deliberately excludes them**, so the reported coverage number masks the highest-risk code. The unit/integration balance is good and the e2e/a11y layer is a nice add, but the test pyramid has a hole exactly where a delivery bug would hurt most.

### Strengths
- SSRF defense rigorously tested: `tests/lib/url-validation.test.js` uses parametrized tables covering RFC1918/loopback/IMDS/CGNAT boundaries plus hard bypass forms (decimal-int `2130706433`, octal, hex, `127.1`, IPv6-mapped `[::ffff:7f00:1]`).
- Webhook signing covered with proper negative paths: tampered-body/wrong-secret rejection, replay-window enforcement, every malformed/missing-header/missing-secret branch with distinct reason codes.
- Multi-tenancy isolation tested as a first-class concern: cross-org 404s (no existence leak), `organization_id` taken from `req.auth` not the body (forgery attempt), `webhook_secret` stripped from responses, RBAC owner-overthrow/last-owner protections.
- The integration harness (`tests/integration/setup.js`) is well-engineered: real PG, a faithful in-memory Redis stub (incl. SCAN MATCH glob semantics), no-op Kafka, a controllable `fakeEmailTransport` with three failure modes, TRUNCATE-between-tests isolation — the team already has the tooling to test the dispatcher/connector by DI.
- Quota middleware tested for fail-OPEN behavior, the `>=` boundary, per-org overrides, and the auth-missing skip path.
- CI gates publish on backend lint + tests (with a Postgres service so integration tests run) + dashboard lint/typecheck/vitest/Playwright, incl. axe-core a11y with serious/critical as the failing bar.

### Findings

**🔴 webhook-dispatcher has zero tests — the entire delivery, retry, DLQ, and idempotency engine is unverified**
*Area: `src/webhook-dispatcher/index.js` (no corresponding test file)*
A grep across `tests/` for `handleConnectionEvent`, `sendWebhook`, `sendToDLQ`, `processClaimedRetry`, `claimDueRetries`, `enqueueRetry`, `pollOutbox` returns no matches. This ~917-line file is the product's reason for existing and contains the most correctness-critical branching: the duplicate-delivery idempotency skip, the retry backoff ladder `[15,60,120,360,720,1440]`, the `GREATEST(retry_count)` ON CONFLICT clobber-guard, the retrying→dlq transition at `retryCount===maxRetries`, the 'failed'-vs-'dlq' distinction (subscription-deleted-mid-retry), the truncated-body 'cannot parse → DLQ' branch, and the Redis-miss → Postgres-fallback → re-warm logic. A regression in any of these silently drops or double-fires customer events. All testable today by injecting mock pg/redis/axios/producer.
*Recommendation:* Add a `tests/webhook-dispatcher/` suite (export/extract the pure functions) exercising: success records `status='success'`; first-failure enqueues a retry; idempotency skip when a row exists; retrying→dlq on the final attempt; the GREATEST guard against a stale lower retry_count; the subscription-deleted 'failed' branch; the outbox drainer's claim/deliver/mark + failure paths. Mock axios for 200/500/timeout/connection-refused.

**🟠 Subscription-connector and both source handlers (GraphQL/WebSocket) are untested — only the reconnect timer in isolation is covered**
*Area: `src/subscription-connector/index.js`, `handlers/{webSocketHandler,graphqlHandler,baseHandler}.js`*
`tests/connector/reconnect.test.js` thoroughly tests `ReconnectScheduler` (pure timer state machine), but nothing tests the handlers that USE it or the Kafka consumer that drives them. Untested: `handleMessage`'s topic dispatch and graceful-return branches; the manual-commit-even-on-error contract that prevents partition lockup; `reloadActiveSubscriptions`' `SCAN MATCH 'sub:*'` filter (the comment warns that without the prefix it would JSON.parse rate-limit counters and fan out to every upstream — a serious incident, untested); WebSocketHandler's event_type filtering, `intentionalClose` set, `on('close')→_scheduleReconnect` wiring, and constructor-throw → schedule-retry path; `baseHandler.raiseConnectionEvent` generating the `eventId` the dispatcher's idempotency depends on; GraphQLHandler's disconnect-before-reconnect.
*Recommendation:* Add handler unit tests with a mock ws/graphql-ws client (EventEmitter stub) asserting non-matching event_type dropped vs matching calls `raiseConnectionEvent`; bad JSON swallowed; unexpected close schedules reconnect but intentional close does not; `connect()` on an already-tracked id tears down the prior client. Add a `handleMessage` test covering each topic + the no-Redis-entry unsubscribe fallback. Assert `reloadActiveSubscriptions` only touches `sub:*` keys.

**🟠 Coverage instrumentation excludes the riskiest code, so the reported coverage number is misleading**
*Area: `jest.config.js` (`collectCoverageFrom`)*
`collectCoverageFrom` is scoped to `['src/lib/**/*.js']` only. The entire `src/webhook-dispatcher/`, `src/subscription-connector/`, and `src/subscription-management/` trees are excluded from the denominator. A green "high coverage" report reflects only the helpers — the dispatcher/connector could be at 0% and the headline wouldn't move. There's also no `coverageThreshold`, so `test:coverage` (run in CI) can't fail on a regression.
*Recommendation:* Broaden `collectCoverageFrom` to include the three service dirs (excluding `src/test/**` harness scripts). Once dispatcher/connector tests land, add a `coverageThreshold` (realistic floor, e.g. global lines 60% + a higher per-dir floor for `src/lib`) wired into the backend-tests CI job as a hard gate.

**🟡 No test asserts the dispatcher's outbound `webhook_url` is SSRF-safe at send time (TOCTOU / DNS-rebinding boundary)**
*Area: `src/webhook-dispatcher/index.js` (`sendWebhook`) vs `src/lib/url-validation.js`*
`isValidUrl` is only referenced in `src/subscription-management` — it validates at create/update time. The dispatcher reads `webhook_url` from Redis and POSTs with no re-validation. The module's own comment flags the DNS-rebinding defeat and that a robust defense must re-check at connect time. So even though create-path SSRF tests pass, there's no test (and arguably no code) guarding the actual outbound request against a hostname that resolves to a private/IMDS address at delivery time, or a `webhook_url` mutated in Redis out-of-band.
*Recommendation:* Decide the control (re-validate/pin in `sendWebhook`, refuse private targets), then add a dispatcher test asserting a cached subscription whose `webhook_url` points at a private/IMDS address is NOT delivered. At minimum, a regression test documenting current behavior so the gap is visible.

**🟡 Recently shipped notification persistence/retry engine has only format-helper tests, not state-machine tests**
*Area: `src/lib/notifications.js` (`pollNotificationAttempts`, `dispatchNotification`) — `tests/lib/notifications.test.js`*
Recent commits added persisted+retried notification attempts ("closes fire-and-forget gap"), failed/quota_warning events, and a pending gauge. But the test covers only `formatSlackPayload`/`formatEmailBody` (pure string formatting). A grep for `pollNotificationAttempts`/`dispatchNotification` in `tests/` returns nothing. The backoff ladder (1m→5m→30m→2h→DLQ), the claim + stale-lock reclaim, the max_attempts terminal transition, and the email-vs-Slack dispatch against `notification_preferences` are all unverified — the newest, most stateful code is the least tested.
*Recommendation:* Add tests (the harness's `fakeEmailTransport` + a mock pool already support this) driving an attempt through transient failure → retry scheduled with next backoff → success clears it, and failure past max_attempts → terminal. Cover `dispatchNotification` fan-out: only channels present in preferences are attempted; a thrown channel error is swallowed (best-effort).

**🔵 Dashboard E2E is a thin happy-path slice; key authenticated flows and error/empty states are under-covered**
*Area: `dashboard/e2e/` (login, two-factor, subscription-create, accessibility specs)*
9 component tests + 2 lib tests (vitest) and 4 Playwright specs (login, subscription-create, 2FA, axe smoke) — all against fully mocked 200 backends. No e2e coverage of failure UX (400 SSRF rejection, 429 quota, 401 mid-session expiry, network error), no delivery-history/stats interaction, no org-switching, no API-key create/revoke. Component tests are sensibly chosen but skew presentational.
*Recommendation:* Add Playwright specs for the negative branches the backend already enforces (SSRF 400, quota 429, expired-session redirect), plus org-switch and api-key lifecycle, reusing the existing `page.route` mocking pattern.

### Top recommendations
1. Write a webhook-dispatcher test suite (delivery success/failure, backoff ladder, idempotency skip, retrying→dlq, GREATEST guard, subscription-deleted path, outbox drainer) — highest-leverage gap.
2. Fix `jest.config.js`: broaden `collectCoverageFrom` to the service dirs, then add a `coverageThreshold` CI gate.
3. Add connector + handler unit tests (topic dispatch + graceful-error branches, the `sub:*` reload filter, event_type filtering + reconnect wiring, `eventId` generation).
4. Add state-machine tests for the notification persistence/retry engine (not just format helpers).
5. Decide and test the outbound SSRF control in the dispatcher.
6. Extend dashboard Playwright to negative/error UX + org-switch + api-key lifecycle.

---

## 7. Operations & Deployment Readiness — 🟠 Needs improvement

Strong operational instincts for a ~7k-LOC project: multi-stage non-root Docker images, health-gated `depends_on`, a deliberate liveness/readiness split, multi-pod-safe pollers, structured JSON logging, graceful SIGTERM handlers, and a Prometheus alert set that maps 1:1 to a real runbook. **However, there is a hard, ship-blocking defect:** the in-process DB migration runner depends on `node-pg-migrate`, a devDependency the production Dockerfile prunes out — so `subscription-management` crashes on first boot in the published image. Combined with the absence of a `.dockerignore` (which bakes `.env` and local `node_modules` into the image), no container resource limits, no image scanning/signing in CI, and no actual deploy step, the stack is not yet ready for a reliable production rollout.

### Strengths
- Dockerfiles textbook: multi-stage (deps/builder/runner), pinned base (`node:22-bookworm-slim`), explicit non-root user (uid 1001) in backend and dashboard, prod `NODE_ENV`, per-service entrypoint reuse from one image.
- Liveness vs readiness correctly separated (`/health/live` no deps at `app.js:245`; `/health` probing Postgres+Redis returning 503 at :254); compose healthcheck uses `/health/live` to avoid dependency blips cascading into restart loops.
- Graceful shutdown in all three services with SIGTERM/SIGINT, a 10s force-exit watchdog, poller teardown before client disconnect, `Promise.allSettled` cleanup fan-out.
- Solid observability: prom-client default + custom metrics on an internal-only 9090 port (not publicly mapped); `prometheus/alerts.yml` defines page/ticket-tiered alerts (API down, 5xx rate, p95 latency, outbox backlog, retry-queue growth, connector error rate, event-loop lag) each cross-referenced to a concrete `docs/RUNBOOK.md` section with copy-paste SQL.
- Data tier hardened by default: Postgres/Redis/Kafka published ports bind to `127.0.0.1` unless `DATA_BIND` is overridden; named volumes; pinned image tags (`postgres:17.2`, `redis:7.4.5`, `bitnami/kafka:3.9.1`). CI publishes `:latest` + immutable `:sha-<commit>` enabling rollback by re-tag.

### Findings

**🔴 Production image cannot run migrations — `node-pg-migrate` is pruned, boot will crash**
*Area: `Dockerfile` + `src/subscription-management/index.js` + `package.json`*
`subscription-management` runs migrations on boot via `applyMigrations()` (`index.js:108–121`), which shells out to `npm run migrate` → `node-pg-migrate up` (`package.json:11`). But `node-pg-migrate` is in **devDependencies** (`package.json:67`), and the production Dockerfile runs `npm prune --omit=dev` (line 21) before copying `node_modules` into the runner. The binary does NOT exist in `ghcr.io/moesaleh/anyhook:latest`, so `exec('npm run migrate')` fails, `applyMigrations()` rejects, and the startup IIFE hits `process.exit(1)` (`index.js:171–174`). The API container crash-loops on first boot in production. (The local `node_modules/.bin/node-pg-migrate` masks this in dev/test where dev deps are installed.)
*Recommendation:* Move `node-pg-migrate` to `dependencies`, OR (preferred) decouple migrations from boot — run as a dedicated one-shot job/init-container (a compose `migrate` service or CI/CD pre-deploy step) using `npx node-pg-migrate up`. Add a smoke test that runs the published image and asserts the API reaches "listening."

**🟠 No `.dockerignore` — secrets and local `node_modules` baked into image layers**
*Area: `Dockerfile` (build context) + repo root*
No `.dockerignore` at the repo root or in `dashboard/`. The backend builder does `COPY . .` (line 18), so the entire tree — including a local `.env` (JWT_SECRET, ADMIN_API_KEY, POSTGRES_PASSWORD, SMTP creds, TOTP_SECRET_KEY), `.git` history, the host's `node_modules`, test fixtures, CI files — is sent to the daemon and embedded in an intermediate layer. Even though the runner only COPYs `./src`, `./migrations`, `./scripts`, the secret-bearing `.env` is exposed in the builder layer; the dashboard build (`COPY . .`) has the same problem. A credential-leak and image-bloat/reproducibility risk.
*Recommendation:* Add `.dockerignore` (root + dashboard) excluding at least: `.env`, `.env.*`, `node_modules`, `.git`, `coverage`, `tests`, `*.md`, `.github`. Shrinks context, speeds builds, prevents secret leakage, improves cache hit-rate.

**🟠 Migrations run on app boot with no concurrency guard — unsafe for the documented multi-pod scaling**
*Area: `src/subscription-management/index.js` (`applyMigrations`) + `docs/RUNBOOK.md`*
`applyMigrations()` runs inside startup (`index.js:163`) before the server listens. The architecture advertises horizontal scaling (`KAFKA_PARTITIONS` default 8, "up to N consumer pods can run in parallel"). If more than one subscription-management replica starts concurrently (rolling deploy, autoscale, cold start), multiple `node-pg-migrate up` processes race the same DB. It does take a lock, but coupling schema migration to every API pod's boot means a slow/locked migration blocks readiness of all API pods, and a failed migration crash-loops all of them. There's also no migration on the connector/dispatcher images though they share schema.
*Recommendation:* Extract migrations into a single pre-deploy job (CI/CD step or one-shot k8s Job / compose `migrate` profile) that runs once per release and gates the rollout. App pods start assuming the schema is current. Also resolves the dev-dependency pruning issue if the job uses an image/stage retaining `node-pg-migrate`.

**🟡 No container resource limits, restart caps, or replica policy in compose**
*Area: `docker-compose.yml`*
No `deploy.resources` (limits/reservations), `mem_limit`, `cpus`, or restart back-off on any service. Every service uses `restart: unless-stopped` with no failure ceiling, so the migration-crash-loop above (or any boot failure) restarts indefinitely and burns CPU. A memory leak or large in-flight payload could let a worker consume all host memory and starve Postgres/Kafka, which share the host with no cgroup boundaries.
*Recommendation:* Add `deploy.resources.limits` (memory + cpus) per service, sized from observed usage, and explicit heap settings for Kafka. If this compose is intended for production (it points at GHCR images), add restart back-off or migrate to k8s with requests/limits and PodDisruptionBudgets.

**🟡 CI builds and pushes images but performs no vulnerability scan, SBOM, or signing; deploys track mutable `:latest`**
*Area: `.github/workflows/ci.yml` (publish job)*
The publish job (lines 108–152) logs into GHCR and pushes `:latest` + `:sha-<commit>` but has no image vuln scan (Trivy/Grype), no SBOM, no signing/attestation. A vulnerable base or transitive dep ships unscanned. Separately, `docker-compose.yml` pins all three app services to `:latest`, so `docker compose pull && up` deploys whatever last landed on main — undermining the immutable `:sha` tag the pipeline took care to publish.
*Recommendation:* Add a Trivy/Grype scan (fail on HIGH/CRITICAL) + SBOM (syft or buildx attest) to publish; optionally sign with cosign. Parameterize compose image tags to the `:sha-<commit>` being released (`image: ghcr.io/moesaleh/anyhook:${IMAGE_TAG:-latest}`).

**🟡 No deploy/CD stage — pipeline ends at image push; rollout is fully manual**
*Area: `.github/workflows/ci.yml`*
CI runs lint, tests, dashboard build, and image publish, but there is no deployment job (no environment targeting, no `docker compose pull`/`up`, no k8s apply, no remote rollout). The path from "image on GHCR" to "running in production" is undefined and manual — no automated migration gating, no health-gated rollout, no automatic rollback; MTTR depends on a human running the right commands.
*Recommendation:* Add a deploy job (gated on publish + a GitHub Environment with required approvals) that pulls the `:sha` tag, runs the migration job first, then a health-gated rolling update verifying `/health`. Even a simple SSH `docker compose pull && up -d` + post-deploy `/health` check closes the largest reliability gap.

**🔵 Connector graceful shutdown does not drain upstream GraphQL/WebSocket source connections**
*Area: `src/subscription-connector/index.js` (shutdown) + `handlers/baseHandler.js`*
The connector's `shutdown()` (lines 241–260) disconnects Kafka, Redis, and the metrics server, but never tells the handlers to tear down live upstream sockets. `BaseHandler.disconnect()` (lines 17–19) is a no-op stub that only logs; the real handlers hold open sockets closed only reactively on unsubscribe. On SIGTERM those connections are abandoned to the 10s force-exit, which can leave half-open connections against third-party sources and drop in-flight source events mid-publish. The dispatcher, by contrast, carefully stops pollers before disconnecting.
*Recommendation:* Have `shutdown()` iterate `connectionHandlers` and call a real close/drain (close upstream sockets, await graceful WS close frames) before disconnecting Kafka. Track active connections per handler so shutdown can await within the force-exit budget.

**🔵 Kafka defaults to replication factor 1 (single broker) — no HA, data loss on broker failure** *(also Architecture/Performance)*
*Area: `docker-compose.yml` (kafka) + `.env.example` + `src/subscription-management/index.js` (`createKafkaTopics`)*
Compose runs a single Kafka node (single-node KRaft quorum) and topics are created with `KAFKA_REPLICATION_FACTOR` default 1 (`index.js:134`, `.env.example:165`). All topics are single-replica on a single broker, so a broker/volume failure loses undelivered events and halts the pipeline. Acceptable for dev, a SPOF for a real multi-tenant SaaS depending on Kafka for at-least-once delivery.
*Recommendation:* For production, run a 3-node quorum with RF≥3 + `min.insync.replicas=2`. Document the dev-vs-prod topology difference; override the topic-creation defaults in production (the env tunable exists).

### Top recommendations
1. **BLOCKER:** Fix the migration runner so the published image can boot — move `node-pg-migrate` to deps, or (preferred) extract migrations into a one-shot pre-deploy job that gates rollout.
2. Add `.dockerignore` (root + dashboard) excluding `.env`, `node_modules`, `.git`, `tests`, CI files.
3. Add a deploy/CD stage (pull `:sha`, run migration job, health-gated rolling update with rollback).
4. Pin compose image refs to the released `:sha` tag; add Trivy/Grype + SBOM (+ optional cosign).
5. Set per-service resource limits + restart back-off.
6. Make connector shutdown drain upstream connections; provision Kafka HA for production.

---

## 8. Dashboard Frontend (Next.js 16 / React 19) — 🟡 Adequate

The dashboard is a polished, well-typed, and genuinely accessible client application: the API client is fully typed with thoughtful custom error classes, the component library is cleanly composed, and the service worker, offline handling, and axe-in-Playwright a11y gate are above-average for an internal SaaS console. **However, from a Next.js App Router lens it is effectively a CSR single-page app wearing App Router clothing** — all 11 pages are `"use client"`, there are zero Server Components, zero server-side data fetching, and no route-level `loading.tsx`/`error.tsx`, so the framework's core value (streaming SSR, server data, RSC payloads, PPR) is unused. "Real-time" is implemented as multiple independent unbounded `setInterval` polling loops that never pause when the tab is hidden — ironic for a real-time product and the main runtime-efficiency concern.

### Strengths
- API client (`dashboard/src/lib/api.ts`) fully typed end-to-end with purpose-built error classes (`RateLimitError` carrying Retry-After, `TimeoutError` via AbortController, `OfflineError` short-circuit on `navigator.onLine`, `AuthError` on 401/403) and sensible read-vs-mutation timeouts.
- Accessibility is real, not cosmetic: axe-core wired into Playwright across `/login`, `/register`, dashboard, `/subscriptions`, `/settings` gating serious/critical; aria-live regions on the live indicator, toast, offline banner, DLQ alert; a working skip-link; labelled icon buttons.
- Security-conscious client: `sanitiseNextPath()` blocks open-redirect/protocol-relative `next` params; hard navigation after login forces middleware re-evaluation with the new cookie; no-flash theme via inline pre-paint script + matching client provider.
- Service worker (`public/sw.js`) correctly scoped — stale-while-revalidate for `/_next/static` only, version-tagged cache with activate-time purge, explicit refusal to cache HTML shells or API responses (avoids leaking auth-gated content).
- Clean, reusable composition: discriminated-union `LoginResult` for the 2FA branch, a self-contained dependency-free toast/portal system, a generic wizard stepper with per-step controlled components, a class-based `ErrorBoundary` in the root layout.

### Findings

**🟡 Entire app is client-rendered — App Router / Server Components are unused**
*Area: `dashboard/src/app` (all pages)*
All 11 route files begin with `"use client"`. Every page fetches its own data in `useEffect` against the cross-origin API with `credentials:'include'`. No Server Components, no server-side data fetching, no route-level `loading.tsx`/`error.tsx`/`not-found.tsx`; the root layout wraps everything in client providers. Next.js 16 is used purely as a client bundler + router — streaming SSR, RSC payload reduction, server-side auth redirects, and PPR are all forgone. Defensible for an authenticated console, but a significant departure from the framework's intended architecture, and it leaves performance/TTFB on the table (every screen shows a client spinner before first data).
*Recommendation:* Render static shells (headers, nav, empty states) as Server Components and hydrate only data-driven islands; at minimum add route-level `loading.tsx` for the dashboard/subscriptions/detail routes (instant skeleton) and `error.tsx`. Consider a thin server proxy/route handler so the browser isn't doing credentialed cross-origin fetches for first paint.

**🟡 "Real-time" is unbounded polling that never pauses on hidden tabs**
*Area: `dashboard/src/app/page.tsx`, `subscriptions/page.tsx`, `subscriptions/[id]/page.tsx`, `components/service-health.tsx`, `components/dlq-alert.tsx`*
Live updates are simulated with `setInterval`: dashboard every 10s (3 endpoints), detail page every 10s (3 endpoints) plus a nested DeliveryTable every 10s, ServiceHealth every 30s, DlqAlert every 30s — several loops concurrent on one screen. None consult the Page Visibility API (no `visibilitychange`/`document.hidden` matches), so a backgrounded tab hammers the backend and battery indefinitely. The dashboard `LiveIndicator` is hard-coded `isPolling={true}`. For a real-time product, polling is also a fidelity mismatch (10s latency, no push).
*Recommendation:* Pause every loop when `document.hidden` and resume on `visibilitychange` (a `useVisiblePolling` hook would centralize this + the repeated setInterval/clearInterval boilerplate). Drive the dashboard `LiveIndicator` from real polling state. Longer term, evaluate SSE/WebSocket for status + delivery feeds.

**🔵 Pervasive duplication of the fetch error-handling block in the API client**
*Area: `dashboard/src/lib/api.ts`*
~Two dozen exported functions repeat `if (!res.ok) { const body = await res.json().catch(() => ({})); throw new Error(body.error || "…"); } return res.json();`, and read endpoints separately repeat `checkAuth(res); if (!res.ok) …`. ~300 lines of near-identical boilerplate kept in sync by hand; `checkAuth` is applied inconsistently (login/register/2FA-setup deliberately omit it, but that intent isn't enforced/documented at call sites). Errors are plain `Error`, so callers can't distinguish a 400 from a 500 the way they can for 401/429.
*Recommendation:* Extract one `async function request<T>(path, init, { auth = true, fallbackMsg }): Promise<T>` that runs apiFetch, optionally checkAuth, parses JSON-or-{}, and throws a typed `ApiError(status, message)`. Route all endpoints through it.

**🔵 Custom dropdowns and clickable rows lack keyboard interaction**
*Area: `dashboard/src/components/sidebar.tsx` (org picker), `delivery-table.tsx` (rows), `subscriptions/page.tsx` (export menu)*
Outside the DeleteDialog's Escape handler, no component implements keyboard handling for its custom interactive UI. The sidebar org picker opens a custom menu with no Escape/outside-click close and no focus management. DeliveryTable rows are expand/collapse `<tr onClick=…>` with no `tabIndex`/`role`/`aria-expanded`/`onKeyDown`, so keyboard and screen-reader users can't expand a delivery. The export menu closes on Escape/outside-click but focus isn't moved into/trapped. axe won't catch most of these (interaction/focus, not static-DOM).
*Recommendation:* Move the delivery-row disclosure to a focusable control (a `<button>` in the chevron cell, or row as button-role with `tabIndex={0}`, `aria-expanded`, Enter/Space). Give the org picker Escape + outside-click close with focus return. Consider a shared `<Menu>` primitive (or headless lib). Add a keyboard Playwright test.

**🔵 Auth/public-path config is duplicated and divergent across layers**
*Area: `dashboard/middleware.ts` vs `dashboard/src/lib/auth-context.tsx`*
The set of unauthenticated routes is defined twice and they disagree. `middleware.ts` treats `/login`, `/register`, `/forgot-password`, `/reset-password`, and the `/invitations/` prefix as public; `AuthProvider`'s `PUBLIC_PATHS` contains only `/login` and `/register`. On a 401 the provider therefore `router.replace('/login')` even on `/forgot-password`/`/reset-password`/`/invitations/[token]` — middleware permits those anonymously, so the practical effect is a redundant redirect rather than a lockout, but the two sources of truth will drift. `AuthProvider` also issues a fresh `/auth/me` on every mount though middleware already gated the route, adding a spinner to first paint.
*Recommendation:* Export a single `PUBLIC_PATHS`/`PUBLIC_PREFIXES` module imported by both middleware and the auth context; align the provider's redirect logic with it. Optionally seed the session from a server-rendered value to avoid the extra `/auth/me`.

**🔵 Native `confirm()` used for destructive actions, bypassing the app's own dialog/toast UX**
*Area: `dashboard/src/app/settings/page.tsx` (member removal, API-key revoke)*
`MembersPanel.handleRemove` and `ApiKeysPanel.handleRevoke` gate destructive ops with `window.confirm(...)`. The app already ships a styled, accessible `DeleteDialog` (used elsewhere) and a toast system, so this is inconsistent UX, unstyleable/untestable via Playwright, blocks the main thread, and looks out of place. `handleRoleChange` has no confirmation at all despite role changes being security-relevant.
*Recommendation:* Reuse `DeleteDialog` (or a generic `ConfirmDialog`) for member removal and key revocation; surface results through the existing `toast()` calls.

**⚪ Tooling gaps: no type-check script, dated TS target, weakened hooks lint**
*Area: `dashboard/package.json`, `tsconfig.json`, `eslint.config.mjs`*
`tsconfig` has `strict:true` (good) but only build/lint scripts exist — no `tsc --noEmit` typecheck, so a CI step catching type regressions independently of `next build` isn't obvious. `compilerOptions.target` is ES2017 — conservative for a Next 16 / React 19 / Node ≥22 app shipping to evergreen browsers. `eslint.config.mjs` downgrades `react-hooks/set-state-in-effect`, `react-hooks/static-components`, and `react-hooks/refs` from error to warn; the first is precisely the rule that flags the polling-in-effect pattern, so genuine effect/state bugs could pass CI.
*Recommendation:* Add a `"typecheck": "tsc --noEmit"` script and run it in CI; bump TS target to ES2020+; rather than blanket-warning the hooks rules, fix the flagged effects (or scope the relaxation with per-line eslint-disable).

**⚪ Service worker present but the app is not an installable PWA, and no viewport/themeColor metadata**
*Area: `dashboard/public/sw.js`, `dashboard/src/app/layout.tsx`*
A service worker is registered in production yet there is no web app manifest, and the root layout's metadata defines only title/description — no viewport or themeColor. So the SW delivers asset caching but the app can't be installed/added-to-home-screen, won't theme mobile browser chrome, and relies on Next's default viewport. The SW design itself is sound; this is about completing the PWA story or being explicit that installability is a non-goal.
*Recommendation:* If offline/installability is desired, add `app/manifest.ts` (or `public/manifest.webmanifest`) + icons and a viewport/themeColor via Next's metadata/viewport export. If not, add a short comment justifying shipping a SW over plain immutable-asset caching.

### Top recommendations
1. Manage polling lifecycle: pause all loops on `document.hidden`, resume on `visibilitychange` via a shared hook; drive the dashboard `LiveIndicator` from real state.
2. Introduce route-level `loading.tsx`/`error.tsx` and move static shells to Server Components; longer term evaluate SSE/WebSocket.
3. Collapse the repeated fetch handling in `api.ts` into one typed `request<T>()` throwing `ApiError(status, message)`.
4. Fix keyboard a11y for custom interactive elements; add a keyboard Playwright test.
5. De-duplicate the public-paths config into one shared module imported by both middleware and auth context.
6. Add a `tsc --noEmit` CI step, bump TS target to ES2020+, replace native `confirm()` with `DeleteDialog` + toast.

---

## Methodology & caveats

- **How:** Eight installed specialist subagent *personas* (`architect-reviewer`, `security-auditor`, `code-reviewer`, `performance-engineer`, `postgres-pro`, `qa-expert`, `devops-engineer`, `nextjs-developer`) were run in parallel via a read-only workflow; each adopted its `.claude/agents/<name>.md` definition and assessed one dimension. ~932K tokens of analysis across 287 tool calls.
- **Static analysis only:** nothing was executed, load-tested, or deployed. Scaling-ceiling and SSRF-exploit claims are reasoned from the code, not empirically reproduced. Line numbers reflect the state at assessment time and may drift.
- **Confidence:** findings flagged by ≥2 specialists independently (noted inline) and the two confirmed by direct inspection (`dispatchNotification` import; `pg_advisory_unlock` key) are the most reliable. Single-source findings — especially `info`/`low` — warrant a quick confirm before action.
- **Not exhaustive:** each agent was asked for ~4–10 focused findings, so this is a prioritized sweep, not a line-by-line audit.
