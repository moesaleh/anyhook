# AnyHook — Competitive Positioning

## Where AnyHook Sits in the Stack

AnyHook is **infrastructure plumbing**, not an application. It lives between a real-time data source and an HTTP receiver and turns one into the other. It is **not**:

- A message broker (Kafka, RabbitMQ, NATS).
- An iPaaS / workflow tool (Zapier, n8n, Make, Workato, Tray).
- A streaming database (Materialize, RisingWave, ksqlDB).
- A webhook ingress service for *receiving* webhooks (Svix, Hookdeck, Webhook.site).
- A pub/sub fabric for inter-service messaging (NATS, EventBridge, Pub/Sub).

AnyHook is a **subscription proxy** — a category that, today, is mostly unbuilt and that every real-time platform reinvents in-house.

## Category Map

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                    │
│   ┌─────────────────┐                  ┌──────────────────────┐    │
│   │ Streaming       │                  │ Webhook senders      │    │
│   │ sources         │                  │ (THIS LAYER)         │    │
│   │ ─────────────── │   AnyHook is     │ ───────────────────  │    │
│   │ • Apollo /      │ ◄──── here ────► │ • AnyHook            │    │
│   │   GraphQL ws    │                  │ • Svix (outbound)    │    │
│   │ • raw           │                  │ • Hookdeck (mostly   │    │
│   │   WebSocket     │                  │   ingress)           │    │
│   └─────────────────┘                  └──────────────────────┘    │
│                                                                    │
│   ┌─────────────────┐                  ┌──────────────────────┐    │
│   │ Streaming       │                  │ Workflow / iPaaS     │    │
│   │ infra           │                  │ ───────────────────  │    │
│   │ ─────────────── │                  │ • Zapier, n8n,       │    │
│   │ • Kafka,        │                  │   Make, Workato      │    │
│   │   Pulsar, NATS  │                  │ • EventBridge        │    │
│   └─────────────────┘                  └──────────────────────┘    │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

## Head-to-Head

### vs. Build It Yourself

| | DIY | AnyHook |
|---|-----|---------|
| Time to first delivered webhook | 2–6 weeks | < 1 hour |
| Reconnect-on-failure | Hand-rolled, easy to get wrong | Built-in, restart-safe |
| Retry policy + DLQ | Custom queue, custom scheduler | 6-step exponential backoff + persisted DLQ |
| Delivery audit trail | Logs you grep | Indexed Postgres table + dashboard UI |
| Webhook signing | Plain text or roll your own | HMAC-SHA256 with rotating secrets |
| SSRF protection | "We'll add it later" | Default-on, IPv6-aware |
| Multi-tenant | "When we have customers" | Day one |
| Operability | Pages without runbooks | Prometheus alerts + paged runbook |
| Maintenance | You own forever | Open source + community + commercial support option |

**Verdict**: DIY makes sense only if you have unusual protocol requirements and a team to maintain custom plumbing. For 95% of cases, AnyHook is the better default.

### vs. Svix / Hookdeck

Svix and Hookdeck are excellent companies. But:

- **Svix** is primarily a webhook-sender SDK for SaaS companies — it doesn't speak GraphQL subscriptions or arbitrary WebSocket on the **source** side. It assumes you already have events; AnyHook gets you the events.
- **Hookdeck** is mostly an ingress/proxy layer for receiving webhooks reliably — also stronger on the inbound side than the streaming-source side.

| | Svix | Hookdeck | AnyHook |
|---|------|----------|---------|
| Sources GraphQL subscriptions | ❌ | ❌ | ✅ |
| Sources raw WebSocket | ❌ | ❌ | ✅ |
| Sends outbound webhooks | ✅ | ✅ | ✅ |
| Retries + DLQ | ✅ | ✅ | ✅ |
| Self-hostable open source | Limited | ❌ | ✅ (MIT) |
| Multi-tenant out of box | ✅ | ✅ | ✅ |
| 2FA + invitations + quotas | ✅ | ✅ | ✅ |

AnyHook is **complementary** in some setups: AnyHook on the source side, Svix on the customer-facing webhook side. They're not in the same lane.

### vs. iPaaS (Zapier, n8n, Make, Workato)

| | iPaaS | AnyHook |
|---|-------|---------|
| Best for | No-code business workflows | Engineering-owned event routing |
| GraphQL subscriptions | Generally weak | Native |
| Long-lived WebSocket | Generally weak | Native |
| Throughput | Per-task pricing limits scale | Designed for high-volume Kafka-backed delivery |
| Self-hostable | Limited | Yes (MIT) |
| Audit-grade delivery records | Sometimes | Yes, indexed Postgres |
| Latency | Polling-oriented | Push-oriented, sub-second |

iPaaS wins when the user is a business analyst clicking through a flow builder. AnyHook wins when the user is an engineer integrating a streaming API at scale.

### vs. Kafka + Custom Consumer

| | Kafka + Custom | AnyHook |
|---|----------------|---------|
| Source: GraphQL / WebSocket | Build a custom producer | Built-in connector |
| Sink: HTTP webhook | Build a custom consumer | Built-in dispatcher |
| Multi-tenant UI | Build it | Ships with one |
| End-to-end ownership | You | We split the work; you own your AnyHook deployment, we own the code |

AnyHook **uses** Kafka under the hood. So the question isn't "AnyHook or Kafka?" — it's "AnyHook on Kafka or DIY on Kafka?"

## Differentiators

1. **Source-side specialization**. AnyHook is the only open-source project we're aware of that treats **streaming sources** as a first-class input to a webhook-out pipeline. Most competitors assume you already have events on a queue.

2. **Production-hardened security defaults**. SSRF defense, HMAC signing, envelope-encrypted secrets, backup-code peppering, rate limits per IP and per org. These don't show up in feature comparisons but they matter when you ship to enterprise.

3. **Operationally honest**. The repo ships with a Prometheus alert bundle and a paged runbook. Most "production-ready" open-source projects ship neither.

4. **Multi-tenant from day one**. Organizations, roles, invitations, quotas, per-org rate limits — these are not bolt-ons. They're in the data model from migration #4.

5. **Transactional outbox correctness**. Many systems write to Kafka and DB independently and hope they agree. AnyHook publishes via a Postgres outbox drained by the dispatcher, so a Kafka outage delays but never loses events.

6. **MIT license**. No commercial gate, no "open core minus the parts you want."

## When NOT to Choose AnyHook

- You only need to *receive* webhooks reliably — use Svix or Hookdeck on the receiver side, or a queue + worker pattern.
- You have a no-code use case better served by Zapier or n8n.
- You need to route events between sync HTTP services with complex enrichment — you want a workflow engine.
- You're building a low-volume internal tool that doesn't need durability or multi-tenancy — a 50-line script will do.

## The One-Sentence Pitch

> *"AnyHook is the open-source webhook backbone for real-time streaming APIs — drop in a GraphQL subscription or WebSocket on one side, get signed, retried, audited webhooks on the other."*

---

*See also: [Use Cases](./Use_Cases.md) for industry scenarios · [Technical Brief](./Technical_Brief.md) for architecture detail.*
