# AnyHook Meta-Driven Scalability Architecture

## Overview

AnyHook evolves from a hardcoded two-handler proxy (GraphQL + WebSocket) into a
**meta-driven integration platform** where every endpoint type is a JSON schema
document stored in the database. The platform reads those schemas at boot and at
runtime; all backend routing, delivery behaviour, and UI controls are derived from
them. No handler code changes are needed when a new endpoint type is introduced —
only a schema document is registered.

Stack constraint: Node.js 18, Express, PostgreSQL 14.4, Redis 7.0, Kafka 3.8
KRaft, Docker Compose, graphql-ws, ws, axios, prom-client. No Python, no
additional runtimes.

---

## A. Endpoint Type Schema

### A.1 Full JSON Shape

```jsonc
{
  // ── Identity ──────────────────────────────────────────────────────────────
  "type_id": "<uuid>",                         // assigned by registry on insert
  "name": "string",                            // machine-safe slug, e.g. "openai_sse"
  "display_name": "string",                    // shown in UI
  "version": "semver string",                  // e.g. "1.0.0"
  "description": "string",

  // ── Connection primitive ───────────────────────────────────────────────────
  // One of: stateless | persistent_stream | persistent_bidirectional | polling
  "connection_model": "persistent_stream",

  // ── Delivery primitive ────────────────────────────────────────────────────
  // One of: fire_and_forget | chunked_forward | batch | request_response
  "delivery_model": "chunked_forward",

  // ── Runtime connector behaviour ───────────────────────────────────────────
  "connector_config": {
    // stateless / polling
    "method": "GET",                           // HTTP verb for stateless/polling
    "content_type": "text/event-stream",       // for SSE parsing

    // polling only
    "poll_interval_seconds": 30,

    // persistent_stream  (SSE)
    "sse_event_field": "data",                 // SSE field to extract
    "sse_done_sentinel": "[DONE]",             // sentinel that closes the stream

    // persistent_bidirectional  (WebSocket / GraphQL-WS)
    "subprotocol": "graphql-ws",               // ws sub-protocol, if any
    "ping_interval_seconds": 30,
    "ping_payload": null,                      // null = use WS ping frame

    // graphql-ws specific
    "graphql_operation": "subscription",       // subscription | query | mutation
    "auto_retry_attempts": 3
  },

  // ── Subscription parameter schema (JSON Schema Draft-7) ───────────────────
  // Rendered by UI as a dynamic form; validated server-side before connection.
  "parameter_schema": {
    "type": "object",
    "required": ["endpoint_url"],
    "properties": {
      "endpoint_url": {
        "type": "string",
        "format": "uri",
        "title": "Endpoint URL",
        "description": "Full URL of the upstream source"
      },
      "headers": {
        "type": "string",
        "title": "Headers (JSON)",
        "description": "Optional HTTP headers as a JSON object string",
        "default": "{}"
      }
      // additional fields are type-specific; see examples below
    },
    "additionalProperties": false
  },

  // ── Scalability profile ───────────────────────────────────────────────────
  // Declares which UI control types are applicable to this endpoint type.
  // Each entry maps a control_type to its default configuration.
  "scalability_profile": {
    "rate_limiter": {
      "enabled": true,
      "default_events_per_second": 100,
      "burst_multiplier": 2
    },
    "capacity_limit": {
      "enabled": true,
      "default_max_concurrent": 500
    },
    "buffer_config": {
      "enabled": true,
      "default_buffer_size": 1000,
      "default_overflow_strategy": "drop_oldest"   // drop_oldest | drop_newest | backpressure
    },
    "retry_config": {
      "enabled": true,
      "default_intervals_minutes": [15, 60, 120, 360, 720, 1440],
      "default_max_retries": 6
    },
    "reconnect_config": {
      "enabled": true,
      "default_strategy": "exponential_backoff",   // fixed | exponential_backoff | none
      "default_base_delay_seconds": 5,
      "default_max_delay_seconds": 300
    },
    "timeout": {
      "enabled": true,
      "default_connect_timeout_seconds": 10,
      "default_read_timeout_seconds": 60
    },
    "batch_config": {
      "enabled": false                             // not applicable to streaming
    },
    "partition_strategy": {
      "enabled": true,
      "default_strategy": "round_robin"           // round_robin | sticky | hash_by_subscription
    }
  },

  // ── Health signals ─────────────────────────────────────────────────────────
  // Declares which prom-client metrics the connector emits for this type.
  "health_signals": {
    "events_received_total":     { "type": "counter" },
    "events_forwarded_total":    { "type": "counter" },
    "active_connections":        { "type": "gauge" },
    "connection_errors_total":   { "type": "counter" },
    "event_processing_duration": { "type": "histogram", "buckets": [0.01,0.05,0.1,0.5,1,5] }
  },

  // ── Metadata ───────────────────────────────────────────────────────────────
  "created_at": "ISO8601 timestamp",
  "updated_at": "ISO8601 timestamp",
  "is_active": true
}
```

---

### A.2 Example 1 — Webhook (outbound delivery type; connection_model = stateless)

This type describes a **stateless inbound endpoint**: the user supplies a URL that
AnyHook polls or that pushes data in; AnyHook then delivers via HTTP POST.

```json
{
  "type_id": "00000000-0000-0000-0000-000000000001",
  "name": "webhook",
  "display_name": "Webhook (HTTP POST)",
  "version": "1.0.0",
  "description": "Receives data from an upstream HTTP endpoint and forwards it to the subscriber's webhook URL",
  "connection_model": "stateless",
  "delivery_model": "fire_and_forget",
  "connector_config": {
    "method": "POST",
    "content_type": "application/json"
  },
  "parameter_schema": {
    "type": "object",
    "required": ["endpoint_url"],
    "properties": {
      "endpoint_url": {
        "type": "string",
        "format": "uri",
        "title": "Source URL"
      },
      "headers": {
        "type": "string",
        "title": "Headers (JSON)",
        "default": "{}"
      },
      "secret": {
        "type": "string",
        "title": "HMAC Secret",
        "description": "Optional secret for signature verification",
        "writeOnly": true
      }
    },
    "additionalProperties": false
  },
  "scalability_profile": {
    "rate_limiter":    { "enabled": true,  "default_events_per_second": 500 },
    "capacity_limit":  { "enabled": false },
    "buffer_config":   { "enabled": true,  "default_buffer_size": 5000 },
    "retry_config":    { "enabled": true,  "default_intervals_minutes": [15,60,120,360,720,1440], "default_max_retries": 6 },
    "reconnect_config":{ "enabled": false },
    "timeout":         { "enabled": true,  "default_connect_timeout_seconds": 5, "default_read_timeout_seconds": 30 },
    "batch_config":    { "enabled": false },
    "partition_strategy": { "enabled": true, "default_strategy": "round_robin" }
  },
  "health_signals": {
    "events_forwarded_total":  { "type": "counter" },
    "delivery_errors_total":   { "type": "counter" },
    "delivery_latency":        { "type": "histogram", "buckets": [0.05,0.1,0.25,0.5,1,2.5,5] }
  },
  "is_active": true
}
```

---

### A.3 Example 2 — OpenAI SSE Streaming (connection_model = persistent_stream)

```json
{
  "type_id": "00000000-0000-0000-0000-000000000002",
  "name": "openai_sse",
  "display_name": "OpenAI SSE Streaming",
  "version": "1.0.0",
  "description": "Streams Server-Sent Events from OpenAI-compatible completions endpoints and forwards each token/chunk to the subscriber's webhook",
  "connection_model": "persistent_stream",
  "delivery_model": "chunked_forward",
  "connector_config": {
    "method": "POST",
    "content_type": "text/event-stream",
    "sse_event_field": "data",
    "sse_done_sentinel": "[DONE]"
  },
  "parameter_schema": {
    "type": "object",
    "required": ["endpoint_url", "api_key", "model", "messages"],
    "properties": {
      "endpoint_url": {
        "type": "string",
        "format": "uri",
        "title": "API Base URL",
        "default": "https://api.openai.com/v1/chat/completions"
      },
      "api_key": {
        "type": "string",
        "title": "API Key",
        "writeOnly": true
      },
      "model": {
        "type": "string",
        "title": "Model",
        "enum": ["gpt-4o", "gpt-4-turbo", "gpt-3.5-turbo"],
        "default": "gpt-4o"
      },
      "messages": {
        "type": "string",
        "title": "Messages (JSON array)",
        "description": "Array of {role, content} objects as JSON string"
      },
      "temperature": {
        "type": "number",
        "title": "Temperature",
        "minimum": 0,
        "maximum": 2,
        "default": 0.7
      },
      "max_tokens": {
        "type": "integer",
        "title": "Max Tokens",
        "minimum": 1,
        "maximum": 128000,
        "default": 1024
      }
    },
    "additionalProperties": false
  },
  "scalability_profile": {
    "rate_limiter":    { "enabled": true,  "default_events_per_second": 50,  "burst_multiplier": 1 },
    "capacity_limit":  { "enabled": true,  "default_max_concurrent": 100 },
    "buffer_config":   { "enabled": true,  "default_buffer_size": 200, "default_overflow_strategy": "backpressure" },
    "retry_config":    { "enabled": true,  "default_intervals_minutes": [1,5,15], "default_max_retries": 3 },
    "reconnect_config":{ "enabled": false },
    "timeout":         { "enabled": true,  "default_connect_timeout_seconds": 10, "default_read_timeout_seconds": 300 },
    "batch_config":    { "enabled": false },
    "partition_strategy": { "enabled": true, "default_strategy": "sticky" }
  },
  "health_signals": {
    "stream_chunks_total":       { "type": "counter" },
    "stream_completions_total":  { "type": "counter" },
    "active_streams":            { "type": "gauge" },
    "stream_errors_total":       { "type": "counter" },
    "time_to_first_token":       { "type": "histogram", "buckets": [0.1,0.25,0.5,1,2,5] }
  },
  "is_active": true
}
```

---

### A.4 Example 3 — WebSocket (connection_model = persistent_bidirectional)

```json
{
  "type_id": "00000000-0000-0000-0000-000000000003",
  "name": "websocket",
  "display_name": "WebSocket",
  "version": "1.0.0",
  "description": "Maintains a persistent bidirectional WebSocket connection and forwards received messages",
  "connection_model": "persistent_bidirectional",
  "delivery_model": "fire_and_forget",
  "connector_config": {
    "subprotocol": null,
    "ping_interval_seconds": 30,
    "ping_payload": null,
    "auto_retry_attempts": 5
  },
  "parameter_schema": {
    "type": "object",
    "required": ["endpoint_url"],
    "properties": {
      "endpoint_url": {
        "type": "string",
        "format": "uri",
        "title": "WebSocket URL",
        "pattern": "^wss?://"
      },
      "headers": {
        "type": "string",
        "title": "Headers (JSON)",
        "default": "{}"
      },
      "subscribe_message": {
        "type": "string",
        "title": "Subscribe Message (JSON)",
        "description": "Optional message to send on open"
      },
      "event_type_filter": {
        "type": "string",
        "title": "Event Type Filter",
        "description": "Only forward messages where .event matches this value"
      }
    },
    "additionalProperties": false
  },
  "scalability_profile": {
    "rate_limiter":    { "enabled": true,  "default_events_per_second": 1000 },
    "capacity_limit":  { "enabled": true,  "default_max_concurrent": 1000 },
    "buffer_config":   { "enabled": true,  "default_buffer_size": 2000, "default_overflow_strategy": "drop_oldest" },
    "retry_config":    { "enabled": true,  "default_intervals_minutes": [15,60,120,360,720,1440], "default_max_retries": 6 },
    "reconnect_config":{ "enabled": true,  "default_strategy": "exponential_backoff", "default_base_delay_seconds": 5, "default_max_delay_seconds": 300 },
    "timeout":         { "enabled": true,  "default_connect_timeout_seconds": 10, "default_read_timeout_seconds": 0 },
    "batch_config":    { "enabled": false },
    "partition_strategy": { "enabled": true, "default_strategy": "hash_by_subscription" }
  },
  "health_signals": {
    "events_received_total":   { "type": "counter" },
    "active_connections":      { "type": "gauge" },
    "reconnect_attempts_total":{ "type": "counter" },
    "connection_errors_total": { "type": "counter" },
    "message_size_bytes":      { "type": "histogram", "buckets": [64,256,1024,4096,16384,65536] }
  },
  "is_active": true
}
```

---

## B. Database

All new tables live in the same PostgreSQL 14.4 instance. Migrations are added as
numbered SQL files under `migrations/`.

### B.1 `endpoint_types`

```sql
-- migrations/20250101000001_create_endpoint_types.sql

CREATE TABLE IF NOT EXISTS endpoint_types (
  type_id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name               VARCHAR(128)  NOT NULL UNIQUE,
  display_name       VARCHAR(256)  NOT NULL,
  version            VARCHAR(32)   NOT NULL DEFAULT '1.0.0',
  description        TEXT,

  -- Connection and delivery primitives
  connection_model   VARCHAR(64)   NOT NULL
                       CHECK (connection_model IN (
                         'stateless',
                         'persistent_stream',
                         'persistent_bidirectional',
                         'polling'
                       )),
  delivery_model     VARCHAR(64)   NOT NULL
                       CHECK (delivery_model IN (
                         'fire_and_forget',
                         'chunked_forward',
                         'batch',
                         'request_response'
                       )),

  -- Full schema documents stored as JSONB for schema-validated querying
  connector_config   JSONB         NOT NULL DEFAULT '{}',
  parameter_schema   JSONB         NOT NULL DEFAULT '{"type":"object","properties":{}}',
  scalability_profile JSONB        NOT NULL DEFAULT '{}',
  health_signals     JSONB         NOT NULL DEFAULT '{}',

  is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_endpoint_types_name        ON endpoint_types (name);
CREATE INDEX idx_endpoint_types_conn_model  ON endpoint_types (connection_model);
CREATE INDEX idx_endpoint_types_active      ON endpoint_types (is_active);

-- Trigger: keep updated_at current
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;

CREATE TRIGGER trg_endpoint_types_updated_at
  BEFORE UPDATE ON endpoint_types
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

### B.2 `subscriptions` (amended column)

The existing `connection_type VARCHAR` column is supplemented — not replaced — by a
foreign key to `endpoint_types`. A migration adds the FK:

```sql
-- migrations/20250101000002_link_subscriptions_to_endpoint_types.sql

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS type_id UUID REFERENCES endpoint_types(type_id),
  ADD COLUMN IF NOT EXISTS scalability_override JSONB DEFAULT NULL;

-- Back-fill: map legacy connection_type values to seeded type_ids
UPDATE subscriptions s
   SET type_id = e.type_id
  FROM endpoint_types e
 WHERE s.connection_type = e.name
   AND s.type_id IS NULL;

CREATE INDEX idx_subscriptions_type_id ON subscriptions (type_id);
```

### B.3 `scalability_configs`

Stores operator-level overrides per endpoint type (and optionally per subscription).
The runtime reads this table on every connection attempt.

```sql
-- migrations/20250101000003_create_scalability_configs.sql

CREATE TABLE IF NOT EXISTS scalability_configs (
  config_id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope: either type-level OR subscription-level (not both)
  type_id            UUID          REFERENCES endpoint_types(type_id) ON DELETE CASCADE,
  subscription_id    UUID          REFERENCES subscriptions(subscription_id) ON DELETE CASCADE,

  -- Must have exactly one scope
  CONSTRAINT chk_single_scope CHECK (
    (type_id IS NOT NULL AND subscription_id IS NULL) OR
    (type_id IS NULL     AND subscription_id IS NOT NULL)
  ),

  -- The control type being configured (must match keys in scalability_profile)
  control_type       VARCHAR(64)   NOT NULL
                       CHECK (control_type IN (
                         'rate_limiter',
                         'capacity_limit',
                         'buffer_config',
                         'retry_config',
                         'reconnect_config',
                         'timeout',
                         'enum_selector',
                         'partition_strategy',
                         'batch_config'
                       )),

  -- The actual configuration values (validated against scalability_profile at insert)
  config_value       JSONB         NOT NULL,

  is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_scalability_configs_type_ctrl
  ON scalability_configs (type_id, control_type)
  WHERE type_id IS NOT NULL AND is_active = TRUE;

CREATE UNIQUE INDEX idx_scalability_configs_sub_ctrl
  ON scalability_configs (subscription_id, control_type)
  WHERE subscription_id IS NOT NULL AND is_active = TRUE;

CREATE INDEX idx_scalability_configs_type_id ON scalability_configs (type_id);
CREATE INDEX idx_scalability_configs_sub_id  ON scalability_configs (subscription_id);

CREATE TRIGGER trg_scalability_configs_updated_at
  BEFORE UPDATE ON scalability_configs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

### B.4 `autoscale_rules`

Defines threshold-based autoscaling policies evaluated by the Scalability Engine.

```sql
-- migrations/20250101000004_create_autoscale_rules.sql

CREATE TABLE IF NOT EXISTS autoscale_rules (
  rule_id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  type_id            UUID          NOT NULL REFERENCES endpoint_types(type_id) ON DELETE CASCADE,
  rule_name          VARCHAR(128)  NOT NULL,
  description        TEXT,

  -- Prometheus metric name that triggers this rule (must exist in health_signals)
  metric_name        VARCHAR(128)  NOT NULL,

  -- Evaluation window
  evaluation_window_seconds INTEGER NOT NULL DEFAULT 60,

  -- Threshold condition
  condition_operator VARCHAR(8)    NOT NULL
                       CHECK (condition_operator IN ('>', '>=', '<', '<=', '==')),
  condition_threshold NUMERIC      NOT NULL,

  -- What to change when the condition is met
  -- target_control: the scalability_profile key to adjust
  -- adjustment_type: absolute | percent_increase | percent_decrease
  -- adjustment_value: the value to apply
  target_control     VARCHAR(64)   NOT NULL,
  target_field       VARCHAR(128)  NOT NULL,
  adjustment_type    VARCHAR(32)   NOT NULL
                       CHECK (adjustment_type IN ('absolute', 'percent_increase', 'percent_decrease')),
  adjustment_value   NUMERIC       NOT NULL,

  -- Safety bounds on the adjusted field
  min_value          NUMERIC,
  max_value          NUMERIC,

  -- Cooldown: minimum seconds between successive activations of this rule
  cooldown_seconds   INTEGER       NOT NULL DEFAULT 120,
  last_triggered_at  TIMESTAMPTZ,

  is_active          BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_autoscale_rules_type_id ON autoscale_rules (type_id);
CREATE INDEX idx_autoscale_rules_active  ON autoscale_rules (is_active);

CREATE TRIGGER trg_autoscale_rules_updated_at
  BEFORE UPDATE ON autoscale_rules
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
```

### B.5 `health_snapshots`

Rolling ring-buffer of aggregated health metrics, written by the Scalability Engine
on a configurable interval (default 15 s). Used to drive the UI health dashboards
without hitting Prometheus directly from the browser.

```sql
-- migrations/20250101000005_create_health_snapshots.sql

CREATE TABLE IF NOT EXISTS health_snapshots (
  snapshot_id        BIGSERIAL     PRIMARY KEY,
  type_id            UUID          REFERENCES endpoint_types(type_id) ON DELETE SET NULL,
  subscription_id    UUID          REFERENCES subscriptions(subscription_id) ON DELETE SET NULL,
  metric_name        VARCHAR(128)  NOT NULL,
  metric_value       NUMERIC       NOT NULL,
  labels             JSONB         NOT NULL DEFAULT '{}',
  captured_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_health_snapshots_type_time ON health_snapshots (type_id, captured_at DESC);
CREATE INDEX idx_health_snapshots_sub_time  ON health_snapshots (subscription_id, captured_at DESC);
CREATE INDEX idx_health_snapshots_captured  ON health_snapshots (captured_at DESC);

-- Retention: keep 24 h of data (run via pg_cron or a Node.js scheduled task)
-- DELETE FROM health_snapshots WHERE captured_at < NOW() - INTERVAL '24 hours';
```

---

## C. Backend

### C.1 Connection Model Primitives

The Subscription Connector replaces its hardcoded `connectionHandlers` object with a
**primitive dispatcher** that selects a connection-model driver based on the
`connection_model` field read from the endpoint type schema at runtime.

```
src/subscription-connector/
  drivers/
    statelessDriver.js            ← HTTP one-shot request + response forwarding
    persistentStreamDriver.js     ← SSE / chunked HTTP stream parser
    persistentBidirectionalDriver.js  ← WebSocket / graphql-ws (merges current handlers)
    pollingDriver.js              ← setInterval-based periodic fetch
  schemaRegistry.js               ← loads and caches endpoint type schemas from PostgreSQL
  connectionPrimitives.js         ← factory: (connection_model) → driver instance
  index.js                        ← updated: reads schema from registry, delegates to primitive
```

**Driver contract** (replaces BaseHandler):

Each driver module exports a class with the same interface as `BaseHandler` but
receives the full endpoint type schema in addition to the subscription record:

```
connect(subscription, endpointTypeSchema) → void
disconnect(subscriptionId) → void
raiseConnectionEvent(subscriptionId, data, deliveryHints) → void
```

`deliveryHints` is derived from `delivery_model` and passed to the Kafka message so
the Dispatcher knows how to handle delivery.

**Schema-driven routing (connectionPrimitives.js)**:

```
const DRIVER_MAP = {
  stateless:                  StatelessDriver,
  persistent_stream:          PersistentStreamDriver,
  persistent_bidirectional:   PersistentBidirectionalDriver,
  polling:                    PollingDriver,
};

function getDriver(connectionModel, producer, redisClient) {
  const DriverClass = DRIVER_MAP[connectionModel];
  if (!DriverClass) throw new Error(`Unknown connection_model: ${connectionModel}`);
  return new DriverClass(producer, redisClient);
}
```

When a `subscription_events` message arrives, the Connector:
1. Fetches subscription from Redis.
2. Reads `type_id` from subscription.
3. Calls `schemaRegistry.getSchema(type_id)` (in-memory cache, TTL 60 s, backed by
   PostgreSQL).
4. Calls `connectionPrimitives.getDriver(schema.connection_model, ...)`.
5. Calls `driver.connect(subscription, schema)`.

All four drivers read `schema.connector_config` and `schema.parameter_schema` to
know how to behave — no logic is embedded in the Connector source itself.

### C.2 Delivery Model Primitives

The Webhook Dispatcher gains a **delivery strategy layer** that inspects
`delivery_model` from the Kafka message's `deliveryHints` field.

```
src/webhook-dispatcher/
  strategies/
    fireAndForgetStrategy.js      ← current axios.post, unchanged behaviour
    chunkedForwardStrategy.js     ← streams response body to webhook via chunked transfer
    batchStrategy.js              ← accumulates events, flushes on size or time
    requestResponseStrategy.js    ← POST and await 2xx, surface response back through Kafka
  deliveryPrimitives.js           ← factory: (delivery_model) → strategy instance
  retryEngine.js                  ← extracted from index.js, reads retry_config from schema
  dlqPublisher.js                 ← extracted DLQ logic
  index.js                        ← updated: reads deliveryHints, delegates to strategy
```

**Delivery strategy contract**:

```
deliver(webhookUrl, data, scalabilityContext) → Promise<void>
```

`scalabilityContext` is a resolved object built by `scalabilityResolver.js` (see
C.4) and contains the effective rate limiter, buffer, timeout, and retry
configuration for this subscription at the moment of delivery.

### C.3 New APIs (Endpoint Types + Scalability Configs)

A new Express service — **Type Registry API** — is added to the existing
Subscription Management service on the same port 3001. Alternatively it can be
split into its own container at port 3002 in a later phase.

#### Endpoint Types CRUD

```
POST   /endpoint-types              Register a new endpoint type schema
GET    /endpoint-types              List all active endpoint types
GET    /endpoint-types/:type_id     Get a single schema (full document)
PUT    /endpoint-types/:type_id     Update a schema (bumps version)
DELETE /endpoint-types/:type_id     Soft-delete (sets is_active = false)
POST   /endpoint-types/:type_id/activate   Re-activate a soft-deleted type
```

Validation on POST/PUT:
- `connection_model` must be one of the four allowed values.
- `delivery_model` must be one of the four allowed values.
- `parameter_schema` must be valid JSON Schema Draft-7 (validated with the
  `ajv` library, already in the dependency graph via graphql tools).
- `scalability_profile` keys must be valid control type names.

After a successful write, the API publishes a `schema_updated` message to a new
Kafka topic `type_registry_events` so all Connector and Dispatcher instances can
invalidate their in-memory schema cache.

#### Scalability Configs CRUD

```
POST   /scalability-configs                 Create a config override
GET    /scalability-configs?type_id=...     List configs for a type
GET    /scalability-configs?subscription_id=...  List configs for a subscription
GET    /scalability-configs/:config_id      Get a single config
PUT    /scalability-configs/:config_id      Update a config value
DELETE /scalability-configs/:config_id      Soft-delete

POST   /autoscale-rules                     Create an autoscale rule
GET    /autoscale-rules?type_id=...         List rules for a type
PUT    /autoscale-rules/:rule_id            Update a rule
DELETE /autoscale-rules/:rule_id            Soft-delete
```

#### Health API

```
GET  /health/snapshots?type_id=...&since=ISO8601    Time-series snapshots
GET  /health/snapshots?subscription_id=...&since=...
GET  /health/metrics                                 Live prom-client metrics text (scrape endpoint)
```

### C.4 Scalability Runtime Resolution

At connection time, the Connector builds a **resolved scalability context** by
merging configs in priority order (highest wins):

```
subscription.scalability_override         (inline, highest priority)
  ↓ merge with
scalability_configs WHERE subscription_id = $sub_id
  ↓ merge with
scalability_configs WHERE type_id = $type_id
  ↓ merge with
endpoint_types.scalability_profile defaults
```

This merge is performed by `src/shared/scalabilityResolver.js`, a pure function
usable by both the Connector and Dispatcher without circular dependencies.

**Rate limiter enforcement (in-process)**:

The resolved `rate_limiter` config is used to construct a token-bucket per
`subscriptionId` stored in a `Map` inside the driver process. The token bucket
refills at `events_per_second` tokens/s with a max of
`events_per_second × burst_multiplier`. Events that arrive when the bucket is
empty are buffered (up to `buffer_config.buffer_size`); if the buffer is full the
`overflow_strategy` applies.

For cross-process enforcement (when multiple Connector replicas run), the token
bucket state is stored in Redis as a sorted set with TTL, using the same pattern as
`INCR`-based rate limiting.

**Capacity limit enforcement**:

Active connection counts per type_id are tracked in Redis:
- `INCR anyhook:capacity:{type_id}` on connect.
- `DECR anyhook:capacity:{type_id}` on disconnect.
- New connections are rejected with a `429` response / logged warning when the
  gauge reaches `max_concurrent`.

---

## D. UI

### D.1 Tech Stack

React 18 (CRA or Vite), using only packages already present in `package.json` plus
the React ecosystem. No Python, no additional backend language.

```
src/ui/
  package.json            ← React 18, react-router-dom, recharts, ajv
  public/
    index.html
  src/
    index.jsx
    App.jsx               ← router root
    api/
      client.js           ← thin axios wrapper, base URL from VITE_API_URL env
      endpointTypes.js    ← CRUD calls for /endpoint-types
      subscriptions.js    ← CRUD calls for /subscribe etc.
      scalability.js      ← CRUD calls for /scalability-configs, /autoscale-rules
      health.js           ← GET /health/snapshots
    components/
      layout/
        Sidebar.jsx
        TopBar.jsx
        Layout.jsx
      forms/
        DynamicForm.jsx       ← renders any JSON Schema parameter_schema as inputs
        ControlRenderer.jsx   ← renders a scalability_profile control block
        ScalabilityForm.jsx   ← wraps ControlRenderer for the full profile
      charts/
        TimeSeriesChart.jsx   ← recharts LineChart, generic
        GaugeChart.jsx        ← recharts RadialBarChart for gauges
      tables/
        DataTable.jsx         ← generic sortable/filterable table
      shared/
        Badge.jsx
        StatusDot.jsx
        JsonEditor.jsx        ← textarea + JSON parse error display
    pages/
      Subscriptions/
        index.jsx             ← list + create + manage subscriptions
        SubscriptionRow.jsx
        CreateSubscriptionModal.jsx  ← DynamicForm for selected endpoint type
      EndpointTypes/
        index.jsx             ← list + register + edit endpoint types
        EndpointTypeCard.jsx
        RegisterTypeModal.jsx ← JsonEditor + validation
        ParameterSchemaEditor.jsx
        ScalabilityProfileEditor.jsx
      ScalabilityControlPlane/
        index.jsx             ← global scalability dashboard
        TypeConfigPanel.jsx   ← per-type override controls
        SubscriptionOverridePanel.jsx
        AutoscaleRulesPanel.jsx
        AutoscaleRuleRow.jsx
      Health/
        index.jsx             ← health dashboard
        TypeHealthCard.jsx    ← metric gauges + sparklines per type
        SubscriptionHealthRow.jsx
        MetricSparkline.jsx
    hooks/
      useEndpointTypes.js     ← SWR-style polling of /endpoint-types
      useScalability.js
      useHealth.js            ← polls /health/snapshots every 15 s
    constants/
      controlTypes.js         ← UI labels/descriptions for each control_type
      connectionModels.js
      deliveryModels.js
```

### D.2 Pages

#### Subscriptions Page (`/subscriptions`)

- Table of all active subscriptions: id, display_name of type, status, created_at,
  webhook_url.
- "New Subscription" button opens `CreateSubscriptionModal`.
- `CreateSubscriptionModal`:
  1. Step 1: `enum_selector` — dropdown of active endpoint types (loaded from
     `/endpoint-types`).
  2. Step 2: `DynamicForm` — rendered from the selected type's `parameter_schema`.
     Each property in the JSON Schema becomes an input field with type, title,
     description, and validation.
  3. Step 3: webhook URL + optional inline scalability override fields.
- Table row actions: View, Edit, Delete.

#### Endpoint Types Page (`/endpoint-types`)

- Grid of `EndpointTypeCard` components: name, display_name, connection_model badge,
  delivery_model badge, active subscription count.
- "Register Type" button opens `RegisterTypeModal`:
  - `JsonEditor` for the full schema, or step-by-step form with:
    - `ParameterSchemaEditor`: add/remove properties with type, title, format,
      required toggle.
    - `ScalabilityProfileEditor`: for each known control_type, a toggle and default
      value inputs.
- Click a card to open detail view: full schema JSON, scalability profile, health
  signals, linked subscriptions.

#### Scalability Control Plane (`/scalability`)

- Left panel: list of endpoint types.
- Right panel when a type is selected:
  - `TypeConfigPanel`: for each control_type enabled in the type's
    `scalability_profile`, render a `ControlRenderer` with current override values
    (from `/scalability-configs?type_id=...`). Save button calls PUT.
  - `AutoscaleRulesPanel`: table of rules for this type. Add/edit/delete buttons.
  - `SubscriptionOverridePanel`: table of per-subscription overrides. Search by
    subscription_id. Inline edit.

#### Health Page (`/health`)

- Summary row: total active connections (gauge), events/s (sparkline), error rate.
- Per-type `TypeHealthCard`: pulls from `/health/snapshots?type_id=...&since=...`.
  Charts: active connections (gauge), events received/s (sparkline), error rate %
  (sparkline), p95 processing latency (single stat).
- "Drill into subscription" link navigates to per-subscription health.

### D.3 DynamicForm Component Logic

`DynamicForm.jsx` receives a JSON Schema `parameter_schema` document and renders
inputs:

```
schema.type === "object"  → render each property as a field
schema.properties[key]    → determine input type:
  "string" + "format":"uri"   → <input type="url">
  "string" + "writeOnly":true → <input type="password">
  "string" + "enum":[...]     → <select>
  "string"                    → <input type="text"> or <textarea> if long
  "number" / "integer"        → <input type="number" min max step>
  "boolean"                   → <input type="checkbox">
schema.required             → mark fields as required, add HTML5 required attr
schema.properties[key].default → populate defaultValue
```

Validation is performed client-side using `ajv` before submission, surfacing field-
level errors inline.

### D.4 ControlRenderer Component Logic

`ControlRenderer.jsx` receives a single `control_type` string and a `config_value`
object and renders the appropriate controls:

```
rate_limiter      → NumberInput(events_per_second) + NumberInput(burst_multiplier)
capacity_limit    → NumberInput(max_concurrent)
buffer_config     → NumberInput(buffer_size) + Select(overflow_strategy)
retry_config      → TagInput(intervals_minutes) + NumberInput(max_retries)
reconnect_config  → Select(strategy) + NumberInput(base_delay) + NumberInput(max_delay)
timeout           → NumberInput(connect_timeout) + NumberInput(read_timeout)
batch_config      → NumberInput(batch_size) + NumberInput(flush_interval_seconds)
partition_strategy→ Select(strategy)
enum_selector     → Select(options defined in schema)
```

---

## E. Scalability Control Plane

### E.1 Storage

Resolved scalability contexts are stored in Redis for sub-millisecond access by
every driver instance, avoiding a PostgreSQL round-trip per connection event.

**Redis key layout**:

```
anyhook:schema:{type_id}                    → JSON string of full endpoint type schema
anyhook:scalability:{type_id}               → JSON string of resolved type-level config
anyhook:scalability:{type_id}:{sub_id}      → JSON string of resolved subscription-level config
anyhook:capacity:{type_id}                  → integer, current active connection count
anyhook:ratelimit:{sub_id}                  → token bucket state (HASH: tokens, last_refill)
anyhook:buffer:{sub_id}                     → List (LPUSH/RPOP), overflow events
```

When `scalability_configs` or `autoscale_rules` are updated via the API, the API
handler publishes a `scalability_invalidated` message to the
`type_registry_events` Kafka topic. All Connector and Dispatcher instances listen
to this topic and call `schemaRegistry.invalidate(type_id)` + Redis DEL.

### E.2 Runtime Application

**In Connector (per connection event)**:

```
1. scalabilityResolver.resolve(subscriptionId, typeId)
   → merges DB configs into a single flat context object
   → result cached in Redis for 30 s

2. capacityGuard.check(typeId, context.capacity_limit)
   → INCR Redis counter; reject if > max_concurrent

3. rateLimiter.acquire(subscriptionId, context.rate_limiter)
   → token-bucket in Redis; block or drop if dry

4. driver.connect(subscription, schema, context)
   → driver reads context.timeout, context.reconnect_config

5. On each incoming event:
   bufferManager.enqueue(subscriptionId, event, context.buffer_config)
   → if buffer not full: raiseConnectionEvent immediately
   → if buffer full: apply overflow_strategy
```

**In Dispatcher (per delivery attempt)**:

```
1. scalabilityResolver.resolve(subscriptionId, typeId)

2. retryEngine.attempt(webhookUrl, data, context.retry_config)
   → uses context.retry_config.intervals_minutes and max_retries

3. deliveryStrategy.deliver(webhookUrl, data, context)
   → applies context.timeout on the axios call
```

### E.3 Per-Type and Per-Subscription Overrides

**Precedence chain** (already stated in C.4 but elaborated here):

| Level | Source | Who can set it |
|-------|--------|----------------|
| 1 (lowest) | `endpoint_types.scalability_profile` defaults | Type author at registration |
| 2 | `scalability_configs WHERE type_id = $t` | Operator via Scalability Control Plane |
| 3 | `scalability_configs WHERE subscription_id = $s` | Operator per-subscription override |
| 4 (highest) | `subscriptions.scalability_override` (inline JSON) | Subscriber at creation time |

The resolver performs a deep merge at each level, field by field, so an operator
can override only `rate_limiter.events_per_second` without affecting
`rate_limiter.burst_multiplier`.

### E.4 Health Signal Pipeline

```
┌─────────────────────────────────────────────────────────┐
│  Connection Model Drivers                               │
│  Each driver calls:                                      │
│    metrics.eventsReceivedTotal.inc({ type_id, sub_id }) │
│    metrics.activeConnections.set(...)                    │
│    metrics.processingDuration.observe(...)              │
└────────────────────┬────────────────────────────────────┘
                     │ prom-client in-process registry
                     ▼
┌─────────────────────────────────────────────────────────┐
│  src/shared/metricsRegistry.js                          │
│  Initialises all counters/gauges/histograms declared    │
│  in endpoint_types.health_signals for all active types  │
│  Exposes GET /health/metrics (Prometheus text format)   │
└────────────────────┬────────────────────────────────────┘
                     │ every 15 s (setInterval)
                     ▼
┌─────────────────────────────────────────────────────────┐
│  src/shared/healthSnapshotWriter.js                     │
│  Queries prom-client registry.getMetricsAsJSON()        │
│  Writes rows to health_snapshots table                  │
│  Prunes rows older than 24 h                            │
└────────────────────┬────────────────────────────────────┘
                     │ GET /health/snapshots?type_id=...
                     ▼
┌─────────────────────────────────────────────────────────┐
│  React UI Health Page                                   │
│  Polls every 15 s                                       │
│  Renders TimeSeriesChart + GaugeChart from snapshots    │
└─────────────────────────────────────────────────────────┘
```

**Autoscale Engine** (`src/shared/autoscaleEngine.js`):

Runs as a `setInterval` every 60 s inside the Subscription Management service.

```
For each active autoscale_rule:
  1. Query health_snapshots for metric_name over evaluation_window_seconds
  2. Compute aggregate (avg/max/rate depending on metric type)
  3. Evaluate condition_operator + condition_threshold
  4. If condition met AND (NOW - last_triggered_at) > cooldown_seconds:
     a. Read current scalability_configs for type_id + control_type
     b. Apply adjustment (absolute set, or +/- percent)
     c. Clamp to [min_value, max_value]
     d. UPSERT into scalability_configs
     e. UPDATE autoscale_rules SET last_triggered_at = NOW()
     f. Publish scalability_invalidated to type_registry_events
```

---

## F. File Structure

Full paths for all new and modified files, relative to the repository root.

```
anyhook/
│
├── migrations/
│   ├── 20240930142437_create_subscriptions_table.sql          (existing)
│   ├── 20250101000001_create_endpoint_types.sql               (new — §B.1)
│   ├── 20250101000002_link_subscriptions_to_endpoint_types.sql (new — §B.2)
│   ├── 20250101000003_create_scalability_configs.sql          (new — §B.3)
│   ├── 20250101000004_create_autoscale_rules.sql              (new — §B.4)
│   └── 20250101000005_create_health_snapshots.sql             (new — §B.5)
│
├── seeds/
│   └── 001_seed_builtin_endpoint_types.sql                    (new — seeds webhook, openai_sse, websocket from §A)
│
├── src/
│   │
│   ├── shared/                                                 (new package — shared across all services)
│   │   ├── db.js                                              (shared pg Pool factory)
│   │   ├── redis.js                                           (shared Redis client factory)
│   │   ├── kafka.js                                           (shared Kafka client factory)
│   │   ├── logger.js                                          (shared Winston logger)
│   │   ├── schemaRegistry.js                                  (loads endpoint_types from PG, in-memory TTL cache)
│   │   ├── scalabilityResolver.js                             (priority-merge logic — §C.4, §E.3)
│   │   ├── metricsRegistry.js                                 (prom-client setup, dynamic metric init from health_signals)
│   │   ├── healthSnapshotWriter.js                            (periodic prom → health_snapshots — §E.4)
│   │   ├── autoscaleEngine.js                                 (autoscale rule evaluation — §E.4)
│   │   ├── capacityGuard.js                                   (Redis INCR/DECR capacity tracking)
│   │   ├── rateLimiter.js                                     (Redis token-bucket per subscription)
│   │   └── bufferManager.js                                   (per-subscription event buffer + overflow)
│   │
│   ├── subscription-management/
│   │   ├── index.js                                           (existing — add type registry routes + health API)
│   │   └── routes/
│   │       ├── subscriptions.js                               (extracted from index.js — existing CRUD)
│   │       ├── endpointTypes.js                               (new — §C.3 endpoint-types CRUD)
│   │       ├── scalabilityConfigs.js                          (new — §C.3 scalability-configs CRUD)
│   │       ├── autoscaleRules.js                              (new — §C.3 autoscale-rules CRUD)
│   │       └── health.js                                      (new — §C.3 health snapshots API)
│   │
│   ├── subscription-connector/
│   │   ├── index.js                                           (updated — schema-driven routing §C.1)
│   │   ├── connectionPrimitives.js                            (new — driver factory §C.1)
│   │   ├── drivers/
│   │   │   ├── statelessDriver.js                             (new — §C.1)
│   │   │   ├── persistentStreamDriver.js                      (new — §C.1, handles SSE)
│   │   │   ├── persistentBidirectionalDriver.js               (new — §C.1, merges graphqlHandler + webSocketHandler)
│   │   │   └── pollingDriver.js                               (new — §C.1)
│   │   └── handlers/                                          (kept for reference during migration)
│   │       ├── baseHandler.js                                 (existing — to be superseded)
│   │       ├── graphqlHandler.js                              (existing — to be superseded)
│   │       └── webSocketHandler.js                            (existing — to be superseded)
│   │
│   ├── webhook-dispatcher/
│   │   ├── index.js                                           (updated — delivery-model routing §C.2)
│   │   ├── deliveryPrimitives.js                              (new — strategy factory §C.2)
│   │   ├── retryEngine.js                                     (new — extracted + schema-driven §C.2)
│   │   ├── dlqPublisher.js                                    (new — extracted §C.2)
│   │   └── strategies/
│   │       ├── fireAndForgetStrategy.js                       (new — §C.2)
│   │       ├── chunkedForwardStrategy.js                      (new — §C.2)
│   │       ├── batchStrategy.js                               (new — §C.2)
│   │       └── requestResponseStrategy.js                     (new — §C.2)
│   │
│   └── ui/                                                    (new React application — §D)
│       ├── package.json
│       ├── vite.config.js
│       ├── index.html
│       └── src/
│           ├── index.jsx
│           ├── App.jsx
│           ├── api/
│           │   ├── client.js
│           │   ├── endpointTypes.js
│           │   ├── subscriptions.js
│           │   ├── scalability.js
│           │   └── health.js
│           ├── components/
│           │   ├── layout/
│           │   │   ├── Sidebar.jsx
│           │   │   ├── TopBar.jsx
│           │   │   └── Layout.jsx
│           │   ├── forms/
│           │   │   ├── DynamicForm.jsx
│           │   │   ├── ControlRenderer.jsx
│           │   │   └── ScalabilityForm.jsx
│           │   ├── charts/
│           │   │   ├── TimeSeriesChart.jsx
│           │   │   └── GaugeChart.jsx
│           │   ├── tables/
│           │   │   └── DataTable.jsx
│           │   └── shared/
│           │       ├── Badge.jsx
│           │       ├── StatusDot.jsx
│           │       └── JsonEditor.jsx
│           ├── pages/
│           │   ├── Subscriptions/
│           │   │   ├── index.jsx
│           │   │   ├── SubscriptionRow.jsx
│           │   │   └── CreateSubscriptionModal.jsx
│           │   ├── EndpointTypes/
│           │   │   ├── index.jsx
│           │   │   ├── EndpointTypeCard.jsx
│           │   │   ├── RegisterTypeModal.jsx
│           │   │   ├── ParameterSchemaEditor.jsx
│           │   │   └── ScalabilityProfileEditor.jsx
│           │   ├── ScalabilityControlPlane/
│           │   │   ├── index.jsx
│           │   │   ├── TypeConfigPanel.jsx
│           │   │   ├── SubscriptionOverridePanel.jsx
│           │   │   ├── AutoscaleRulesPanel.jsx
│           │   │   └── AutoscaleRuleRow.jsx
│           │   └── Health/
│           │       ├── index.jsx
│           │       ├── TypeHealthCard.jsx
│           │       ├── SubscriptionHealthRow.jsx
│           │       └── MetricSparkline.jsx
│           ├── hooks/
│           │   ├── useEndpointTypes.js
│           │   ├── useScalability.js
│           │   └── useHealth.js
│           └── constants/
│               ├── controlTypes.js
│               ├── connectionModels.js
│               └── deliveryModels.js
│
├── docker-compose.yml                                         (updated — add ui service, type-registry port)
└── .env.example                                               (updated — add VITE_API_URL, METRICS_INTERVAL_SECONDS)
```

### Docker Compose additions

```
services:
  anyhook-ui:
    build:
      context: ./src/ui
      dockerfile: Dockerfile
    container_name: anyhook-ui
    ports:
      - "3000:3000"
    environment:
      VITE_API_URL: http://anyhook-subscription:3001
    depends_on:
      - anyhook-subscription
    networks:
      - anyhook
```

---

## G. Phases

### Phase 1 — Type Registry + API

**Goal**: Endpoint type schemas can be stored, retrieved, and validated via API.
The existing system continues to operate unchanged.

**Deliverables**:

1. Run migrations 000001–000002. Seed the three built-in types (webhook,
   openai_sse, websocket).
2. Create `src/shared/db.js`, `src/shared/redis.js`, `src/shared/kafka.js`,
   `src/shared/logger.js` by extracting the existing boilerplate from each service's
   `index.js`.
3. Create `src/shared/schemaRegistry.js`: PostgreSQL-backed, in-memory LRU cache
   (TTL 60 s), listens to `type_registry_events` Kafka topic for invalidations.
4. Add `src/subscription-management/routes/endpointTypes.js` with full CRUD.
5. Add `src/subscription-management/routes/scalabilityConfigs.js` with full CRUD.
6. Wire new routes into `subscription-management/index.js`.
7. Create `seeds/001_seed_builtin_endpoint_types.sql`.
8. Update `.env.example` with any new variables.

**Validation**: `POST /endpoint-types` with the three example schemas from §A
returns 201. `GET /endpoint-types` lists them. `DELETE /endpoint-types/:id` soft-
deletes. Existing `/subscribe` and `/subscriptions` endpoints are unaffected.

---

### Phase 2 — Schema-Driven Connector

**Goal**: The Subscription Connector routes all new subscriptions through the
connection-model primitive layer. Legacy handler files are kept but no longer
called for new subscriptions.

**Deliverables**:

1. Create the four driver files under `src/subscription-connector/drivers/`.
   - `persistentBidirectionalDriver.js` merges the logic of `graphqlHandler.js`
     and `webSocketHandler.js`, selecting behaviour by reading
     `schema.connector_config.subprotocol`.
   - `persistentStreamDriver.js` implements SSE via Node.js `http.request` with
     `Transfer-Encoding: chunked` parsing; uses `schema.connector_config.sse_event_field`
     and `sse_done_sentinel`.
   - `statelessDriver.js` performs a single axios request and raises one connection
     event.
   - `pollingDriver.js` wraps `statelessDriver` in a `setInterval` using
     `schema.connector_config.poll_interval_seconds`.
2. Create `src/subscription-connector/connectionPrimitives.js` factory.
3. Update `src/subscription-connector/index.js` to call `schemaRegistry.getSchema`
   then `connectionPrimitives.getDriver` on each `subscription_events` message.
4. Fix the `webSocketHandler.js` shared `wsClient` bug (now moot for new
   subscriptions, but fix it in the legacy path to prevent crashes during the
   migration window): `this.wsClients` should be a `Map` keyed by `subscription_id`
   (same pattern as `graphqlHandler.js`).
5. Add `scalabilityResolver.resolve` call at connect time; pass the context to the
   driver.
6. Add `capacityGuard.js` + `rateLimiter.js` + `bufferManager.js`; wire into the
   connect path.
7. Run migration 000003 (scalability_configs).

**Validation**: Create a subscription with `connection_type: "openai_sse"` (the new
type from Phase 1). Confirm the Connector routes to `persistentStreamDriver`. Create
a `websocket` subscription; confirm it routes to `persistentBidirectionalDriver`.
Confirm legacy `graphql` subscriptions still work via the driver (not the old
handler).

---

### Phase 3 — Schema-Driven Dispatcher

**Goal**: The Webhook Dispatcher uses delivery-model strategies and reads retry/
timeout config from the resolved scalability context.

**Deliverables**:

1. Create `src/webhook-dispatcher/strategies/` with all four strategy files.
2. Create `src/webhook-dispatcher/deliveryPrimitives.js` factory.
3. Extract `retryEngine.js` and `dlqPublisher.js` from `webhook-dispatcher/index.js`.
4. Update `webhook-dispatcher/index.js`:
   - Read `deliveryHints.delivery_model` from the Kafka message.
   - Call `scalabilityResolver.resolve` to get retry/timeout config.
   - Delegate to the appropriate strategy.
5. Add `deliveryHints` to the `raiseConnectionEvent` payload in the driver base
   class (carries `delivery_model` and `type_id`).
6. Run migration 000004 (autoscale_rules).

**Validation**: Create a subscription with `delivery_model: "batch"`. Confirm
events accumulate in the buffer and are flushed as a batch to the webhook. Set a
`retry_config` override via `POST /scalability-configs`; confirm the dispatcher
uses the override intervals.

---

### Phase 4 — React UI

**Goal**: Operators can manage subscriptions, endpoint types, and scalability
configs through a browser interface.

**Deliverables**:

1. Bootstrap `src/ui/` with Vite + React 18.
2. Implement all pages, components, hooks, and API clients per §D.
3. Add `anyhook-ui` service to `docker-compose.yml`.
4. Add static file serving for the built UI through a dedicated Vite dev server
   in development and nginx in production (add `src/ui/Dockerfile` using
   `node:18-alpine` for build + `nginx:alpine` for serve).
5. Implement `DynamicForm.jsx` with `ajv` validation.
6. Implement `ControlRenderer.jsx` for all nine control types.
7. Wire the "Register Type" modal to `POST /endpoint-types`.
8. Wire "New Subscription" modal to show dynamic form from selected type's
   `parameter_schema`.

**Validation**: Open browser, navigate all four pages. Register a new endpoint type
via UI. Create a subscription using the dynamic form. Verify form validation rejects
invalid input. Edit a scalability config; confirm the change propagates to the Redis
key within 30 s.

---

### Phase 5 — Scalability + Health

**Goal**: Health metrics flow from prom-client through PostgreSQL to the UI; the
autoscale engine adjusts configs automatically based on rules.

**Deliverables**:

1. Implement `src/shared/metricsRegistry.js`:
   - On startup, queries `endpoint_types` for all `health_signals` documents.
   - Registers prom-client metrics dynamically (counter, gauge, histogram).
   - Drivers call `metricsRegistry.get(metric_name, labels).inc/set/observe(...)`.
2. Add `GET /health/metrics` endpoint (Prometheus scrape target).
3. Implement `src/shared/healthSnapshotWriter.js`:
   - `setInterval(writeSnapshot, METRICS_INTERVAL_SECONDS * 1000)`.
   - Reads prom-client registry, writes rows to `health_snapshots`.
   - Prunes rows older than 24 h.
4. Add `GET /health/snapshots` endpoint.
5. Implement `src/shared/autoscaleEngine.js` and start it in the Subscription
   Management service.
6. Run migration 000005 (health_snapshots).
7. Implement `src/ui/pages/Health/` components.
8. Wire the `useHealth` hook to poll `/health/snapshots` every 15 s and feed
   `TimeSeriesChart` + `GaugeChart`.
9. Implement the `AutoscaleRulesPanel` in the Scalability Control Plane page.

**Validation**: Run a stress test against a `websocket` subscription (existing
`src/test/kafka/stress-test-producer.js`). Observe active connections gauge rising
in the Health UI. Create an autoscale rule that reduces `rate_limiter.events_per_second`
when `events_received_total` rate exceeds 800/s. Confirm the rule fires, the
scalability config is updated, and the connector enforces the new limit within one
cooldown period.

---

## Security Considerations

1. **Schema validation on registration**: All JSON Schema documents submitted to
   `POST /endpoint-types` are parsed and validated with `ajv` before persistence.
   Malformed schemas are rejected with 400.
2. **Parameter validation at subscribe time**: Subscription args are validated
   against the type's `parameter_schema` using `ajv` before any connection is
   attempted. Invalid args return 400 without touching the database.
3. **writeOnly fields**: Fields marked `"writeOnly": true` (e.g., API keys, secrets)
   are stored encrypted at rest using AES-256-GCM with the encryption key from an
   environment variable (`ANYHOOK_SECRET_KEY`). They are never returned in GET
   responses or exposed to the UI.
4. **Capacity limits as DoS protection**: The `capacity_limit` control prevents a
   single endpoint type from exhausting all Connector worker memory by capping
   concurrent connections at a configurable ceiling.
5. **Rate limiter as upstream protection**: The `rate_limiter` control prevents a
   noisy subscription from flooding Kafka `connection_events` and cascading into
   the Dispatcher.
6. **Autoscale rule bounds**: `min_value` and `max_value` in `autoscale_rules`
   prevent an autoscale loop from driving a config to zero or infinity.
7. **Input sanitisation**: All endpoint URLs are validated as RFC 3986 URIs before
   storage. WebSocket URLs are further validated against `^wss?://` via the
   `parameter_schema` pattern field; SSE URLs against `^https?://`.
8. **Kafka topic access**: The `type_registry_events` topic is internal. Its
   producer and consumer are both within the Docker Compose network `anyhook` and
   not exposed externally.
9. **Health endpoint access control**: `GET /health/metrics` (Prometheus format)
   should be protected with a static bearer token (`METRICS_AUTH_TOKEN` env var) in
   production to prevent metric leakage.

---

## Summary of Design Decisions

| Decision | Rationale |
|----------|-----------|
| Schemas stored as JSONB in PostgreSQL | Enables structured querying (`@>`, `->`) and transactional updates without a separate schema store |
| In-memory + Redis caching of resolved configs | Avoids a DB round-trip per event at high throughput while remaining consistent across replicas |
| `type_registry_events` Kafka topic for cache invalidation | Reuses the existing Kafka infrastructure; all services already consume from Kafka |
| Primitives as strategy classes (not plugins) | Keeps the driver surface area small and testable; new connection models require only a new driver file |
| `parameter_schema` as JSON Schema Draft-7 | Industry standard, directly renderable by `ajv` for validation and by `DynamicForm` for UI |
| prom-client metrics written to PostgreSQL | Avoids requiring a Prometheus server in the stack; the UI queries PostgreSQL directly |
| React UI served as a separate Docker service | Decouples frontend from backend deployment; the backend API is the single source of truth |
| Phase-by-phase delivery | Each phase produces a working, deployable system; no big-bang cutover |
