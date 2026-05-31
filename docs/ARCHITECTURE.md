# AnyHook — Architecture

> Companion to the top-level [README](../README.md). This document describes the
> system as it is actually implemented in `src/`, `migrations/`, and
> `docker-compose.yml` — not an aspirational design. Where the running code and
> the desired end-state differ (e.g. the connector's single-pod constraint), that
> gap is called out explicitly so operators are not surprised.

## 1. What AnyHook is

AnyHook is a multi-tenant subscription proxy. A tenant (an **organization**)
registers a subscription that points at an upstream **source** (a GraphQL
subscription or a WebSocket endpoint) and a **webhook URL**. AnyHook holds the
upstream connection open, and every message the source emits is delivered as a
signed HTTP POST to the webhook URL, with a persistent retry ladder and a dead
letter queue (DLQ) for deliveries that exhaust their retries.

The system is split into three backend services that communicate over Kafka,
plus a Next.js dashboard. PostgreSQL is the system of record; Redis is a hot
cache; Kafka is the event bus.

## 2. Services (three entry points)

There is **one Docker image** for the backend; each service is the same image
run with a different `command`. There are **three independent process entry
points**, one per service:

| Service | Entry point | Role |
|---------|-------------|------|
| **subscription-management** | `src/subscription-management/index.js` (mounts the Express app from `src/subscription-management/app.js`) | REST API: auth, orgs/members, subscriptions CRUD, API keys, delivery history/stats, notification prefs, admin. Owns Kafka **topic creation** and (in the legacy boot path) migrations. |
| **subscription-connector** | `src/subscription-connector/index.js` | Holds upstream GraphQL/WebSocket connections open; turns every source message into a `connection_events` Kafka record. Consumes `subscription_events` / `update_events` / `unsubscribe_events`. |
| **webhook-dispatcher** | `src/webhook-dispatcher/index.js` | Consumes `connection_events`, signs + POSTs to the webhook URL, runs the **retry-queue poller**, the **outbox drainer**, and the **notification-attempts poller**. |

`subscription-management/index.js` constructs the real `pg` / `redis` / `kafka`
clients and passes them into `createApp()`; the Express app is a pure factory so
integration tests can inject fakes. The two worker services have no public HTTP
surface — they expose only an internal metrics/health server (see §8).

## 3. Data stores and their roles

- **PostgreSQL — system of record.** Subscriptions, organizations, users,
  memberships, API keys, delivery history (`delivery_events`), the retry queue
  (`pending_retries`), the transactional outbox (`outbox_events`), notification
  preferences and persisted notification attempts (`notification_attempts`), and
  the idempotency table (`processed_events`). All tenant data is scoped by
  `organization_id`.
- **Redis — hot cache + counters.** Cached subscription rows under the `sub:*`
  key namespace (read on the delivery hot path and by the connector on reload),
  plus rate-limit counters. Redis is treated as a cache: the dispatcher falls
  back to Postgres on a miss and re-warms; the connector currently does **not**
  (see Known gaps).
- **Kafka — event bus.** Decouples the API write path from connection setup and
  from webhook delivery. Keyed by `subscriptionId` so all events for one
  subscription land on one partition (per-subscription ordering at the bus
  level).

## 4. Kafka topics (all five)

Topics are created **once**, by `subscription-management` (`createKafkaTopics()`
in `src/subscription-management/index.js`), with `KAFKA_PARTITIONS` partitions
(default 8) and `KAFKA_REPLICATION_FACTOR` (default 1 — see HA notes). No other
service creates topics, and `allowAutoTopicCreation` is `false` on every
producer.

| Topic | Produced by | Consumed by | Purpose |
|-------|-------------|-------------|---------|
| `subscription_events` | subscription-management (via outbox) | subscription-connector | "A new subscription exists — open the upstream connection." |
| `update_events` | subscription-management (via outbox) | subscription-connector | "This subscription's config changed — tear down and reopen with the new config." |
| `unsubscribe_events` | subscription-management (via outbox) | subscription-connector | "This subscription is gone — close the upstream connection." |
| `connection_events` | subscription-connector | webhook-dispatcher | One record per upstream source message; carries `{ subscriptionId, eventId, data }`. |
| `dlq_events` | webhook-dispatcher (`sendToDLQ`) | **(no consumer)** | Tombstone for deliveries that exhausted the retry ladder. Write-only today — see Known gaps. |

> `update_events` is easy to miss: it is the path that propagates a
> `PUT /subscriptions/:id` config change to the live upstream connection.

## 5. Request → connection → delivery flow

### 5a. Create a subscription (the transactional outbox)

The API does **not** publish to Kafka inline anymore. `POST /subscribe` runs in a
single Postgres transaction:

1. `BEGIN`
2. `INSERT` the subscription row (system of record).
3. `enqueueOutbox(client, 'subscription_events', subscriptionId, subscriptionId)`
   — `INSERT` the intended Kafka publish into `outbox_events`, in the **same**
   transaction (`src/lib/outbox.js`).
4. `COMMIT`
5. Write the subscription row into Redis (`sub:<id>`) so it is hot for delivery.

Because the subscription row and the outbox row commit atomically, the "DB
committed but Kafka publish was lost" failure mode is eliminated. The
`producer` is still passed into `createApp()` only for caller compatibility; the
publish itself happens later in the drainer.

The **outbox drainer** (in `webhook-dispatcher`, `pollOutbox()`) then:

1. Sweeps stale locks (a worker that crashed mid-publish).
2. Claims a batch of undelivered rows with
   `... FOR UPDATE SKIP LOCKED` (multi-pod safe).
3. `producer.send(topic, { key, value })` for each, and on success marks
   `delivered_at`. On failure it unlocks, bumps `attempts`, records
   `last_error`, and the next sweep retries.

The same outbox path backs `unsubscribe` (`unsubscribe_events`),
`PUT /subscriptions/:id` (`update_events`), bulk subscribe, and admin-wipe.

### 5b. Open the upstream connection

`subscription-connector` consumes `subscription_events`. For each, it reads the
cached subscription from Redis, selects the handler for
`subscription.connection_type` (`graphql` or `websocket`), and opens the upstream
connection. `update_events` does disconnect-then-reconnect with the new config;
`unsubscribe_events` closes the connection and deletes the `sub:*` key.

On restart, `reloadActiveSubscriptions()` does a `SCAN MATCH 'sub:*'` over Redis
and reconnects everything it finds, so connections survive a connector bounce.

### 5c. Source message → Kafka

When the upstream emits a message, the handler calls
`raiseConnectionEvent(subscriptionId, data)` (`handlers/baseHandler.js`), which
generates an `eventId` **on the producer side** and publishes
`{ subscriptionId, eventId, data }` to `connection_events` keyed by
`subscriptionId`. Generating `eventId` here is what makes a Kafka redelivery
idempotent downstream (see §6).

### 5d. Deliver the webhook + retry ladder + DLQ

`webhook-dispatcher` consumes `connection_events` (manual offset commit, so a
crash mid-delivery replays rather than drops):

1. **Look up** the subscription from Redis; fall back to Postgres on a miss and
   re-warm Redis. (Resolving the subscription *before* claiming the event means a
   transient "not cached yet" miss doesn't burn the event's idempotency marker.)
2. **Atomic dedup gate** (`claimEvent`) — `INSERT INTO processed_events
   (subscription_id, event_id, organization_id) ... ON CONFLICT DO NOTHING
   RETURNING 1`. The `PRIMARY KEY (subscription_id, event_id)` makes the
   insert-or-skip atomic, so under a rebalance double-delivery (or two pods racing
   the same event) **exactly one** caller gets a row back and proceeds; the loser
   sees `rowCount === 0` and skips. This replaced the old non-atomic
   `SELECT 1 FROM delivery_events` check-then-act (see §6). Events with no
   producer-supplied id can't be deduped, and a PG error fails open — both
   proceed rather than silently drop a legitimate event.
3. **Sign + POST** — HMAC-SHA256 over `` `${timestamp}.${body}` `` using the
   per-subscription `webhook_secret`, sent as `X-AnyHook-Signature` /
   `X-AnyHook-Timestamp`, plus subscription/event/attempt headers. The
   pre-serialized body is passed to axios so the bytes the receiver hashes match
   exactly.
4. **On failure**, the attempt is enqueued into `pending_retries` and the
   **retry poller** (`pollRetryQueue()`) re-fires it when due, climbing the
   ladder: **15 min → 1 h → 2 h → 6 h → 12 h → 24 h** (`retryIntervals` in
   minutes). `pending_retries` uses the same `FOR UPDATE SKIP LOCKED` claim +
   stale-lock sweep, and an `ON CONFLICT ... GREATEST(...)` guard so a duplicate
   re-enqueue at a lower retry count can't reset progress.
5. **After the last attempt fails**, the message is published to `dlq_events`
   and a `dlq` notification is dispatched (email/Slack per the org's
   `notification_preferences`). The terminal `delivery_events` row was already
   written with the real HTTP status; `sendToDLQ` does not double-record.

Every attempt (initial + each retry + terminal) writes one `delivery_events`
row, which is what the dashboard's delivery history and `/deliveries/stats`
read.

## 6. Delivery guarantee — at-least-once, with dedup (NOT exactly-once / ordered)

**AnyHook delivers each source event at least once.** It does **not** provide
exactly-once or globally ordered delivery, and the README/dashboard should not
be read as promising that.

Why at-least-once:

- Kafka consumers (connector and dispatcher) use **manual offset commits** so a
  crash before commit replays the message rather than losing it.
- The transactional outbox guarantees the DB write and the *intent* to publish
  commit together, but the publish → broker-durability hop is only as strong as
  the broker config. With the default single broker / `RF=1`, an acknowledged
  publish can still be lost on broker disk loss (see §7).

Deduplication of those replays is **atomic in the running code**: before
sending, the dispatcher (`claimEvent` in `src/webhook-dispatcher/index.js`) runs

```sql
INSERT INTO processed_events (subscription_id, event_id, organization_id)
VALUES ($1, $2, $3)
ON CONFLICT DO NOTHING
RETURNING 1;
```

The `PRIMARY KEY (subscription_id, event_id)` on `processed_events` (migration
`20260509000000_add_processed_events`) makes the insert-or-skip atomic, so the
claim is settled by Postgres in one statement: under two near-simultaneous
redeliveries (a rebalance window) or two pods racing the same event, **exactly
one** caller gets a row back (`rowCount === 1`) and proceeds; every loser sees
`rowCount === 0` and skips. This **replaced** the old non-atomic
`SELECT 1 FROM delivery_events WHERE subscription_id=? AND event_id=?`
check-then-act, which had no enforcing unique constraint and could let both
racers pass the check and double-fire.

Two deliberate carve-outs keep the gate from dropping legitimate traffic:
events with no producer-supplied id (legacy in-flight messages) carry no stable
dedup key, so they always proceed; and on a Postgres error the claim **fails
open** (proceeds), preferring a possible duplicate over silently dropping an
event when the DB is flaky. `delivery_events` is left untouched as the
per-attempt history table — it legitimately holds many rows per event — so the
dedicated `processed_events` table is what carries the one-row-per-event
uniqueness. See [`ADR-0002`](#adr-0002).

Ordering: events for a single subscription are keyed to one Kafka partition, so
they are produced in order — but the retry ladder means a retried event can be
delivered *after* a later live event for the same subscription. Receivers should
treat `X-AnyHook-Event-Id` as the dedup/ordering key and tolerate reordering.

## 7. Scaling & HA

**Partition-based scaling (workers).** Topics are created with 8 partitions by
default so up to 8 consumers per group can run in parallel; Kafka assigns each
partition to one consumer. The `pending_retries`, `outbox_events`, and
`notification_attempts` pollers are all `FOR UPDATE SKIP LOCKED` claim loops, so
multiple dispatcher pods drain them safely.

`docker-compose.yml` runs the two workers without a fixed `container_name`
(so `--scale` / `deploy.replicas` works) and ships a one-shot `migrate` job that
the app services gate on (`service_completed_successfully`) — migrations no
longer run on every API pod's boot, and `node-pg-migrate` ships in
`dependencies` so the pruned production image can run them.

**Connector single-pod caveat (important).** Despite the partitioned topics, the
connector keeps its upstream connections in process memory and
`reloadActiveSubscriptions()` reconnects to **every** `sub:*` it finds in Redis —
on **every** pod. Running more than one connector replica therefore opens N
duplicate upstream connections per subscription and fan-outs N copies of every
source event. Until connection ownership is bound to partition ownership (fix
plan **P1-2**), **run exactly one connector replica** — `docker-compose.yml`
pins `subscription-connector` to `deploy.replicas: 1` for this reason. The
dispatcher has no such constraint and can be scaled up to the partition count.

**Kafka durability.** The default compose stack is a **single-node** Kafka
(`RF=1`) — fine for dev/CI, a SPOF with no durability guarantee for production.
For production, run a 3-broker quorum with `RF>=3` and
`min.insync.replicas=2`, and configure producers with `acks: 'all'` +
`idempotent: true` (fix plan **P1-8**; the compose file documents the prod
topology inline).

## 8. Observability

Each service runs an **internal** HTTP server (`src/lib/metrics-server.js`) on
`METRICS_PORT` (default **9090**) exposing `GET /metrics` (Prometheus) and
`GET /health`. This port is **not** published by `docker-compose.yml`, so
`/metrics` is reachable only inside the Docker network — it is not part of the
public API surface. (`subscription-management` serves `/metrics` and `/health`
on this same internal port; its public Express app exposes `/health/live`
liveness and `/health` readiness separately.)

Custom gauges/counters include `outbox_pending_total` (per topic),
`webhook_pending_retries`, `notification_attempts_pending_total` (per status),
`webhook_deliveries_total` (by status), and `webhook_delivery_duration_seconds`.
Prometheus alert rules live in `prometheus/alerts.yml` with a matching
[`RUNBOOK`](./RUNBOOK.md).

## 9. Multi-tenancy, quotas & rate limiting

Every tenant data query filters by `organization_id` from the authenticated
session/API key (not from the request body). Subscription and API-key **quotas**
are enforced per org under a `pg_advisory_xact_lock` keyed on the org; crossing
the warn threshold dispatches a `quota_warning` notification (with a cooldown via
`organizations.last_quota_warning_at`). **Rate limiting** is a Redis fixed-window
limiter keyed per org (or per user-per-org when `RATE_LIMIT_PER_USER=true`), with
a separate stricter limiter on auth endpoints.

## 10. Notifications

Operator alerts for `dlq`, `failed`, and `quota_warning` events are persisted to
`notification_attempts` and delivered via email and/or Slack according to the
org's `notification_preferences`. Failed sends (SMTP outage, Slack 429) are
retried by the `notification_attempts` poller (in `webhook-dispatcher`) on a
backoff ladder (1 m → 5 m → 30 m → 2 h → terminal) using the same
`FOR UPDATE SKIP LOCKED` claim pattern.

## 11. Known gaps (tracked in the fix plan)

These are the architecturally significant gaps between this design and a
fully-production-hardened deployment. Each maps to an item in
[`ASSESSMENT-FIX-PLAN.md`](./ASSESSMENT-FIX-PLAN.md):

- **Connector cannot scale past one replica** (P1-2) — connections aren't sharded
  by partition ownership. Single-replica until fixed.
- **`delivery_events` retention needs an external scheduler** (P1-5) — retention
  **is** implemented as the bounded-`DELETE` function `prune_delivery_events(...)`
  (migration `20260510000000_delivery_events_retention`), but the function must be
  invoked by an external scheduler (cron / k8s CronJob / pg_cron) — AnyHook does
  not ship one. Range-partitioning `delivery_events` by `created_at` (which would
  let retention be a cheap `DROP PARTITION` instead) is an **optional** follow-up
  documented in that migration, not a missing capability.
- **DLQ is write-only** (P2-3) — `dlq_events` has no consumer / redrive path.
- **Connector recovery depends on Redis** (P1-10) — no Postgres fallback on a
  `sub:*` miss, unlike the dispatcher.
- **Kafka HA / producer durability** (P1-8) — single broker, `RF=1`, no
  `acks:'all'` / `idempotent:true` in the default config.

---

## Architecture Decision Records (lightweight)

### ADR-0001 — Transactional outbox for Kafka publishes

**Status:** Accepted, implemented.

**Context.** The API used to write Postgres + Redis and then publish to Kafka
inline. If the process died (or Kafka was briefly unavailable) between the DB
commit and the publish, the subscription existed in the database but the
connector was never told to open the connection — a silent, hard-to-detect
inconsistency. Publishing inline also put Kafka latency/availability on the
synchronous request path.

**Decision.** Persist the intended publish into an `outbox_events` row inside the
**same transaction** as the subscription write (`enqueueOutbox`,
`src/lib/outbox.js`). A separate drainer in `webhook-dispatcher` (`pollOutbox`)
claims undelivered rows with `FOR UPDATE SKIP LOCKED` and publishes them to
Kafka, marking `delivered_at` on success and retrying via a stale-lock sweep on
failure.

**Consequences.**
- The DB-commit → publish-intent step is now atomic; "committed but never
  published" is gone. The API path no longer blocks on Kafka.
- Publishing is asynchronous, so there is a small visibility lag between commit
  and the connector acting (bounded by `OUTBOX_POLL_INTERVAL_MS`, default ~1 s).
- The guarantee is end-to-end only as strong as Kafka durability; with `RF=1` an
  acknowledged publish can still be lost on broker disk loss (see P1-8).
- Colocating the drainer in the dispatcher couples connector-event propagation to
  the dispatcher deploy (tracked as P2-18); functionally correct and multi-pod
  safe today.

### ADR-0002 — At-least-once delivery with deduplication (not exactly-once)

**Status:** Accepted, implemented. The atomic `processed_events` dedup gate is
wired into the dispatcher (P1-4).

**Context.** Webhook delivery crosses two unreliable boundaries (Kafka redelivery
on rebalance/crash, and the receiver's own reliability). Exactly-once across an
arbitrary third-party HTTP endpoint is not achievable; the realistic, honest
target is at-least-once with a strong dedup key so well-behaved receivers can
ignore duplicates.

**Decision.** Generate `eventId` on the **producer** side
(`raiseConnectionEvent`) so a redelivered Kafka message carries the same id; use
manual offset commits so a crash replays rather than drops; expose the id to
receivers as `X-AnyHook-Event-Id`. Dedup redeliveries in the dispatcher before
sending, with a **DB-enforced atomic claim** rather than a check-then-act read.

**Consequences.**
- Receivers must be idempotent on `X-AnyHook-Event-Id` and tolerate reordering
  (a retried event can arrive after a later live event for the same
  subscription).
- The dispatcher dedup is an atomic claim against the single-row-per-event
  `processed_events` table whose primary key makes the gate atomic
  (`INSERT ... ON CONFLICT DO NOTHING`; proceed only if `rowCount === 1`). This
  **replaced** the old non-atomic `SELECT` against `delivery_events`, which could
  double-fire on a tight redelivery race — the guarantee is now DB-enforced, not
  best-effort, without changing the at-least-once contract. The claim fails open
  on a Postgres error (prefers a possible duplicate over dropping a legitimate
  event), and events lacking a producer-supplied id can't be deduped.
- We deliberately do **not** put a `UNIQUE(subscription_id, event_id)` on
  `delivery_events` itself, because that table legitimately holds many rows per
  event (one per attempt); the dedicated `processed_events` table carries the
  uniqueness instead.
