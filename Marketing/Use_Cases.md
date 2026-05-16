# AnyHook — Use Cases

AnyHook earns its keep wherever a team needs to **route real-time events** from a streaming source (GraphQL / WebSocket) into a system that speaks HTTP. Below are the patterns we see most often.

---

## 1. Crypto & DeFi Trading Signals

**The team**: A quant trading firm or DeFi platform monitoring on-chain activity, mempool transactions, DEX trades, and oracle updates.

**The pain**: Sources like Bitquery, The Graph, Alchemy, and Helius expose GraphQL subscriptions and WebSocket streams. The trading engine, risk system, and audit log all want every event — but they're stateless HTTP services. Engineers have spent months building bespoke reconnect logic, only to discover dropped events when the WebSocket reconnects mid-flight.

**The fix**: Point AnyHook at the Bitquery / The Graph endpoint, give it the trading-engine webhook URL, and forget about it. Reconnects happen automatically. Failed deliveries retry on exponential backoff. The audit log is queryable in Postgres. The dashboard shows every event delivered or dropped.

**Why it matters**: Latency-sensitive workflows can't tolerate silent drops. AnyHook gives a quant team an audit trail of every signal, queryable by status code and retry count, so risk and compliance reviews stop being scavenger hunts.

---

## 2. AI Agent Event Routing

**The team**: An AI/agentic platform with long-running streaming model outputs (token streams, tool-call events, status updates) that need to fan out to user-facing webhooks.

**The pain**: Modern LLM APIs stream tokens over server-sent events or WebSockets. Customers of the AI platform run on serverless infrastructure (Vercel, Cloudflare, AWS Lambda) where long-lived connections are awkward, expensive, or impossible. Building a per-customer reconnect-and-retry layer is a tax on every product team.

**The fix**: The AI platform exposes a streaming endpoint, AnyHook subscribes to it on the customer's behalf, and forwards each token / tool-event / completion-status to the customer's webhook with HMAC signatures. The customer never sees a WebSocket; they get a clean POST per event.

**Why it matters**: AnyHook gives AI product teams a turn-key integration story for serverless customers — "here's your webhook URL, here's your signing secret, you're done."

---

## 3. IoT Fleet Telemetry

**The team**: A connected-device platform routing telemetry (temperature, GPS, battery, error events) from millions of devices to downstream analytics and alerting.

**The pain**: Devices push to a WebSocket aggregator. Analytics, billing, and ops want every event — but their stacks (Snowflake, Datadog, PagerDuty, Slack) all consume webhooks. The team has built three different bespoke forwarders and is on call for each one.

**The fix**: Three AnyHook subscriptions: one per consumer. Each one filters on the events it cares about (`event_type` on the WebSocket subscription) and pushes signed webhooks to the target system. Failures retry, and the DLQ collects anything that exhausts retries for later replay.

**Why it matters**: Adding a fourth consumer (say, a new ML training pipeline) takes 60 seconds — create a subscription in the wizard, paste the webhook URL, done.

---

## 4. Real-Time Collaborative Apps

**The team**: A collaborative-editing or live-presence product (think Figma, Notion, Linear competitors) that needs to fire side effects on document events — analytics, audit logs, anti-abuse, search indexing.

**The pain**: The product is built on a real-time backend (GraphQL subscriptions or a custom WebSocket protocol). The growth analytics team wants every "doc.edited" event. The compliance team wants every "role.changed" event. The data team wants events in S3 for batch analytics. Building three more consumers on top of the live-collab backend is invasive and risky.

**The fix**: AnyHook subscribes to the GraphQL subscription once. Each downstream consumer gets a subscription with its own filter, retries, and audit trail. The live-collab backend doesn't even know.

**Why it matters**: AnyHook becomes the **safe extension point** for the real-time core, so the platform team can say yes to internal consumers without taking on operational risk.

---

## 5. Webhook-Out for SaaS Platforms

**The team**: A B2B SaaS company whose customers want "webhook me when X happens" — a common ask that's harder than it looks.

**The pain**: Building a reliable webhook-out system from scratch means: signed payloads, retries, DLQs, replay, customer-facing logs, rate limiting, SSRF protection (yes, customers will try to make you DDoS internal services), and a dashboard customers can debug with. Six months of engineering, easy.

**The fix**: Run AnyHook as the webhook-out plane. The SaaS publishes domain events to its internal Kafka or a private GraphQL subscription. AnyHook subscribes and forwards. Customer-facing log UI: solved. SSRF defense: solved. Retries: solved. Signing: solved.

**Why it matters**: Webhook-out is now table stakes for B2B SaaS, but it's a feature few teams build well. AnyHook turns it into a deployment, not a project.

---

## 6. Observability Fan-Out

**The team**: An SRE org that wants to fan logs, metrics, or trace events to multiple observability backends without paying ingest cost twice.

**The pain**: Each observability vendor wants its own agent or pipeline. Switching providers means re-instrumenting services. Running two providers in parallel during a migration means double-instrumenting everything.

**The fix**: Push events to a single internal Kafka or GraphQL subscription. Create one AnyHook subscription per observability backend. Migration is a config change, not a code change.

**Why it matters**: Vendor flexibility is real flexibility — including the freedom to A/B-test a new vendor against an incumbent.

---

## 7. Compliance & Audit Pipelines

**The team**: A regulated business (fintech, health-tech, gov-tech) that must persist every meaningful event to a write-once compliance store.

**The pain**: Compliance stores live behind webhook ingress. Internal services emit events on a real-time bus. The team has built brittle ETL jobs that "should" capture every event but occasionally drop one — which is exactly the kind of finding that ruins an audit.

**The fix**: AnyHook subscribes once to the internal event bus and writes to the compliance webhook. The `delivery_events` Postgres table is itself an audit-grade record of every attempt. The DLQ catches anything that fails. The retry policy guarantees at-least-once delivery within 24 h.

**Why it matters**: Audit-grade delivery is the difference between a clean SOC 2 and an embarrassing remediation cycle.

---

## 8. Internal Webhook Hub

**The team**: A platform engineering org whose internal services want to consume real-time events from a shared upstream (a streaming database, a CDC pipeline, an event-sourced backend).

**The pain**: Every team is building a slightly different consumer with subtly different retry semantics. Onboarding a new microservice to the event firehose takes a week.

**The fix**: Run AnyHook as a self-service internal product. Each team creates subscriptions in their own organization, sees their own deliveries, and operates within their own quotas — but the underlying infrastructure is shared and operated by platform.

**Why it matters**: AnyHook ships organizations, quotas, RBAC, and audit trails out of the box. It's a platform you can hand to internal customers on day one, not a project to build before you can hand it to them.

---

## ROI Snapshot

| Pattern | Old way | With AnyHook |
|---------|---------|--------------|
| Add a new webhook consumer to a real-time stream | 2–4 weeks of engineering | 60 seconds in the wizard |
| Recover from a 30-minute webhook receiver outage | Engineer triage + manual replay | Automatic retry, 6 attempts over 24 h, DLQ if exhausted |
| Audit "did event X fire?" | Log spelunking | Open dashboard, search delivery logs by status/time |
| Add a second subscriber to an existing stream | New consumer, new infra | Second subscription, same source, isolated retries |
| Onboard a new internal team to the event firehose | Custom OAuth + custom dashboards + custom quotas | Create an organization, send invitations |

---

*Pricing and managed-cloud options: contact us. Architecture details: [Technical_Brief.md](./Technical_Brief.md).*
