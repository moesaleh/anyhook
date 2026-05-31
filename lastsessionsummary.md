# Last Session Summary — AnyHook: closing the assessment-plan leftovers

**Date:** 2026-05-31 (follow-up session)
**Outcome:** ✅ Complete. Every non-blocking follow-up from the prior session was verified against the real code, fixed, and verified again on real infrastructure (local Postgres + Docker, Node 22). Backend suite **565/565**, `npm run lint` green, CI image-smoke validated end-to-end. Landed on `main`.
**Fork:** `moesaleh/anyhook` (origin) · **No PRs** (direct-to-`main` convention) · baseline before this session: `dbf34e7`.

---

## Objective

The prior session applied all 50 items in `docs/ASSESSMENT-FIX-PLAN.md` and recorded a set of **non-blocking follow-ups** (CI smoke test, four missing test suites, a Kafka image-tag risk, optional connector work). This session was asked to: **(1) check the session docs for leftovers, (2) verify each against the actual code, (3) fix the stale docs + add the missing tests + add the CI smoke test + fix the Kafka tag, (4) reflect every change in the documentation, and (5) push to `main`.**

Key framing that shaped the work: **docs drift from code**, so nothing in the prior summaries was trusted at face value — every claimed leftover was re-verified against the code on disk before acting.

---

## Approach

Two Opus dynamic workflows plus a hands-on local verification pass (this session ran on a **local Linux host with Docker**, not the Hetzner remote the prior session used).

1. **Audit workflow — `leftover-audit` (10 agents, parallel).** One verifier per claimed leftover (A1–A7), one product-tracker reconciler (B1), and two repo sweeps (C1 code markers, C2 doc markers). Each returned a structured verdict (`actual_status`, `evidence` with `file:line`, `is_leftover`, `severity`). This separated genuine leftovers from **stale docs** (code ahead of docs) and **intentional optional deferrals**.
2. **Fix workflow — `leftover-fixes-wave1` (7 agents, parallel, file-disjoint).** 3 doc-correction agents + 4 test-writing agents, each owning exactly one file. The three unit-test agents self-verified by running their own `jest` file; the integration-test agent wrote only (no Postgres in-agent) and was verified centrally.
3. **Central verification (hands-on).** `docker-compose.yml` (Kafka migration) and `.github/workflows/ci.yml` (smoke job) were authored and verified by hand because they needed real infrastructure: a Kafka boot experiment, a full local compose smoke run, the full backend suite against a real Postgres, and the lint gate.

---

## What the audit found (verified against code, not docs)

- **6 genuine leftovers** — the CI smoke test (A1), four missing test suites (A2–A5), and the Kafka tag (A7). All confirmed by reading the code: the *features* existed and worked; the *tests / CI / infra tag* did not.
- **Stale docs (code AHEAD of docs)** — the highest-value finding. `docs/ARCHITECTURE.md` claimed the atomic dedup gate (P1-4) was "migrated but not yet wired" and `docs/RUNBOOK.md` called the `outbox_pending_total` gauge a "TODO", but **both are wired in code** (`webhook-dispatcher/index.js:382-417` `claimEvent` with `INSERT … ON CONFLICT DO NOTHING`; gauge at `index.js:36` set by the outbox drainer). `productfeatures.md` was broadly stale (many TODO/PARTIAL items already built).
- **Optional / intentionally deferred** — A6 custom `PartitionAssigner` (the per-message ownership guard is the chosen fix) and P1-5 range-partitioning (retention via `prune_delivery_events()` is done).
- **C1 code sweep: clean** — zero actionable TODO/FIXME/HACK in source; all `stub`/`placeholder`/`for now` hits are explanatory comments for intentional design.

---

## What landed on `main` (14 files, +539 / −137)

### Tests added — suite now **565/565** (30/30 suites; +14 tests, was 551)

| File | Added | Verified |
|------|-------|----------|
| `tests/integration/auth.test.js` | Per-account login lockout: 10× wrong password → 401, 11th → **429 + `Retry-After`** (unregistered email exercises the pre-resolution email-subject counter; isolated from other tests). | 20/20 in-file vs real Postgres |
| `tests/lib/url-validation.test.js` | NAT64 (`64:ff9b::a9fe:a9fe`→IMDS, `64:ff9b::7f00:1`→loopback) classified private; `fcm.googleapis.com`/`fdroid.org` accepted as valid. | 101/101 |
| `tests/connector/consumer.test.js` | Multi-replica divergent-assignment ownership-guard: `joinWithPartitions` extended to per-topic maps; not-owned `update_events`/`unsubscribe_events` are ignored, owned ones acted on (real `DefaultPartitioner` hashing). | 20/20 |
| `tests/lib/notifications.test.js` | `quota_warning`/`failed` template assertions for `formatSlackPayload`, `formatEmailBody`, and the email subject (via the real `dispatchNotification` seam, since `formatEmailSubject` isn't exported); asserts the default DLQ wording is absent from both branches. | 27/27 |

The four were missing because the prior session's single-file-ownership fixers couldn't author tests that cross file boundaries. **2FA-stage lockout test was deliberately deferred** — the 2FA integration suite reuses `id=1` (TRUNCATE … RESTART IDENTITY) and shares the in-memory Redis counter, so a `login:fail:<id>` test would be contaminated by sibling tests; the password-stage test already exercises the lockout mechanism.

### CI published-image boot smoke test (A1 / P0-1) — `.github/workflows/ci.yml`

New `image-smoke` job (`needs: [publish]`): logs into GHCR, writes a throwaway `.env`, then `docker compose up -d --wait --wait-timeout 240 subscription-management` — which runs the one-shot `migrate` → waits for Postgres/Redis/Kafka **healthy** → starts `subscription-management` (which only calls `app.listen()` after all three deps connect) — and asserts `/health/live`=200, dumping stack logs on failure and tearing down with `down -v`. The `deploy` job is now gated: `needs: [publish, image-smoke]`. This closes the P0-1 gap where CI built + Trivy-scanned the image but never ran it. **Verified end-to-end locally** (full stack reached healthy; `curl :3001/health/live` → `200 {"status":"ok"}`; one-shot `migrate` exited 0; `--wait` correctly tolerated the completed migrate dependency).

### Kafka image migration (A7) — `docker-compose.yml`

Not a one-line swap. `docker manifest inspect` confirmed **`bitnami/kafka:3.9.1` is gone from Docker Hub** (`no such manifest`), and so is `bitnamilegacy/kafka:3.9.1` and `bitnami/kafka:latest` — Bitnami retired its free versioned catalog, so any deploy pulling the pinned tag would fail. Only `apache/kafka:3.9.1` resolves. Migrated to it, which required the conventions the official image uses (all verified by booting it):

- env vars `KAFKA_CFG_*` → bare `KAFKA_*`; added `KAFKA_ADVERTISED_LISTENERS=PLAINTEXT://kafka:9092` (in-network clients connect via the compose service name, matching `KAFKA_HOST=kafka:9092`), `KAFKA_INTER_BROKER_LISTENER_NAME=PLAINTEXT`;
- single-broker RF=1 knobs (`KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR`, `KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR`, `KAFKA_TRANSACTION_STATE_LOG_MIN_ISR`) because the image defaults internal topics to RF=3;
- healthcheck path `kafka-broker-api-versions.sh` → `/opt/kafka/bin/kafka-broker-api-versions.sh` (not on `PATH`);
- dropped the `kafka_data` named volume — apache/kafka writes to `/tmp/kraft-combined-logs` and a root-owned named volume breaks its non-root user; the broker is explicitly ephemeral dev/CI (topics recreated on boot; outbox + `processed_events` dedup tolerate offset resets).

Verified: standalone `apache/kafka:3.9.1` boots ("Kafka Server started", broker accepting requests) and, in the full compose smoke run, reaches `healthy` and the app connects.

### Stale docs corrected (code was ahead of the docs)

- **`docs/ARCHITECTURE.md`** — rewrote §6 (delivery guarantee) and §5d (delivery flow) to state dedup is **atomic** via `processed_events` (`PRIMARY KEY (subscription_id, event_id)`, `INSERT … ON CONFLICT DO NOTHING RETURNING 1`, exactly-one-winner, fail-open + no-stable-id carve-outs), replacing the old non-atomic SELECT-then-act. Removed the false "Migrated but not yet wired" blockquote and the bogus "Atomic dedup not wired (P1-4)" gap bullet; updated ADR-0002 to "Accepted, implemented". P1-5 reworded to "retention done via `prune_delivery_events()`; partitioning is an optional follow-up".
- **`docs/RUNBOOK.md`** — `anyhook-outbox-backlog` section now states the `outbox_pending_total` gauge (labelled by `topic`) is live on the dispatcher `:9090/metrics`, updated every drain cycle, with the matching `AnyHookOutboxBacklogGrowing` alert in `prometheus/alerts.yml`; removed the "TODO: ship" wording; manual SQL kept only as an optional cross-check.
- **`productfeatures.md`** — reconciled to code after verifying each cited file: #6 sparkline checked; #8 Notifications/#9 Theming/#10 Error-handling/#13 Testing → **DONE**; #11 Bulk/#12 Export-Import/#14 Performance → **PARTIAL** (select-all done; bulk pause/resume, single-sub download, virtualization, request-dedup, optimistic-UI left unchecked as genuinely absent). Summary table + counts updated to **12 DONE / 3 PARTIAL / 0 TODO**.
- **`docs/ASSESSMENT-FIX-PLAN.md`** — the "Known follow-ups" block replaced with a "Follow-ups — RESOLVED 2026-05-31" block + the remaining optional items.

### Pre-existing lint breakage found + fixed (unplanned)

`npm run lint` (CI `backend-lint` gate) was **already RED on baseline `main`** — prettier drift in three files the prior session never touched: `src/lib/notifications.js`, `tests/lib/rate-limit.test.js`, `tests/integration/two-factor.test.js` (confirmed `git diff HEAD` = empty for each before the fix). The original assessment never ran `npm run lint`, so its "verified green" missed this. Fixed with `eslint . --fix` (prettier formatting only — `src/lib/notifications.js` diff confirmed to be argument-list reflows + redundant-paren removal, no logic change). Gate now: **0 errors**, 40 pre-existing `no-console` warnings (non-failing).

---

## Verification evidence (all real execution)

| Check | Command | Result |
|-------|---------|--------|
| Full backend suite + coverage | `TEST_DATABASE_URL=…@localhost:55432 npm run test:coverage` | **30/30 suites, 565/565 pass**, no coverage-threshold violation (global lines 73%, `src/lib` above floor) — re-run clean after the lint `--fix` |
| Migrations on fresh DB | jest `global-setup` | **24 migrations apply cleanly** |
| Integration lockout | `npx jest tests/integration/auth.test.js --verbose` | 20/20 in-file (429 + `Retry-After` confirmed) |
| Unit suites (self-verified by agents) | `npx jest <file>` | url-validation 101 · notifications 27 · connector 20 |
| Lint gate | `npm run lint` | **0 errors** |
| Kafka image resolves | `docker manifest inspect …` | `bitnami/kafka:3.9.1` ✗ · `bitnamilegacy/kafka:3.9.1` ✗ · **`apache/kafka:3.9.1` ✓** |
| Kafka boots | standalone `docker run apache/kafka:3.9.1` | "Kafka Server started"; `/opt/kafka/bin/kafka-broker-api-versions.sh` OK |
| Full image smoke | `IMAGE_TAG=… docker compose up -d --wait subscription-management` + `curl /health/live` | migrate→PG/Redis/**apache-kafka**/mgmt all **healthy**; `/health/live` → **200** |

Local toolchain: Node 22.22.2, npm 10.9.7, Docker 28.2.2, Compose 2.37.1. A throwaway `postgres:17.2` (host port 55432) backed the jest integration run; the compose smoke used overridden published ports (13001/15432/16379/19092) to dodge this host's existing `:5432`.

---

## Still open (optional only, non-blocking)

- **P1-2** — custom Kafka `PartitionAssigner` co-partitioning the three sub-topics. The per-message ownership guard is the implemented + now-tested fix; the assigner is an optimization only.
- **P1-5** — `delivery_events` range-partitioning. Retention via `prune_delivery_events()` (external scheduler) is done; partitioning is the optional long-term form.

---

## Process / infra notes

- Commit convention: direct to `main` on the fork, **no PRs**, no upstream writes.
- This session ran locally (Linux + Docker), unlike the prior session's Hetzner remote.
- **Cleanup done:** the throwaway `.env`, the `anyhook-itest-pg` Postgres container, the `katest` Kafka experiment, the `ghcr.io/moesaleh/anyhook:smoke-local` image, and the smoke compose stack (`down -v --remove-orphans`) were all removed. Working tree contains only the 14 intended files.
- Untracked `.claude/settings.local.json` (machine-local Claude Code settings) intentionally left uncommitted.

---

## Prior session (for continuity)

The previous session (`1da4463..098b318`, 69 files, +10,008/−919) applied all 50 fix-plan items (6 P0 / 10 P1 / 34 P2) via a 22-agent apply workflow + a 17-agent verify workflow (6 verifiers + 6 adversarial auditors + 5 Hetzner probes), fixing 11 follow-on defects, and verified on a remote Hetzner stack (real Postgres 17 + Redis 7 + Kafka). Key artifacts then: `src/lib/ssrf-guard.js`, `src/webhook-dispatcher/outbox-drainer.js`, 7 migrations, the dashboard polling/PWA/error-boundary work, `docs/ARCHITECTURE.md`, and the dispatcher/connector/notification test suites. Full detail in `docs/ASSESSMENT-FIX-PLAN.md` and the git history.
