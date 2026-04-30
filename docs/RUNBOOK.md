# AnyHook Runbook

Each section here maps to a Prometheus alert in `prometheus/alerts.yml`.
Keep entries short and operational — diagnostic command first, root-
cause-likelihood second, escalation last.

## Scope

The stack:

- `subscription-management` — Express API, port 3001 (public), 9090
  (internal /metrics + /health/live + /health).
- `subscription-connector` — Kafka consumer; opens upstream GraphQL /
  WebSocket connections; metrics on port 9090 only.
- `webhook-dispatcher` — Kafka consumer for `connection_events`;
  drains pending_retries + outbox_events + notification_attempts
  pollers; metrics on port 9090 only.
- Postgres 17, Redis 7, Kafka (Bitnami).

## anyhook-api-down

`up{job="anyhook-subscription-management"} == 0` for 2m.

1. Container alive? `docker ps | grep subscription` — restart loop
   means liveness check failing. `/health/live` returns 200 with
   no deps; if it doesn't, the Node process is wedged.
2. If liveness OK but readiness 503: `/health` returns
   `services.postgres` / `services.redis` status. Fix the actual dep
   blip; the container will NOT restart on readiness alone (commit
   d43b6bc split liveness from readiness).
3. Logs: `docker logs anyhook-subscription` — look for unhandled
   rejections, OOM, port conflict.

Escalation: page on-call after 2 restart loops.

## anyhook-api-latency-high

API p95 latency > 2s for 10m.

1. Inspect `pg_stat_activity` for slow / lock-waiting queries:
   ```sql
   SELECT pid, state, wait_event_type, wait_event, now() - query_start AS dur, query
   FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY dur DESC
   LIMIT 20;
   ```
2. Redis `SLOWLOG GET 50` — anything > 100ms?
3. Recent deploys — bisect commits since latency baseline shifted.
4. Check connection pool exhaustion: each service uses pg `max: 20`.
   `pg_stat_activity` row count per app should be <= 20 per pod.

If commit-correlated: roll back. If load-correlated: scale up.

## anyhook-api-error-rate

5xx rate > 5% for 5m.

1. `kubectl logs` / `docker logs` for stack traces.
2. Common causes:
   - Outbox enqueue failure (commit 12f1185 unified it through
     `enqueueOutbox`; if PG is degraded, the API returns 500 on the
     transaction commit).
   - Quota advisory-lock stuck (very rare; `pg_locks` will show it).
   - Auth path PG failures (membership lookup, totp_secret read).
3. Mitigation: scale up Postgres if connection pool is saturated;
   restart the API pods only if a code regression is identified.

## anyhook-dispatcher-down

`up{job="anyhook-webhook-dispatcher"} == 0` for 2m.

1. Critical path — every minute down delays:
   - DLQ + notification dispatch.
   - Outbox drain (subscription_events / update_events /
     unsubscribe_events for new API writes).
   - pending_retries drain.
2. `docker ps | grep dispatcher` — restart? Logs?
3. If multi-pod: scaling up is safe (FOR UPDATE SKIP LOCKED makes
   pollers multi-pod safe).

## anyhook-outbox-backlog

Outbox pending > 100 rows for 10m. (Requires the
`outbox_pending_total` gauge — TODO: ship in webhook-dispatcher.)

Until the gauge is exposed, query manually:
```sql
SELECT topic, count(*) FROM outbox_events
WHERE delivered_at IS NULL GROUP BY topic;
```

Likely causes:
1. Kafka broker unreachable from dispatcher → fix network / restart broker.
2. Dispatcher OOM-killed mid-publish → `locked_at` rows stay claimed
   for OUTBOX_LOCK_TIMEOUT_MS (default 60s) before another worker
   reclaims. Patient case.
3. Topic doesn't exist → `subscription-management` boot creates the
   topic; verify with `kafka-topics.sh --list`.

## anyhook-webhook-failures

Webhook delivery failure rate > 50% for 10m.

1. By-subscription breakdown:
   ```sql
   SELECT subscription_id, count(*) FILTER (WHERE status='success') AS ok,
          count(*) FILTER (WHERE status IN ('failed','dlq')) AS bad
   FROM delivery_events
   WHERE created_at > NOW() - INTERVAL '10 minutes'
   GROUP BY subscription_id
   ORDER BY bad DESC LIMIT 20;
   ```
2. If concentrated in one sub: contact the customer; the receiver is
   likely down. The retry policy will exhaust within 24h and DLQ.
3. If spread across many subs: egress / DNS issue. Confirm
   `axios.post` to a known-good external URL works from the
   dispatcher container.

## anyhook-retry-queue-growing

`webhook_pending_retries > 1000` for 15m.

1. As above — usually concentrated in 1-2 high-volume subs hitting a
   bad receiver.
2. The queue self-drains as failures DLQ (max 6 retries / 24h cycle).
3. Override: an operator can manually delete pending_retries rows
   for a specific subscription if the customer asks.

## anyhook-connector-down

`up{job="anyhook-subscription-connector"} == 0` for 2m.

1. Boot ordering: connector requires Postgres + Redis + Kafka. The
   compose `depends_on` already enforces this; on a cold start the
   connector waits.
2. After startup, the connector opens an upstream GraphQL/WebSocket
   per active subscription. If the upstream is down, individual
   handlers log and reconnect (commit d8db591), but the connector
   process itself stays up.
3. If the connector process is actually gone: redeploy. The
   reload-from-Redis path (commit e226a0c) re-establishes connections
   on startup.

## anyhook-connector-event-errors

Handler error rate > 10% for 10m.

1. Logs filtered to "Error handling subscription_events" /
   "update_events" / "unsubscribe_events".
2. Most common: a subscription whose endpoint_url has rotted. Fix or
   delete the offending subscription.
3. Less common: Redis cache mismatch (sub in DB but not in Redis) —
   commit fa475fb made the dispatcher fall back to PG; the connector
   doesn't have that fallback. `POST /redis/reload` (admin) refills
   the cache from PG.

## anyhook-event-loop-lag

`nodejs_eventloop_lag_p99_seconds > 0.5` for 5m.

1. Profile: `node --inspect` against the affected container, attach
   Chrome DevTools, take a CPU snapshot.
2. Common cause: large `JSON.stringify` on a payload that should be
   streaming (webhook bodies are capped at 10KB for storage but the
   in-flight delivery body could be larger).
3. Less common: `crypto.scrypt` blocking — only affects the API
   process during password verify; should be rare.

## Diagnostic queries

### Outbox backlog
```sql
SELECT topic, count(*) AS pending,
       MIN(created_at) AS oldest
FROM outbox_events
WHERE delivered_at IS NULL
GROUP BY topic;
```

### Active retries by subscription
```sql
SELECT subscription_id, count(*), MIN(next_attempt_at) AS soonest
FROM pending_retries
GROUP BY subscription_id
ORDER BY count DESC LIMIT 20;
```

### Notification attempts pending retry
```sql
SELECT channel, status, count(*), MIN(next_attempt_at) AS soonest
FROM notification_attempts
WHERE status IN ('pending','failed')
GROUP BY channel, status
ORDER BY count DESC;
```

### Quota usage by org
```sql
SELECT o.id, o.name,
       (SELECT count(*) FROM subscriptions s WHERE s.organization_id = o.id) AS subs,
       o.max_subscriptions, o.last_quota_warning_at
FROM organizations o
ORDER BY subs DESC LIMIT 20;
```
