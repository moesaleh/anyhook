# Launch Announcement — AnyHook 1.0

> *Press-release-style copy. Adapt for blog, Hacker News, Product Hunt, and social. Replace bracketed placeholders before publishing.*

---

## FOR IMMEDIATE RELEASE

### AnyHook 1.0: An Open-Source Subscription Proxy That Turns Streaming APIs Into Reliable Webhooks

**[CITY], [DATE]** — Today we're announcing **AnyHook 1.0**, an open-source platform that connects GraphQL subscriptions and WebSocket data sources to HTTPS webhook endpoints with production-grade reliability, security, and observability. AnyHook is MIT-licensed, self-hostable, and available now at [github.com/SwanBlocks-inc/anyhook](https://github.com/SwanBlocks-inc/anyhook).

Modern applications consume real-time data — trading signals, AI token streams, IoT telemetry, collaborative-editing events — but the systems that produce these events speak stateful, long-lived protocols, while the systems that consume them increasingly live on stateless, serverless infrastructure. Closing that gap has, until now, meant weeks of bespoke engineering for every integration: reconnect loops, retry queues, signing, audit trails, and a dashboard so engineers can debug what happened when a webhook didn't fire.

**AnyHook closes that gap as a single deployment.**

### What's New in 1.0

- **Multi-source connectors**: native GraphQL subscriptions and raw WebSocket support, with a pluggable handler architecture for SSE, MQTT, and gRPC streaming on the roadmap.
- **Reliable delivery pipeline**: Kafka-backed event bus, six-step exponential-backoff retries (15 min → 1 h → 2 h → 6 h → 12 h → 24 h), persistent dead-letter queue, and per-subscription HMAC-SHA256 signatures.
- **Multi-tenant from day one**: organizations, role-based access control (owner/admin/member), email invitations, API keys, per-org rate limits, and standing quotas.
- **Two-factor authentication**: TOTP (RFC 6238) with single-use 64-bit backup codes, peppered backup-code hashing, envelope-encrypted TOTP secrets with online key rotation.
- **Production observability**: Prometheus metrics on every service, a published alerting bundle, and a paged runbook mapping each alert to a diagnostic command, likely root cause, and escalation path.
- **Polished dashboard**: a Next.js 16 / React 19 frontend with a 4-step subscription wizard, real-time status indicators, delivery logs with payload inspector, per-subscription analytics, and a service-health header.
- **Default-on security hardening**: SSRF defense (loopback / RFC 1918 / CGNAT / IPv6 ULA blocking, with `inet_aton` awareness), CSRF mitigation via SameSite cookies, per-IP rate limits on auth endpoints, advisory-locked quota enforcement.

### Why It Matters

> "Every modern company building on real-time APIs is reinventing the same plumbing — reconnects, retries, signing, audit. We built AnyHook so they don't have to. It's the layer we wished existed when we were on call at 3 a.m. waiting for the WebSocket to reconnect."
>
> — [Founder / Maintainer Name], AnyHook

By making subscription-proxying a deployable building block, AnyHook lets engineering teams add a new real-time integration in **under an hour** rather than the **two-to-six weeks** typical of custom implementations. It is the open-source backbone for everything from crypto trading signals to AI agent fan-out, IoT telemetry, and B2B SaaS webhook-out features.

### Availability

AnyHook 1.0 is generally available under the MIT license. A complete `docker-compose.yml` is in the repository; new users can have a running stack in one command. Managed-cloud and commercial support options are available for design partners — see the [GitHub repo](https://github.com/SwanBlocks-inc/anyhook) to inquire.

### About AnyHook

AnyHook is a community-built, MIT-licensed subscription-proxy server developed by **[Organization Name]**. It is designed to be the standard open-source plumbing between real-time data sources and webhook-consuming applications.

---

## Short Variant (Hacker News / Product Hunt)

> **AnyHook — open-source subscription proxy for real-time events (GraphQL/WebSocket → webhook)**
>
> We just open-sourced AnyHook, a production-grade subscription proxy. Point it at a GraphQL subscription or WebSocket source, give it a webhook URL, and it handles reconnects, exponential-backoff retries (15min → 24h), HMAC signing, a dead-letter queue, and a dashboard with live status, delivery logs, and a payload inspector.
>
> Built on Node.js, Kafka, Postgres, Redis. Ships with multi-tenancy, RBAC, 2FA, API keys, per-org quotas, SSRF defense, Prometheus metrics, and a runbook. MIT-licensed.
>
> `docker-compose up -d` and you're running.
>
> github.com/SwanBlocks-inc/anyhook

---

## Twitter / X Thread

**1/** We're open-sourcing AnyHook today — the missing piece between real-time streaming APIs and the webhook-driven world.

Point it at a GraphQL subscription or WebSocket. Give it a webhook URL. AnyHook does the rest. 🧵

**2/** Every team building on real-time data ends up rewriting the same plumbing:
• reconnect on failure
• retry with backoff
• dead-letter what doesn't deliver
• sign every payload
• show engineers what happened

AnyHook is that plumbing, as a deployment.

**3/** Under the hood:
• Kafka event bus
• Postgres durability
• Redis hot state
• 3 Node.js microservices that scale horizontally
• Transactional outbox so events aren't lost on partial failure
• `FOR UPDATE SKIP LOCKED` everywhere there are pollers

**4/** Security defaults that should be table stakes but rarely are:
• SSRF defense (incl. IPv6 ULA + inet_aton tricks)
• HMAC signing with per-sub rotating secrets
• Envelope-encrypted TOTP secrets
• Peppered backup-code hashing
• Per-IP + per-org rate limits

**5/** And the dashboard isn't an afterthought. 4-step wizard. Live status badges. Delivery logs with payload inspector. Per-sub analytics. Built on Next.js 16 + React 19.

**6/** Multi-tenant from day one: orgs, RBAC, invitations, API keys, quotas. 2FA via TOTP. Password reset via email. Token-version-based session invalidation.

**7/** MIT-licensed. `docker-compose up -d` and you're running.

github.com/SwanBlocks-inc/anyhook

We'd love your feedback. 🙏

---

## LinkedIn Post

I'm excited to share AnyHook 1.0 — the open-source subscription proxy we've been building.

**The problem**: Real-time data sources speak GraphQL subscriptions and WebSocket. Modern consumers — Lambda, Cloudflare Workers, Vercel, downstream SaaS — speak HTTP webhooks. Bridging the two takes weeks per integration and breaks at 3 a.m.

**What AnyHook does**: connects any GraphQL/WebSocket stream to any webhook URL with retries, signing, audit logs, and a multi-tenant dashboard. Production-grade out of the box. MIT-licensed. Self-hostable in one command.

If your team is building anything real-time — trading, AI, IoT, collaborative apps — take a look. We'd love early adopters and design partners.

→ github.com/SwanBlocks-inc/anyhook

---

*Replace the placeholders. Use the variant that fits the channel. Ship it.*
