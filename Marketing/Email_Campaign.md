# AnyHook — Email Campaign Templates

Cold outbound and drip-sequence copy. All templates use first-name personalization (`{{first_name}}`) and a stable CTA pointing at the repo. Adjust subject lines and CTAs by segment.

---

## Cold Outbound — Engineering Lead (Streaming Source Consumer)

**Subject lines (A/B):**
- *Cutting your GraphQL-subscription integration time from weeks to an hour*
- *The webhook layer your real-time API has been missing*
- *Stop rebuilding reconnect-and-retry for every stream*

**Body:**

Hi {{first_name}},

Saw {{company}} is building on {{streaming_api}}. If your team is anything like the others we've talked to, you've probably spent a few weeks (or months) writing reconnect logic, retry queues, HMAC signing, and a delivery-audit dashboard — just to route those events into the rest of your stack.

We just open-sourced **AnyHook**, the subscription-proxy backbone that does all of that as a single deployment. Point it at the GraphQL subscription or WebSocket source, give it a webhook URL, get reliable, signed, retried, audit-logged delivery. MIT-licensed. Self-hostable in one command.

Worth 10 minutes?

→ github.com/SwanBlocks-inc/anyhook

— {{sender_name}}

---

## Cold Outbound — Platform / SRE Lead

**Subject lines (A/B):**
- *A webhook-out backbone you can hand to internal customers*
- *Stop reinventing webhook-out for every new internal team*
- *Multi-tenant webhook delivery, open-source*

**Body:**

Hi {{first_name}},

If {{company}}'s platform team is fielding "can you forward these events to my webhook?" requests from internal customers, this might be useful.

**AnyHook** is an open-source subscription-proxy we just released. It ships organizations, RBAC, invitations, per-org quotas, and 2FA on day one — so you can hand it to internal teams as a self-service product rather than a project.

Production-hardened: SSRF defense, HMAC signing, envelope-encrypted secrets, Prometheus metrics, a paged runbook. MIT-licensed.

Want me to walk you through it?

→ github.com/SwanBlocks-inc/anyhook

— {{sender_name}}

---

## Drip Sequence — Trial / Repo-Visitor Follow-Up

### Day 0 (immediately after starring/forking)

**Subject:** Thanks for checking out AnyHook — three things to try first

Hi {{first_name}},

Thanks for taking a look at AnyHook. Three things most teams try first:

1. **`docker-compose up -d`** — full stack in one minute, dashboard at `:3000`.
2. **Create a subscription in the wizard** — paste any public GraphQL endpoint (try one of the public ones on https://graphqlhub.com) and a webhook URL from `webhook.site`.
3. **Open the Activity tab** — watch live deliveries land in the log table with a payload inspector.

If you hit anything weird, open an issue in the repo or hit reply on this email.

— {{sender_name}}

### Day 3

**Subject:** What does AnyHook *actually* do for you?

{{first_name}} — the question I get most is "what does AnyHook actually save me?"

Short answer: the things you'd build anyway, just done well and tested.

- 6-step exponential-backoff retry policy (15 min → 24 h)
- Dead-letter queue for failed deliveries
- HMAC-signed webhook bodies with per-subscription rotating secrets
- Multi-tenant orgs with RBAC, invitations, API keys, quotas
- 2FA via TOTP with envelope-encrypted secrets
- SSRF defense that won't let your customers DDoS internal services
- Prometheus metrics on every service + a runbook for your on-call

It's MIT-licensed; you self-host. No surprise bills.

→ github.com/SwanBlocks-inc/anyhook

### Day 7

**Subject:** Three patterns from teams running AnyHook

{{first_name}} — three patterns we keep seeing from teams who've deployed AnyHook:

1. **Crypto / DeFi**: routing on-chain GraphQL subscriptions into trading engines and audit pipelines.
2. **AI / agentic**: fanning out streaming model outputs to per-customer webhooks (serverless customers don't want to hold a WebSocket open).
3. **Platform engineering**: running AnyHook as an internal webhook hub, with each team owning its own org and quotas.

Full writeup in the repo's `Marketing/Use_Cases.md`.

If any of those match your situation, happy to compare notes.

— {{sender_name}}

### Day 14

**Subject:** Quick pilot pitch?

{{first_name}} — last note from me.

If you'd like a guided pilot — we'll help you stand up AnyHook, design the subscriptions for your data sources, and tune the retry policy for your receivers — reply here and we'll set up a 30-minute call.

Or just self-host. The repo's been our day job; happy to answer questions in issues.

→ github.com/SwanBlocks-inc/anyhook

— {{sender_name}}

---

## Re-Engagement — Lapsed Lead

**Subject:** AnyHook update: {{recent_feature}}

Hi {{first_name}},

When we last talked, AnyHook didn't yet have `{{recent_feature}}`. It does now.

- Highlights since you last looked: {{feature_list}}
- Repo: github.com/SwanBlocks-inc/anyhook

Worth another 10 minutes?

— {{sender_name}}

---

## Internal — Sales/SE Handoff Template

**Subject:** {{prospect_company}} — AnyHook qualified opportunity

Summary:
- **Industry**: {{industry}}
- **Streaming source(s)**: {{sources}}
- **Webhook receivers**: {{receivers}}
- **Volume**: {{events_per_day}} events/day, {{subscriptions}} subscriptions expected
- **Top pain**: {{pain_summary}}
- **Why now**: {{trigger_event}}
- **Champion**: {{champion_name}}, {{champion_title}}
- **Decision criteria**: {{criteria}}

Recommended next step:
- Technical deep-dive with {{champion_name}} + their security/ops reviewer
- Reference architecture mapped to {{sources}} → AnyHook → {{receivers}}
- 30-day pilot scoped to {{pilot_scope}}

---

## CTA Library

When you need a one-line call-to-action, use one of these:

- **Repo**: github.com/SwanBlocks-inc/anyhook
- **One-pager**: see `Marketing/One_Pager.md`
- **Use cases**: see `Marketing/Use_Cases.md`
- **Technical brief**: see `Marketing/Technical_Brief.md`
- **Demo**: reply with two times next week.
- **Pilot**: 30-day guided pilot, we help with setup and reference architecture.

---

*Personalize generously. Send sparingly. Reply rates beat send volume.*
