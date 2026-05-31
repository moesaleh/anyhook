# AnyHook — Assessment Fix Plan (Tracked)

Derived from [`CODEBASE-ASSESSMENT.md`](./CODEBASE-ASSESSMENT.md) (2026-05-31). Every finding from all 8 dimensions is tracked here.

**How to use:** each item has a stable ID (e.g. `P0-2`) and a checkbox. Update the box as you go:
`- [ ]` todo · `- [~]` in progress · `- [x]` done. Fill in **Owner**/**PR** inline.

**Severity:** 🔴 critical · 🟠 high · 🟡 medium · 🔵 low · ⚪ info
**Confidence:** ✅ confirmed by inspection · 🔁 converged (≥2 specialists) · ◾ single-source

### Counts

| Priority | Items | Meaning |
|----------|------:|---------|
| **P0** | 6 | Blockers / confirmed defects — fix before any production deploy |
| **P1** | 10 | Scaling, correctness & HA — required to honor the product's claims |
| **P2** | 34 | Robustness, ops hardening, security depth, data, frontend, docs |
| **Total** | **50** | |

---

## ✅ Verification status (2026-05-31)

All 50 items applied via a multi-agent workflow, then **independently verified on real infrastructure** (Postgres 17 + Redis 7 + Kafka on a remote Linux host) — not mocks. A second parallel workflow (6 fix-verifiers + 6 adversarial auditors + 5 real probes) found and fixed **11 follow-on defects**.

**Real-execution evidence:**
- Backend test suite **551/551 pass** (30/30 suites) against real Postgres; **24 migrations apply cleanly** on a fresh DB.
- **P0-3** — `pg_locks` shows **0 leaked advisory locks** after a real `/subscribe`.
- **P0-4** — real `ssrf-guard` blocks literal + DNS-resolved IMDS/private targets, enforces `maxRedirects:0`; the **real dispatcher** parks a private `webhook_url` to DLQ and never contacts it (20/20 e2e checks); plus NAT64 `64:ff9b::/96` IMDS bypass + `fc/fd` false-positives closed in the classifier.
- **P0-2** — `quota_warning` genuinely dispatches via real `dispatchNotification` (no ReferenceError).
- **P0-1/P1-9** — all three services **boot against real infra** (`/health/live`=200, `RUN_MIGRATIONS_ON_BOOT=false`); crash-loop does not reproduce.
- **P1-4/P2-11/P2-12** — `processed_events` dedups concurrent duplicates to one row; composite FK **rejects** an org/owner mismatch (SQLSTATE 23503); `subscriptions.created_at` is `timestamptz`.
- **P2-2** — rate-limit `INCR`+`EXPIRE` is atomic (Lua) and fails open; same fix applied to the new per-account login throttle (which was also wired into `createApp`, previously dead).
- Dashboard: lint + `tsc --noEmit` + `next build` + vitest (88/88) all green.

**Follow-ups — RESOLVED 2026-05-31 (second session, verified locally on real Postgres + Docker):**
- ✅ **P0-1 CI smoke test** — `.github/workflows/ci.yml` gained an `image-smoke` job that boots the published `:sha` image via the repo compose (one-shot `migrate` → Postgres/Redis/Kafka healthy → `subscription-management`) and asserts `/health/live`=200; `deploy` now `needs: [publish, image-smoke]`. Verified end-to-end locally: full stack reaches healthy and `/health/live`→200.
- ✅ **Test coverage** added — suite now **565/565** (30/30 suites), +14 tests: login lockout integration test (asserts 429 + `Retry-After` after `LOGIN_FAIL_MAX` failures) in `tests/integration/auth.test.js`; NAT64 (`64:ff9b::a9fe:a9fe`, `64:ff9b::7f00:1`) + public `fcm.googleapis.com`/`fdroid.org` cases in `tests/lib/url-validation.test.js`; connector divergent-assignment ownership-guard test in `tests/connector/consumer.test.js`; `quota_warning`/`failed` notification-template assertions in `tests/lib/notifications.test.js`. (2FA-stage lockout test intentionally deferred — the 2FA suite's reused user id + shared in-memory Redis counter make it flaky; the password-stage test covers the mechanism.)
- ✅ **Kafka image** — `docker-compose.yml` repinned `bitnami/kafka:3.9.1` (now returns `manifest unknown` from Docker Hub) → `apache/kafka:3.9.1` (env vars `KAFKA_CFG_*`→`KAFKA_*`, healthcheck path `/opt/kafka/bin/...`, RF=1 knobs, ephemeral data dir). Broker verified healthy locally and the app connects.
- ✅ **Stale docs corrected** — `docs/ARCHITECTURE.md`: the atomic `processed_events` dedup gate (P1-4) **is** wired (`webhook-dispatcher/index.js` `claimEvent`, `ON CONFLICT DO NOTHING`); removed the false "migrated but not yet wired" note + the bogus "P1-4 not wired" gap bullet and updated ADR-0002. `docs/RUNBOOK.md`: the `outbox_pending_total` gauge is live (not a TODO). `productfeatures.md`: statuses reconciled to code → 12 DONE / 3 PARTIAL / 0 TODO.
- ✅ **Pre-existing lint breakage fixed** — `npm run lint` (CI `backend-lint`) was already RED on baseline `main` (prettier drift in `src/lib/notifications.js`, `tests/lib/rate-limit.test.js`, `tests/integration/two-factor.test.js`, untouched by the prior session); auto-formatted, gate now green (0 errors).

**Still open (optional, non-blocking):**
- **P1-2** — custom Kafka `PartitionAssigner` to co-partition the three sub-topics. The per-message ownership guard is the implemented + now-tested fix; the assigner is an optional optimization only.
- **P1-5** — `delivery_events` range-partitioning. Retention is implemented via `prune_delivery_events()` (driven by an external scheduler); partitioning is the optional long-term form.
- The pre-existing `Disable 2FA` integration test (stale cookie reuse) was already corrected last session.

---

## P0 — Blockers (fix before production)

- [x] **P0-1 — Production image crash-loops on boot** · 🔴 · ◾ (devops)
  - **Where:** `Dockerfile:21`, `src/subscription-management/index.js:108-121,171-174`, `package.json:67`
  - **Why:** `node-pg-migrate` is a devDependency, pruned by `npm prune --omit=dev`; boot runs `npm run migrate` → fails → `process.exit(1)`.
  - **Fix:** Move `node-pg-migrate` to `dependencies` (minimal), or implement P1-9 (preferred — also fixes the multi-pod race). Add a smoke test that boots the *published* image.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P0-2 — `dispatchNotification` not imported in `app.js`** · 🟠 · ✅ (code-reviewer + security)
  - **Where:** `src/subscription-management/app.js:27,191`
  - **Why:** `dispatchNotification` undefined in scope → `ReferenceError`, swallowed → quota-warning notifications silently never fire.
  - **Fix:** `const { dispatchNotification } = require('../lib/notifications');` + integration test driving an org past the warn threshold against a transport spy.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P0-3 — Advisory-lock key mismatch leaks session locks** · 🟠 · ✅ (code-reviewer + postgres)
  - **Where:** `src/lib/quotas.js:76-81` (unlock) vs `:91-94` (lock)
  - **Why:** Lock uses `hashtext($2::text)`, unlock passes the raw UUID → lock never released, rides back onto the pooled connection; eventually blocks `/subscribe` forever / silently disables quota enforcement.
  - **Fix:** `pg_advisory_unlock($1, hashtext($2::text))` (mirror the api-key path), or switch both quota paths to `pg_advisory_xact_lock`. Test asserting no leftover `pg_locks` after a 2xx `/subscribe`.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P0-4 — SSRF: no connect-time re-validation, no redirect cap** · 🟠 · 🔁 (security + qa)
  - **Where:** `src/lib/url-validation.js`, `src/webhook-dispatcher/index.js:392`, `src/lib/notifications.js:81`, `src/subscription-connector/handlers/*`
  - **Why:** URL validated only at create time; dispatcher/Slack axios calls follow up to 5 redirects → `302 → 169.254.169.254` exfiltrates IMDS creds; connector handlers do no SSRF check at all.
  - **Fix:** Resolve hostname → reject if any resolved IP is private/loopback/link-local/CGNAT → pin+connect to that IP (custom agent/undici dispatcher). Set `maxRedirects: 0` on all outbound axios (or re-check each redirect). Add the guard at connect time in the handlers. (Pairs with test P2-21.)
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P0-5 — No `.dockerignore`; `.env` baked into image layers** · 🟠 · ◾ (devops)
  - **Where:** repo root + `dashboard/`; `Dockerfile:18` (`COPY . .`)
  - **Why:** Build context ingests `.env` (JWT_SECRET, ADMIN_API_KEY, DB/SMTP creds), `.git`, host `node_modules` into builder layers.
  - **Fix:** Add `.dockerignore` (root + dashboard) excluding `.env`, `.env.*`, `node_modules`, `.git`, `coverage`, `tests`, `*.md`, `.github`.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P0-6 — Placeholder `JWT_SECRET` passes the length gate** · ⚪ (impact 🟠) · ◾ (security)
  - **Where:** `.env.example`, `src/lib/jwt.js`
  - **Why:** `.env.example` ships a ≥32-char `JWT_SECRET` placeholder (uncommented) → copy-paste deploy boots with a public signing key → forgeable session cookies.
  - **Fix:** Comment out `JWT_SECRET` in `.env.example` (like the other secrets) or reject the known placeholder at startup. Document a `crypto.randomBytes` bootstrap step.
  - **Owner / PR:** ___ · **Status:** todo

---

## P1 — Scaling, correctness & HA

- [x] **P1-1 — Unpin connector/dispatcher replicas** · 🔴 · 🔁 (performance + architecture)
  - **Where:** `docker-compose.yml:35,64` (`container_name`)
  - **Why:** Fixed `container_name` makes `--scale` fail → 7/8 partitions go to one consumer; scaling ceiling is one core per stage.
  - **Fix:** Remove `container_name` from the stateless workers; use `deploy.replicas`/`--scale`/k8s. Verify a 2+ replica run rebalances partitions; document replica count alongside `KAFKA_PARTITIONS`.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-2 — Shard upstream connections by partition ownership** · 🟠 · 🔁 (architecture + performance)
  - **Where:** `src/subscription-connector/index.js:58-90`, `handlers/{graphqlHandler,webSocketHandler}.js`
  - **Why:** Every pod `SCAN`s all `sub:*` and reconnects to every upstream → N-fold duplicate connections/events; all connections in one heap; boot-time reconnect storm.
  - **Fix:** Connect only to subscriptions whose id maps to a partition the pod owns; cap concurrent reconnects on reload; add an open-connection gauge. (Depends on P1-1.)
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-3 — Make webhook delivery concurrent + lower timeout** · 🔴 · ◾ (performance)
  - **Where:** `src/webhook-dispatcher/index.js:127-152,322-332`
  - **Why:** `eachMessage` + no `partitionsConsumedConcurrently` + 30s axios timeout → one slow endpoint head-of-line-blocks all delivery (~5/s ceiling).
  - **Fix:** Set `partitionsConsumedConcurrently` = partition count; add a bounded worker pool (e.g. `p-limit`) for the POSTs with safe offset commits; cut timeout to 5–10s.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-4 — Atomic delivery idempotency** · 🟠 · ◾ (architecture)
  - **Where:** `migrations/20250324000000_create_delivery_events.sql`, `src/webhook-dispatcher/index.js:284-302`
  - **Why:** SELECT-then-INSERT dedup with no `UNIQUE(subscription_id,event_id)` → concurrent redeliveries double-fire.
  - **Fix:** Add `UNIQUE(subscription_id, event_id)` + `INSERT … ON CONFLICT DO NOTHING` as the idempotency gate.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-5 — `delivery_events` retention + partitioning + bounded stats query** · 🟠 · 🔁 (performance + postgres)
  - **Where:** `migrations/20250324000000_create_delivery_events.sql`, `src/subscription-management/app.js:490-522`
  - **Why:** Unbounded table; org-wide `/deliveries/stats` aggregate has no time bound → full-table scan that worsens with tenant age.
  - **Fix:** Range-partition by `created_at` (monthly) + DROP-PARTITION aging (or scheduled DELETE); bound the summary to a window + covering index `(organization_id, created_at DESC, status)` or a rollup table; consider not storing success response bodies.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-6 — Test the core: webhook-dispatcher + connector suites** · 🔴 · ◾ (qa)
  - **Where:** `tests/webhook-dispatcher/` (new), `tests/connector/` (extend); `src/webhook-dispatcher/index.js`, `src/subscription-connector/*`
  - **Why:** The delivery/retry/DLQ/idempotency engine and the connector handlers/consumer have **zero** direct tests.
  - **Fix:** Mock pg/redis/axios/producer; cover success/failure, backoff ladder, idempotency skip, retrying→dlq, GREATEST guard, subscription-deleted 'failed', outbox drainer; handler event_type filtering, reconnect wiring, `handleMessage` topic dispatch, `sub:*` reload filter, `eventId` generation.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-7 — Fix coverage config + add threshold gate** · 🟠 · ◾ (qa)
  - **Where:** `jest.config.js` (`collectCoverageFrom`), CI backend-tests job
  - **Why:** Coverage scoped to `src/lib/**` only → dispatcher/connector/management excluded; reported number is misleading; no `coverageThreshold`.
  - **Fix:** Broaden `collectCoverageFrom` to the service dirs (exclude `src/test/**`); add `coverageThreshold` (e.g. global lines 60% + higher floor for `src/lib`) wired as a hard CI gate. (Do after P1-6.)
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-8 — Kafka HA + producer durability** · 🟡 · 🔁 (architecture + devops + performance)
  - **Where:** `docker-compose.yml` (kafka), `src/*/index.js` producer config, `src/subscription-management/index.js:134`
  - **Why:** Single broker, RF=1 SPOF; producers lack `acks:'all'`/`idempotent:true` → outbox at-least-once not durable end-to-end.
  - **Fix:** Prod: 3-node quorum, RF≥3, `min.insync.replicas=2`; producers `acks:'all'` + `idempotent:true`. Document dev-vs-prod topology.
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-9 — Decouple migrations from app boot (one-shot job)** · 🟠 · ◾ (devops)
  - **Where:** `src/subscription-management/index.js:163`, CI, compose
  - **Why:** Migrations on every API pod's boot → multi-pod race; a slow/failed migration blocks/crash-loops all API pods. Also the root cause path of P0-1.
  - **Fix:** Extract to a single pre-deploy job / one-shot k8s Job / compose `migrate` profile (image/stage retaining `node-pg-migrate`) that runs once per release and gates rollout; app pods assume schema current. **Doing this resolves P0-1.**
  - **Owner / PR:** ___ · **Status:** todo

- [x] **P1-10 — Connector Postgres fallback on Redis miss** · 🟡 · ◾ (architecture)
  - **Where:** `src/subscription-connector/index.js`, `src/subscription-management/app.js` (`/redis/reload`)
  - **Why:** Connector reads subscription config only from Redis; a flush/eviction silently darkens all live connections (Redis = hidden SPOF for streaming liveness).
  - **Fix:** On startup and on a Redis miss, read the row from Postgres and re-warm Redis (mirror the dispatcher's fallback).
  - **Owner / PR:** ___ · **Status:** todo

---

## P2 — Robustness, ops, security depth, data, frontend, docs

### Backend robustness & correctness

- [x] **P2-1 — Add `unhandledRejection`/`uncaughtException` handlers** · 🟡 · ◾ (code) — all 3 entrypoints. Wire to graceful shutdown; share a bootstrap helper. Heavy fire-and-forget usage + Node ≥22 terminate-by-default. · **Status:** todo
- [x] **P2-2 — Atomic rate-limit `INCR`+`EXPIRE`** · 🟡 · ◾ (code) — `src/lib/rate-limit.js:163-166`. Lua (INCR+conditional PEXPIRE) or `SET … EX NX` + INCR, or MULTI — a partial failure strands a TTL-less key that permanently rate-limits an org. · **Status:** todo
- [x] **P2-25 — Standardize `ROLLBACK` handling / `withTransaction` helper** · 🟡 · ◾ (code) — `src/subscription-management/auth.js` (register:307, 2fa:612, create-org:841, add-member:952, remove-member:1018, accept-invite:1683). Bare `ROLLBACK` in catch can throw out and hang the request. Use `.catch(()=>{})` or a shared `withTransaction(pool, fn)`. · **Status:** todo
- [x] **P2-24 — Extract duplicated backend boilerplate** · 🔵 · ◾ (code) — `withOrgAdvisoryLock` (quotas.js ×2 + app.js bulk), `parseBrokers` (3 entrypoints), Kafka `eachMessage` manual-commit wrapper (connector + dispatcher). Divergence here caused P0-3. · **Status:** todo
- [x] **P2-19 — Bound/validate `args.headers`** · ⚪ · ◾ (code) — `src/subscription-management/app.js:59-87`. Schema-check headers (string→string, bounded count/bytes) before spreading into outbound ws/axios. · **Status:** todo

### Backend performance

- [x] **P2-6 — Demote per-message payload logging info→debug** · 🟡 · 🔁 (code + performance) — handlers + dispatcher + `src/lib/logger.js`. Stop `JSON.stringify`-ing payloads at info (hot-path CPU + PII/secret leakage to central logs). · **Status:** todo
- [x] **P2-7 — Shorten quota/bulk advisory-lock connection hold** · 🟡 · ◾ (performance) — `src/lib/quotas.js`, `app.js` `/subscribe/bulk`. `pg_advisory_xact_lock` in a short txn (don't hold across response flush); batch bulk INSERTs (multi-row VALUES) + pipeline Redis SETs; right-size the pg pool. · **Status:** todo
- [x] **P2-15 — Kafka producer compression/batching** · 🔵 · ◾ (performance) — `src/subscription-connector/handlers/baseHandler.js` + producers. Enable gzip/lz4/snappy (esp. `connection_events`); allow batching instead of single-message lockstep sends. · **Status:** todo

### Architecture & resilience

- [x] **P2-3 — Close the DLQ loop (consumer/redrive) or fix docs** · 🟡 · ◾ (architecture) — `src/webhook-dispatcher/index.js` (`sendToDLQ`), topic creation. `dlq_events` has no consumer despite notifications promising "downstream processing." Add a redrive/admin replay + lag alert, or correct the wording. · **Status:** todo
- [x] **P2-18 — Extract outbox drainer/poller from dispatcher** · 🔵 · ◾ (architecture) — `src/webhook-dispatcher/index.js`. The drainer publishes events the *connector* consumes; colocating couples connector health to dispatcher deploy. Separate worker/module. · **Status:** todo

### Security depth

- [x] **P2-4 — Redact/remove `webhook_secret` from admin `/redis` dump** · 🟡 · ◾ (security) — `src/subscription-management/app.js` (`GET /redis`, `/redis/:key`). Never return secrets after creation; consider removing bulk Redis introspection in prod. · **Status:** todo
- [x] **P2-5 — Per-account login/2FA throttling + XFF trust gating** · 🟡 · ◾ (security) — `src/subscription-management/auth.js`, `src/lib/rate-limit.js:51-56`. Add per-user failed-attempt counter + backoff/lockout; only honor `X-Forwarded-For` behind a configured trusted proxy. · **Status:** todo
- [x] **P2-13 — Encrypt `users.totp_secret` at rest** · 🔵 · 🔁 (postgres + security) — `migrations/20260430000000_add_totp_2fa.sql`, `src/lib/envelope.js`. Store ciphertext + key id using the existing envelope primitive (the migration's own TODO). · **Status:** todo
- [x] **P2-14 — Postgres RLS defense-in-depth + cross-tenant negative tests** · 🔵 · ◾ (security) — `migrations/`, tests. RLS on org-scoped tables keyed off `SET LOCAL app.current_org`; at minimum, tests asserting another org's IDs return 404/empty. · **Status:** todo

### Data layer

- [x] **P2-11 — Composite FK `(subscription_id, organization_id)`** · 🟡 · ◾ (postgres) — `delivery_events`, `pending_retries`. Denormalized `organization_id` isn't tied to the subscription's owner → a wrong/stale value mis-attributes (and leaks) rows across tenants. Add the composite FK. · **Status:** todo
- [x] **P2-12 — `subscriptions.created_at` → `TIMESTAMPTZ`** · 🟡 · ◾ (postgres) — `migrations/20240930142437_*`. Legacy table uses `TIMESTAMP` without tz (ordering/INTERVAL ambiguity). `ALTER … USING created_at AT TIME ZONE 'UTC'` in a maintenance window; optionally add `gen_random_uuid()` default. · **Status:** todo
- [x] **P2-16 — Retention sweep for terminal `notification_attempts`** · 🔵 · ◾ (postgres) — `migrations/20260507000000_*`. Delete delivered/dlq rows older than N days (same unbounded-growth pattern as `delivery_events`, lower volume). · **Status:** todo
- [x] **P2-26 — Verify `email_lower_unique` transition post-deploy** · 🔵 · ◾ (postgres) — `migrations/20260504000000_*`. `DROP … IF EXISTS` relies on the default `users_email_key` name; catalog-check each env that the old constraint/index are actually gone. · **Status:** todo

### Operations & CI/CD

- [x] **P2-8 — Container resource limits + restart back-off** · 🟡 · ◾ (devops) — `docker-compose.yml`. No `deploy.resources`/`mem_limit`/`cpus`; `restart: unless-stopped` with no ceiling → crash-loops burn CPU, a leak can starve the data tier. · **Status:** todo
- [x] **P2-9 — CI image scan + SBOM + signing** · 🟡 · ◾ (devops) — `.github/workflows/ci.yml`. Add Trivy/Grype (fail HIGH/CRITICAL) + SBOM (syft/buildx attest); optionally cosign. · **Status:** todo
- [x] **P2-10 — CI deploy stage + pin compose to `:sha`** · 🟡 · ◾ (devops) — `.github/workflows/ci.yml`, `docker-compose.yml`. Add a gated deploy job (pull `:sha`, run migration job, health-gated rolling update + rollback); parameterize compose image tags off `:sha-<commit>` instead of mutable `:latest`. · **Status:** todo
- [x] **P2-17 — Connector shutdown drains upstream sockets** · 🔵 · ◾ (devops) — `src/subscription-connector/index.js`, `handlers/baseHandler.js`. `disconnect()` is a no-op stub; SIGTERM abandons upstream sockets to the 10s force-exit. Implement real close/drain before disconnecting Kafka. · **Status:** todo

### Testing (beyond P1-6/P1-7)

- [x] **P2-20 — Notification persistence/retry state-machine tests** · 🟡 · ◾ (qa) — `src/lib/notifications.js`, `tests/lib/notifications.test.js`. Drive an attempt through transient-failure → backoff retry → success/terminal; cover `dispatchNotification` channel fan-out (only configured channels; thrown channel error swallowed). · **Status:** todo
- [x] **P2-21 — Dispatcher send-time SSRF test** · 🟡 · ◾ (qa) — pairs with P0-4. Assert a cached subscription whose `webhook_url` resolves to a private/IMDS address is NOT delivered. · **Status:** todo
- [x] **P2-22 — Dashboard e2e negative/auth flows** · 🔵 · ◾ (qa) — `dashboard/e2e/`. Add SSRF 400, quota 429, expired-session redirect, org-switch, api-key lifecycle (reuse `page.route` mocks). · **Status:** todo

### Frontend (dashboard)

- [x] **P2-27 — Pause polling on hidden tab + real `LiveIndicator` state** · 🟡 · ◾ (nextjs) — `app/page.tsx`, `subscriptions/page.tsx`, `subscriptions/[id]/page.tsx`, `components/{service-health,dlq-alert}.tsx`. `useVisiblePolling` hook gating on `document.hidden`/`visibilitychange`; drive dashboard `LiveIndicator` from real state. · **Status:** todo
- [x] **P2-28 — Add `loading.tsx`/`error.tsx` + Server Component shells** · 🟡 · ◾ (nextjs) — `dashboard/src/app`. Instant skeletons + route error boundaries; render static shells server-side, hydrate data islands; consider a server proxy for first-paint fetches. · **Status:** todo
- [x] **P2-29 — Collapse `api.ts` fetch duplication into typed `request<T>()`** · 🔵 · ◾ (nextjs) — `dashboard/src/lib/api.ts`. One helper that runs apiFetch, optional `checkAuth`, parses JSON-or-{}, throws `ApiError(status, message)`. · **Status:** todo
- [x] **P2-30 — Keyboard a11y for custom interactive elements** · 🔵 · ◾ (nextjs) — `sidebar.tsx` (org picker), `delivery-table.tsx` (rows), `subscriptions/page.tsx` (export menu). Focusable disclosure controls (`tabIndex`/`role`/`aria-expanded`/Enter-Space), Escape/outside-click + focus return; shared `<Menu>` primitive; add a keyboard Playwright test. · **Status:** todo
- [x] **P2-31 — Dedupe public-paths config** · 🔵 · ◾ (nextjs) — `dashboard/middleware.ts` vs `src/lib/auth-context.tsx` disagree on public routes. One shared `PUBLIC_PATHS`/`PUBLIC_PREFIXES` module imported by both; align the 401 redirect. · **Status:** todo
- [x] **P2-32 — Replace native `confirm()` with `DeleteDialog`/toast** · 🔵 · ◾ (nextjs) — `dashboard/src/app/settings/page.tsx` (member removal, api-key revoke; add confirmation to role change). · **Status:** todo
- [x] **P2-33 — Tooling: `tsc --noEmit` script, TS target, hooks lint** · ⚪ · ◾ (nextjs) — `dashboard/package.json`, `tsconfig.json` (target ES2017→ES2020+), `eslint.config.mjs` (re-enable or scope `react-hooks/*` warns). Add a typecheck CI step. · **Status:** todo
- [x] **P2-34 — Complete PWA story or justify the SW** · ⚪ · ◾ (nextjs) — `dashboard/public/sw.js`, `app/layout.tsx`. Add `app/manifest.ts` + icons + viewport/themeColor, or add a comment justifying SW-for-asset-caching-only. · **Status:** todo

### Docs

- [x] **P2-23 — Refresh README architecture + add `docs/ARCHITECTURE.md`/ADRs** · 🟡 · ◾ (architecture) — `README.md` still describes the pre-outbox synchronous flow and omits outbox/retry/multi-tenancy/metrics. Document the real delivery guarantee (at-least-once + dedup), all topics (incl. `update_events`), per-service entry points, and the connector single-pod caveat. · **Status:** todo

---

## Suggested sequencing

1. **Stop-the-bleeding (P0):** P0-1 (or P1-9), P0-2, P0-3 are one-to-few-line fixes that unblock a bootable, correct deploy; P0-4/P0-5/P0-6 close the worst security exposure for an internet-facing service.
2. **Make the scaling/HA claims true (P1):** P1-1 → P1-2/P1-3 (topology + delivery concurrency), P1-4/P1-5 (delivery correctness + data growth), P1-6/P1-7 (test the core), P1-8/P1-9/P1-10 (HA + deploy safety).
3. **Harden (P2):** schedule by severity within each area; many are small and independent.

> Cross-references and full rationale for every item are in [`CODEBASE-ASSESSMENT.md`](./CODEBASE-ASSESSMENT.md). Items marked ✅ were confirmed by direct inspection; 🔁 were independently flagged by ≥2 specialists; ◾ are single-source — confirm low/info items before investing.
