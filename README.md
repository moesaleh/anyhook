# AnyHook

<div align="center">

[![GitHub license](https://img.shields.io/github/license/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/stargazers)
[![GitHub issues](https://img.shields.io/github/issues/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/SwanBlocks-inc/anyhook)](https://github.com/SwanBlocks-inc/anyhook/pulls)
[![Build Status](https://github.com/SwanBlocks-inc/anyhook/workflows/CI/CD%20Pipeline/badge.svg)](https://github.com/SwanBlocks-inc/anyhook/actions)

</div>

AnyHook is a powerful and flexible subscription proxy server that connects various data sources (GraphQL, WebSocket) to webhook endpoints in real-time. It provides a robust, scalable, and fault-tolerant solution for managing subscriptions and delivering real-time data to your applications.

## 🚀 Features

- **Multiple Data Source Support**
  - GraphQL Subscriptions
  - WebSocket Connections
  - Easy to extend for other protocols

- **Robust Architecture**
  - Microservices-based design
  - Event-driven architecture using Kafka
  - High availability and fault tolerance

- **Advanced Capabilities**
  - Automatic reconnection handling
  - Configurable retry mechanisms
  - Dead Letter Queue (DLQ) for failed deliveries
  - Rate limiting and throttling
  - Monitoring and metrics

- **Developer-Friendly**
  - Clear documentation
  - Easy to set up and configure
  - Extensible architecture
  - Docker support

## 🛠️ Quick Start

### Using Docker Compose

```bash
# Clone the repository
git clone https://github.com/SwanBlocks-inc/anyhook.git
cd anyhook

# Copy and configure environment variables
cp .env.example .env

# Start the services
docker-compose up -d
```

### Manual Installation

```bash
# Install dependencies
npm install

# Start the server
npm start
```

## 🔧 Configuration

AnyHook can be configured using environment variables. See [.env.example](.env.example).


## 🏗️ Architecture

AnyHook consists of three backend services (one Docker image, three process
entry points) over a Kafka event bus, with PostgreSQL as the system of record
and Redis as a hot cache:

1. **Subscription Management** — `src/subscription-management/index.js`
   - Multi-tenant REST API (auth, organizations/members, subscriptions CRUD,
     API keys, delivery history/stats, notification preferences, admin)
   - Owns Kafka topic creation; writes Kafka publishes to the transactional
     **outbox** inside the same DB transaction as the subscription row
   - Enforces per-org quotas and rate limits

2. **Subscription Connector** — `src/subscription-connector/index.js`
   - Holds upstream GraphQL/WebSocket connections open
   - Turns every source message into a `connection_events` Kafka record
   - Consumes `subscription_events` / `update_events` / `unsubscribe_events`

3. **Webhook Dispatcher** — `src/webhook-dispatcher/index.js`
   - Signs (HMAC-SHA256) and POSTs payloads to webhook endpoints
   - Runs the persistent **retry-queue**, **outbox drainer**, and
     **notification-attempt** pollers (all `FOR UPDATE SKIP LOCKED`)
   - Moves exhausted deliveries to the Dead Letter Queue

> A fuller writeup — every Kafka topic, the outbox flow, the delivery
> guarantee, scaling/HA constraints, and architecture decision records — is in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guidelines](CONTRIBUTING.md) for details.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🔒 Security

For security issues, please see our [Security Policy](SECURITY.md).

## 🌟 Support

- 🐛 Report bugs by opening [GitHub issues](https://github.com/SwanBlocks-inc/anyhook/issues)
- 💡 Request features in our [GitHub discussions](https://github.com/SwanBlocks-inc/anyhook/discussions)

## 🙏 Acknowledgments

Special thanks to all our contributors and the open source community!

---

## Overview

AnyHook is a multi-tenant subscription proxy. A tenant (an **organization**)
registers a subscription pointing at an upstream **source** (a GraphQL
subscription or a WebSocket endpoint) and a **webhook URL**; AnyHook holds the
upstream connection open and delivers every source message as a signed HTTP POST
to the webhook, with a persistent retry ladder and a Dead Letter Queue for
deliveries that exhaust their retries. It is built from three backend services
(Subscription Management, Subscription Connector, Webhook Dispatcher) over a
Kafka event bus, with PostgreSQL as the system of record, Redis as a hot cache,
and a Next.js dashboard.

> This section summarises the architecture. The authoritative, fuller version —
> including the transactional outbox internals, scaling/HA constraints, and
> architecture decision records — lives in
> [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Architecture

The system is divided into the following components:

### 1. **Subscription Management Component**
- **Role**: Multi-tenant REST API — auth, organizations/members, subscription
  CRUD, API keys, delivery history/stats, notification preferences, and admin
  endpoints. It is the **only** service that creates Kafka topics.
- **Key endpoints**:
  - `/subscribe`: Creates a subscription. In a single DB transaction it inserts
    the subscription row **and** writes the Kafka publish into the transactional
    outbox (`outbox_events`); then it warms the Redis cache. It does **not**
    publish to Kafka inline.
  - `/unsubscribe`, `PUT /subscriptions/:id`, bulk subscribe: same outbox
    pattern, writing `unsubscribe_events` / `update_events` / `subscription_events`
    rows atomically with the data change.
- **Multi-tenancy**: every tenant query is scoped by `organization_id` from the
  session/API key; per-org subscription/API-key **quotas** (advisory-locked) and
  Redis **rate limiting** are enforced here.
- **Persistence**: PostgreSQL is the system of record; Redis caches subscription
  rows under the `sub:*` namespace for fast lookup.

### 2. **Subscription Connector Component**
- **Role**: Manages upstream connections based on subscription data, opening
  GraphQL or WebSocket connections as required and publishing each received
  message to `connection_events`.
- **Capabilities**:
  - Selects the handler (GraphQL or WebSocket) from `connection_type`.
  - Consumes `subscription_events` (open), `update_events` (reconnect with new
    config), and `unsubscribe_events` (close) from Kafka.
  - On restart, reloads all active subscriptions via a Redis `SCAN MATCH 'sub:*'`
    so connections survive a connector bounce.
- **Handlers**: **GraphQLHandler** and **WebSocketHandler**, each generating the
  `eventId` (producer-side) that the dispatcher uses for idempotency.
- **Scaling caveat**: connections live in process memory and every pod reloads
  **all** `sub:*` keys, so this service must run as a **single replica** until
  connection ownership is sharded by partition (see Scaling below).

### 3. **Webhook Dispatcher Component**
- **Role**: Delivers `connection_events` to webhook URLs and runs the system's
  background pollers.
- **Capabilities**:
  - Consumes `connection_events`, looks up the subscription (Redis, falling back
    to Postgres and re-warming), and POSTs the payload **signed** with
    HMAC-SHA256 (`X-AnyHook-Signature` / `X-AnyHook-Timestamp`).
  - On failure, enqueues into `pending_retries`; the retry poller re-fires on a
    ladder of 15 minutes, 1 hour, 2 hours, 6 hours, 12 hours, and 24 hours.
  - Moves deliveries that exhaust the ladder to the Dead Letter Queue
    (`dlq_events`) and dispatches a notification.
  - Also runs the **outbox drainer** (publishes the management service's outbox
    rows to Kafka) and the **notification-attempt** poller — all three pollers
    use `FOR UPDATE SKIP LOCKED` and are multi-pod safe.

### 4. **Kafka**
- **Role**: Event bus decoupling the API write path from connection setup and
  webhook delivery. Keyed by `subscriptionId` (per-subscription ordering at the
  bus level). Topics are created once by Subscription Management with
  `KAFKA_PARTITIONS` partitions (default 8).
- **Kafka Topics** (all five):
  - `subscription_events`: open the upstream connection for a new subscription.
  - `update_events`: subscription config changed — reconnect with the new config.
  - `unsubscribe_events`: subscription removed — close the upstream connection.
  - `connection_events`: one record per upstream source message; consumed by the
    Webhook Dispatcher for delivery.
  - `dlq_events`: tombstone for deliveries that exhausted the retry ladder.
    **Write-only today — there is no DLQ consumer/redrive yet.**

### 5. **Redis**
- **Role**: Hot cache for subscription rows (`sub:*`) read on the delivery hot
  path and by the connector on reload, plus rate-limit counters. Treated as a
  cache: the dispatcher falls back to Postgres on a miss and re-warms.

### 6. **PostgreSQL**
- **Role**: System of record. Beyond subscriptions and tenants, it holds the
  delivery history (`delivery_events`), the retry queue (`pending_retries`), the
  transactional outbox (`outbox_events`), persisted notification attempts
  (`notification_attempts`), and the idempotency table (`processed_events`).

---

## System Flow

1. **Subscription creation (transactional outbox)**: A client calls `/subscribe`.
   In one PostgreSQL transaction, Subscription Management inserts the subscription
   row **and** an `outbox_events` row recording the intended `subscription_events`
   publish, then commits and warms the Redis `sub:*` cache. The Kafka publish is
   **not** done inline — this removes the "DB committed but Kafka publish lost"
   failure mode.
2. **Outbox drain**: The Webhook Dispatcher's outbox drainer claims undelivered
   `outbox_events` rows (`FOR UPDATE SKIP LOCKED`) and publishes them to Kafka,
   marking each delivered on success.
3. **Connection handling**: The Subscription Connector consumes
   `subscription_events` / `update_events` / `unsubscribe_events` and opens,
   reconnects, or closes the GraphQL/WebSocket upstream accordingly.
4. **Data handling**: Each upstream message is published to `connection_events`
   (keyed by `subscriptionId`, with a producer-generated `eventId`).
5. **Webhook dispatching**: The Webhook Dispatcher consumes `connection_events`,
   looks up the subscription (Redis → Postgres fallback), and POSTs the signed
   payload. On failure it enqueues into `pending_retries`; the retry poller
   re-fires on the backoff ladder and, after the last attempt, publishes to
   `dlq_events` and dispatches an operator notification.

## Delivery guarantee

AnyHook delivers each source event **at least once**. It does **not** provide
exactly-once or globally ordered delivery. Concretely:

- Kafka consumers use **manual offset commits**, so a crash before commit replays
  the message rather than dropping it.
- Redeliveries are **deduplicated best-effort**: the dispatcher checks for an
  existing `delivery_events` row for `(subscription_id, event_id)` before
  sending. A `processed_events` table (primary-keyed on that pair) is present in
  the schema to make this an atomic, DB-enforced gate, but the dispatcher is not
  yet wired to it — so a tight redelivery race can still double-fire.
- A **retried** event can arrive **after** a later live event for the same
  subscription. Receivers should treat `X-AnyHook-Event-Id` as the dedup/ordering
  key and tolerate reordering.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (§6 and ADR-0002) for details.

## Scaling & high availability

- **Workers scale by Kafka partition.** Topics are created with 8 partitions by
  default; the Webhook Dispatcher can run up to that many replicas, and its
  pollers (`pending_retries`, `outbox_events`, `notification_attempts`) are all
  `FOR UPDATE SKIP LOCKED` claim loops that are multi-pod safe. Migrations run as
  a one-shot `migrate` job that the app services gate on, not on every API boot.
- **The Subscription Connector must run as a single replica** until connection
  ownership is sharded by partition: each pod reloads **all** `sub:*` keys from
  Redis, so multiple connector replicas would open duplicate upstream
  connections and fan out duplicate events. `docker-compose.yml` pins it to
  `deploy.replicas: 1`.
- **Kafka durability.** The default compose stack is a single-node broker
  (`RF=1`) — fine for dev/CI, a SPOF for production. For production, run a
  3-broker quorum (`RF>=3`, `min.insync.replicas=2`) with producer
  `acks: 'all'` + `idempotent: true`; the compose file documents the prod
  topology inline.

## Observability

Each service runs an **internal** metrics/health HTTP server on `METRICS_PORT`
(default **9090**) exposing `GET /metrics` (Prometheus) and `GET /health`. This
port is **not** published by `docker-compose.yml`, so `/metrics` is reachable
only inside the Docker network — it is not part of the public API surface.
(Subscription Management additionally exposes `/health/live` liveness and
`/health` readiness on its public Express app.) Prometheus alert rules live in
[`prometheus/alerts.yml`](prometheus/alerts.yml) with a matching
[`RUNBOOK`](docs/RUNBOOK.md).

---

## Technologies Used

- **Node.js**: Primary runtime for all three backend services.
- **PostgreSQL**: System of record (subscriptions, tenants, delivery history,
  outbox, retry queue, notification attempts).
- **Redis**: Hot cache for subscription rows and rate-limit counters.
- **Kafka**: Event bus between the services.
- **GraphQL & WebSocket**: Supported upstream source connection types.
- **Axios**: Outbound webhook HTTP client in the Webhook Dispatcher.
- **Next.js / React**: Management dashboard (`dashboard/`).

---

## Fault Tolerance and Recovery

- **Transactional outbox**: Kafka publishes are written to `outbox_events` in the
  same DB transaction as the data change, so a crash between commit and publish
  cannot lose the event; the dispatcher's drainer publishes it on the next sweep.
- **Persistent, multi-pod-safe queues**: `pending_retries`, `outbox_events`, and
  `notification_attempts` survive restarts and are claimed with
  `FOR UPDATE SKIP LOCKED` + stale-lock reclaim, so a crashed worker's in-flight
  rows are picked up by the next poll cycle.
- **Automatic reconnection**: On restart the Subscription Connector reloads
  active subscriptions from Redis and re-establishes upstream connections.
- **Retry ladder + DLQ**: Failed webhook deliveries retry on a fixed backoff
  ladder (15 m, 1 h, 2 h, 6 h, 12 h, 24 h); after the last attempt the message is
  moved to the Dead Letter Queue and an operator notification is dispatched.

---
