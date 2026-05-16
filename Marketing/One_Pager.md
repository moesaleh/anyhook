# AnyHook

**The open-source subscription proxy for real-time events.**

---

## What it does

Point AnyHook at a GraphQL subscription or WebSocket source. Give it an HTTPS webhook URL. AnyHook handles the rest: reconnects on failure, signs every request, retries on receiver outages, dead-letters anything that exhausts retries, and shows you every byte in flight from a polished dashboard.

## Who it's for

Engineering teams routing real-time events from streaming APIs into serverless functions, internal services, observability backends, or third-party SaaS. Common adopters: crypto/DeFi platforms, AI agent products, IoT fleets, real-time collaboration apps, B2B SaaS that ship webhook-out features, and platform teams running internal event hubs.

## What's in the box

- **Subscription Management API** with OpenAPI 3.1 spec.
- **Subscription Connector** with pluggable handlers (GraphQL + WebSocket today; SSE/MQTT roadmap).
- **Webhook Dispatcher** with 6-step exponential backoff retry + DLQ.
- **Next.js Dashboard** with real-time status, delivery logs, payload inspector, and analytics.
- **Multi-tenant auth**: organizations, RBAC, invitations, API keys, TOTP 2FA.
- **Production hardening**: SSRF defense, HMAC webhook signing, envelope-encrypted secrets, rate limits, quotas.
- **Operability**: Prometheus metrics, alerting bundle, paged runbook.
- **MIT license.**

## How it scales

Three stateless Node.js microservices on a Kafka/Redis/Postgres backbone. Kafka events are keyed by subscription ID so multiple pods of each service run in parallel — one per partition. Postgres pollers use `FOR UPDATE SKIP LOCKED` for multi-pod-safe coordination. Health and liveness probes are split so a Postgres blip doesn't cascade restarts.

## Quick start

```bash
git clone https://github.com/SwanBlocks-inc/anyhook.git
cd anyhook
cp .env.example .env
docker-compose up -d
# Dashboard at http://localhost:3000
# API at http://localhost:3001
```

## Numbers

- **9 of 15** product areas shipped, 3 in partial release, 3 on the immediate roadmap.
- **252+** backend unit tests passing, **73+** frontend tests, real-Postgres integration tests for auth/subscriptions/orgs/invitations/password/quotas/two-factor.
- **17** versioned database migrations.
- **Retries**: 15 min → 1 h → 2 h → 6 h → 12 h → 24 h.
- **Payload truncation**: 10 KB stored, full size delivered.
- **Default rate limits**: 600 req / 60 s / org, 10 req / 60 s / IP for auth endpoints.
- **Default quotas**: 100 subscriptions per org, 10 API keys per org (overridable).

## The competitive frame

| | DIY | iPaaS (Zapier/n8n) | Svix/Hookdeck | AnyHook |
|---|-----|---------------------|---------------|---------|
| GraphQL / WS source | Build it | Weak | No | ✅ |
| Webhook signing + retries + DLQ | Build it | Limited | ✅ | ✅ |
| Multi-tenant + 2FA + quotas | Build it | Vendor-managed | ✅ | ✅ |
| Self-hostable, open source | n/a | No | Limited | ✅ MIT |
| Time to first delivered event | weeks | hours | days | < 1 hour |

## Status

**Active development**, MIT-licensed, production-grade, ready for pilots.

## Get involved

- **Code**: [github.com/SwanBlocks-inc/anyhook](https://github.com/SwanBlocks-inc/anyhook)
- **Issues / discussions**: same repo
- **Pilot or partnership**: contact the AnyHook team

---

*AnyHook · The webhook backbone for real-time APIs.*
