# Last Session Summary — AnyHook Assessment Fix Plan

**Date:** 2026-05-31
**Outcome:** ✅ Complete. All 50 fix-plan items applied, independently verified on real infrastructure, and landed on `main`.
**Fork:** `moesaleh/anyhook` (origin) · **Final commit:** `098b318` (pushed) · **No PRs.**

---

## Objective

Execute every item in `docs/ASSESSMENT-FIX-PLAN.md` (6 P0 / 10 P1 / 34 P2 = 50), verify the work with **real adversarial testing against real infrastructure** (not happy-path mocks), and commit to `main`.

## Approach

Two Opus, fully-parallel dynamic workflows (scripts kept in `.claude/workflows/`):

1. **`assessment-fixes.js`** — 22 agents across 3 dependency waves, partitioned by **disjoint file ownership** so no two concurrent agents ever wrote the same file.
   - Wave 1 (Foundation, 12 agents): leaf files — `ssrf-guard`, secrets, infra/Docker, CI, 7 new migrations, quota/rate-limit libs, auth, jest config, dashboard ×3, docs.
   - Wave 2 (Services, 5 agents): dispatcher, connector, mgmt-app, mgmt-index, notifications.
   - Wave 3 (Tests, 5 agents): dispatcher/connector/notification suites, coverage gate, dashboard e2e.
2. **`verify-fixes.js`** — 17 agents in parallel: 6 fix-verifiers + 6 adversarial auditors + **5 real Hetzner probe agents**, then a synthesizer, then dynamic file-disjoint corrective fixers.

**Testing was done entirely on a remote Linux host** (Hetzner, `hetzner-moelabs` MCP) in an isolated `av-*` docker stack — real Postgres 17 + Redis 7 + Kafka. Nothing was run/built/tested on the local Windows machine.

---

## What landed on `main`

`1da4463..098b318` — **69 files changed, +10,008 / −919.** Commits:

| Commit | What |
|--------|------|
| `362636d` | Apply assessment fix plan (P0/P1/P2) via the 22-agent workflow |
| `86e6cf9` | 11 corrective fixes from the parallel verification workflow |
| `20a3a5b` | Fix pre-existing stale `Disable 2FA` test (re-login for fresh session) |
| `098b318` | Mark plan items verified-done + record real-infra evidence + follow-ups |

Key new artifacts: `src/lib/ssrf-guard.js`, `src/webhook-dispatcher/outbox-drainer.js`, 7 migrations (`processed_events`, delivery_events retention, composite org FK, `created_at` → timestamptz, totp-encryption note, notification-attempts retention, email-lower verify), `dashboard/src/lib/use-visible-polling.ts`, `public-paths.ts`, route `loading.tsx`/`error.tsx`, `manifest.ts`, `docs/ARCHITECTURE.md`, and full dispatcher/connector/notification test suites.

---

## Verification evidence (all real execution, not mocks)

| Check | Result |
|-------|--------|
| Backend jest (real Postgres) | **551 / 551 pass**, 30/30 suites |
| Migrations on fresh DB | **24 apply cleanly** |
| **P0-3** advisory lock | `pg_locks` shows **0 leaked** advisory locks after a real `/subscribe` |
| **P0-4** SSRF | real ssrf-guard blocks literal + DNS-resolved IMDS/private; `maxRedirects:0`; **real dispatcher** parks a private `webhook_url` to DLQ and never contacts it (20/20 e2e); NAT64 `64:ff9b::/96` IMDS bypass + `fc`/`fd` false-positives closed |
| **P0-2** quota_warning | genuinely fires via real `dispatchNotification` (no ReferenceError) |
| **P0-1 / P1-9** boot | all 3 services boot on real infra, `/health/live`=200, `RUN_MIGRATIONS_ON_BOOT=false`; crash-loop does NOT reproduce |
| **P1-4 / P2-11 / P2-12** | dedup → 1 row; composite FK **rejects** org/owner mismatch (SQLSTATE 23503); `subscriptions.created_at` is `timestamptz` |
| **P2-2** rate-limit | atomic Lua `INCR`+`PEXPIRE`, fails open (positive control reproduced the non-atomic gap) |
| Dashboard | lint ✅ · `tsc --noEmit` ✅ · `next build` ✅ · vitest 88/88 ✅ |

The `Disable 2FA` test was proven **pre-existing broken on baseline `main` (1da4463)** — it reused a cookie that `/auth/2fa/disable` intentionally invalidates (token_version bump + cookie clear, behavior unchanged from baseline). Corrected the stale assertion to re-login; not a regression from the fixes.

---

## Defects found by the verification workflow and FIXED (11)

The adversarial auditors caught real issues the apply pass missed; all were corrected in `86e6cf9`:

1. **[med] login throttle non-atomic** — new per-account lockout used non-atomic INCR+EXPIRE and fails *closed* → a Redis blip could permanently lock an account. Fixed with atomic Lua + TTL self-heal.
2. **[med] login throttle dead in prod** — `createApp` never passed `redisClient` to `mountAuthRoutes`, so the lockout did nothing. Wired it through.
3. **[med] SSRF classifier gaps** — `fc`/`fd` prefix wrongly rejected public hosts (e.g. `fcm.googleapis.com`); NAT64 embedded-IPv4 IMDS bypass. Fixed both.
4. **[high] connector cross-topic ownership** — at ≥3 replicas, update/unsubscribe could leak/duplicate upstream sockets. Added a per-message ownership guard (multi-replica test run, passed).
5. **[low] dispatcher deleted-sub audit row** vs composite FK — durable metric+log added.
6. **[low] quota_warning used DLQ wording** — branched notification templates by event type.
7. **[low] `processed_events.event_id` TEXT** vs UUID siblings — converged to UUID.
8–11. **[low] dashboard** — delivery-table hidden-tab poll; 3 native `confirm()` → accessible ConfirmDialog.

---

## Remaining scope (non-blocking follow-ups)

Tracked in the "Verification status" block of `docs/ASSESSMENT-FIX-PLAN.md`. None block `main` (it is green and verified).

- **CI published-image boot smoke test** — CI builds + Trivy-scans the image but never `docker run`s it. Boot is proven locally (probe-service-boot); add a CI step that runs the published image and asserts it reaches "listening". (Relates to P0-1.)
- **Coverage tests the single-file-ownership fixers could not add** (they were restricted to one file each):
  - login/2FA lockout integration test (assert 429 + Retry-After after > `LOGIN_FAIL_MAX` failures).
  - `url-validation` regression cases: `fcm.googleapis.com`/`fdroid.org` valid; `64:ff9b::a9fe:a9fe` / `64:ff9b::7f00:1` classified private.
  - connector multi-replica divergent-assignment test (extend `tests/connector/consumer.test.js` `joinWithPartitions` to set per-topic assignments).
  - notification template assertions (quota_warning / failed) in `tests/lib/notifications.test.js`.
- **P1-2 connector** — current fix re-checks ownership per message (correct + tested). A stronger long-term option is a custom Kafka `PartitionAssigner` that co-partitions the three sub-topics; optional.
- **Doc/infra notes** surfaced during testing (not yet changed): `docker-compose.yml` pins `bitnami/kafka:3.9.1` which now returns `manifest unknown` from the registry — a real deploy would fail to pull; consider a maintained tag (e.g. `apache/kafka`). Kafka brokers are read from `KAFKA_HOST` (consistent across code + `.env.example`).

---

## Process / infra notes

- Commit convention: direct to `main` on the fork, **no PRs**, no upstream writes.
- Verification ran on the remote host in an isolated `av-pg` / `av-redis` / `av-kafka` stack on a dedicated `av-net` network (no published-port conflicts with the host's other projects).
- **Cleanup done:** all `av-*` containers, the `av-net` network, and the clone dirs (`/root/anyhook-{verify,v2,main}`) were removed; the host's other 24 long-lived containers (`mtdb-*`, `deploy-*`, `memturbodb-*`, `dashboard-pg`, freeradius) were left untouched.
- Ephemeral `verify/assessment-fixes` branch (used only to ship code to the test host) was deleted local + origin.

**Current state:** working tree clean except untracked `.claude/settings.local.json` (machine-local Claude Code settings, intentionally not committed). `main` == `origin/main` == `098b318`.
