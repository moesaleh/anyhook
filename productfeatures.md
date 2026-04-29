# AnyHook — Product Features Tracker

> This file is the single source of truth for all planned and completed UI/UX features for the AnyHook dashboard.

---

## 1. Subscription Creation Wizard
**Status: DONE**

- [x] Multi-step form (4 steps): Connection Type → Source Config → Webhook → Review
- [x] Step progress indicator with numbered stepper component
- [x] Connection type selection (GraphQL / WebSocket) with visual cards
- [x] Source configuration: endpoint URL, GraphQL query editor, WebSocket message, event type filter
- [x] Custom headers support (dynamic key-value pair input)
- [x] Webhook URL input with format validation
- [x] Review step showing full config summary before submission
- [x] Success confirmation page with subscription ID and next steps
- [x] Back/Next navigation between steps
- [x] Form validation per step

---

## 2. Subscription List & Management
**Status: DONE**

- [x] Searchable table (filter by ID, webhook URL, endpoint)
- [x] Column sorting (type, status, webhook URL, created date)
- [x] Type filter dropdown (All / GraphQL / WebSocket)
- [x] Status filter dropdown (All / Connected / Disconnected / Active)
- [x] Pagination (10 per page)
- [x] Copy subscription ID to clipboard
- [x] Inline delete with confirmation dialog
- [x] "View" action link (appears on row hover)
- [x] Empty state with CTA to create first subscription
- [x] Connection type badges (pink=GraphQL, blue=WebSocket)

---

## 3. Subscription Detail View
**Status: DONE**

- [x] Tabbed layout: Overview / Configuration / Activity
- [x] **Overview tab**: 3-column card grid (Connection Status, Source, Destination)
- [x] Connection status card: live state badge, Redis cache status, uptime counter, last check timestamp
- [x] Source card: connection type icon + badge, endpoint URL with copy, event filter (WebSocket)
- [x] Destination card: webhook URL with copy, HTTP method, retry policy summary
- [x] **Configuration tab**: GraphQL query / WebSocket message code block with copy
- [x] Headers displayed as key-value table
- [x] Full JSON args with copy-to-clipboard
- [x] **Activity tab**: connection timeline with animated state indicators
- [x] Visual data flow diagram: Source → AnyHook → Webhook (color-coded by connection state)
- [x] Live/Pause toggle for auto-refresh polling
- [x] Back navigation to subscriptions list
- [x] Edit button → /subscriptions/[id]/edit (single-page form, reuses wizard step components)
- [x] Delete button with confirmation dialog

---

## 4. Real-time Status Indicators
**Status: DONE**

- [x] Backend: `GET /health` endpoint (Postgres + Redis connectivity check)
- [x] Backend: `GET /subscriptions/:id/status` (Redis cache check = live connection state)
- [x] Backend: `GET /subscriptions/status/all` (bulk status for all subscriptions)
- [x] StatusBadge with animated ping pulse for live connections
- [x] "Disconnected" state (amber) for active-but-not-cached subscriptions
- [x] "Connected" label when live, configurable size (sm/md)
- [x] LiveIndicator component (polling dot, "last updated" relative timestamp, interval display)
- [x] ServiceHealth component in dashboard header (Postgres + Redis dots, polls every 30s)
- [x] Dashboard and table fetch bulk status, pass `connectedIds` per row
- [x] Auto-refresh polling every 10 seconds across all views

---

## 5. Edit/Update Subscription
**Status: DONE**

- [x] Edit button on subscription detail page
- [x] Pre-populated form with current subscription values (endpoint, query/message, headers, webhook URL)
- [x] Update API call (`PUT /subscriptions/:id`)
- [x] Wizard step components reused so the field layout matches the create flow
- [x] Connection type is pinned (delete + recreate to change it)
- [x] Backend publishes `update_events` to Kafka so the connector reloads the live connection
- [x] Backend returns 500 if Kafka publish fails — the dashboard surfaces the error

---

## 6. Dashboard Analytics & Metrics
**Status: DONE**

- [x] Event delivery counter per subscription (success / failure / retried)
- [x] Delivery success rate percentage display
- [ ] Mini sparkline charts on stat cards showing trends over time
- [x] Latency metrics (average webhook response time)
- [x] Time-range metrics: deliveries in last 24h / 7d displayed on dashboard and detail view
- [x] Backend: `GET /deliveries/stats` global aggregation endpoint
- [x] Backend: `GET /subscriptions/:id/deliveries/stats` per-subscription aggregation endpoint
- [x] Dashboard: 2nd stat card row with Total Deliveries, Success Rate, Avg Latency, Last 7d
- [x] Detail view: DeliveryStatsCard on Overview tab (success rate, counts, latency, time ranges)

---

## 7. Webhook Delivery Logs
**Status: DONE**

- [x] Activity tab: real delivery history table (replaces placeholder)
- [x] Per-delivery row: timestamp, HTTP status code, response time, payload size
- [x] Retry tracking: which deliveries were retried and how many times (retry count column)
- [x] Dead letter queue (DLQ) status: deliveries with `dlq` status shown with purple badge
- [x] Payload inspector: expandable JSON viewer for request/response body (click row to expand)
- [x] Filter by status (success / failed / retrying / dlq)
- [x] Pagination (15 per page)
- [x] Auto-refresh synced with detail page polling toggle
- [x] Backend: `delivery_events` Postgres table with indexed columns
- [x] Backend: `GET /subscriptions/:id/deliveries` paginated + filterable endpoint
- [x] Backend: webhook-dispatcher instrumented to record every delivery attempt
- [x] Backend: event_id groups original delivery + all retries
- [x] Backend: request/response payloads truncated to 10KB to prevent DB bloat
- [x] Backend: best-effort logging (Postgres failure doesn't block webhook delivery)
- [x] Backend: final attempt records exactly one row (`dlq` includes the actual HTTP context; `failed` is reserved for sub-deleted-during-retry)

---

## 8. Notifications & Alerts
**Status: TODO**

- [ ] Toast notification system for success/error/info messages
- [ ] Alert banner when a subscription enters error state
- [ ] Notification when a webhook delivery fails after all retries (DLQ event)
- [ ] Optional email/Slack webhook for critical alerts (configurable)
- [ ] Notification preferences page

---

## 9. Dark Mode & Theming
**Status: PARTIAL**

- [x] Dark mode support across all existing components (via Tailwind `dark:` classes)
- [ ] Theme toggle in sidebar/header (manual light/dark switch)
- [ ] System preference detection (`prefers-color-scheme`)
- [ ] Persist theme choice in localStorage

---

## 10. Error Handling & Resilience
**Status: PARTIAL**

- [x] Error banners on dashboard and detail pages
- [x] Retry button on API failure
- [x] Graceful loading states (spinners) on all pages
- [x] Empty states with helpful CTAs
- [x] Global error boundary (catch unhandled React errors)
- [ ] Offline detection banner ("You appear to be offline")
- [ ] Request timeout handling with user-friendly message
- [ ] Rate limiting feedback from API (429 toast)

---

## 11. Bulk Operations
**Status: TODO**

- [ ] Multi-select rows in subscription table (checkboxes)
- [ ] Bulk delete selected subscriptions
- [ ] Bulk pause/resume subscriptions
- [ ] Select all / deselect all
- [ ] Confirmation dialog showing count of affected subscriptions

---

## 12. Export & Import
**Status: TODO**

- [ ] Export subscriptions as JSON file
- [ ] Export subscriptions as CSV file
- [ ] Import subscriptions from JSON (bulk create)
- [ ] Download subscription config for a single subscription

---

## 13. Testing & Quality
**Status: PARTIAL**

- [x] Component unit tests (Vitest + React Testing Library — 73 passing)
- [x] Backend lib unit tests (Jest — 252 passing)
- [x] Backend integration tests (real Postgres in CI; auth, subscriptions, organizations, invitations, password, quotas, two-factor)
- [x] E2E tests for /login + /register render + form behaviour (Playwright)
- [ ] E2E tests for the create-subscription wizard
- [ ] E2E tests for the delete flow
- [ ] E2E tests for the 2FA enrollment + login flows
- [ ] Accessibility audit (keyboard navigation, screen reader labels, ARIA)

---

## 14. Performance Optimizations
**Status: TODO**

- [ ] Virtualized table for large subscription lists (1000+)
- [ ] Debounced search input
- [ ] Request deduplication (avoid duplicate fetches during fast navigation)
- [ ] Optimistic UI updates on delete/create
- [ ] Service worker for caching static assets

---

## 15. Authentication & Authorization
**Status: DONE**

- [x] Login page (email + password)
- [x] Register page (creates user + first organization, becomes owner)
- [x] Session cookie auth (HttpOnly JWT, 7-day expiry, SameSite=lax)
- [x] API-key auth (`Authorization: Bearer ak_...`)
- [x] Protected routes (middleware redirects unauthenticated users to /login)
- [x] User profile / settings page
- [x] Role-based access (owner, admin, member); only owners can demote/remove owners; never the last owner
- [x] Multi-org support: create, switch, list members, list quotas
- [x] Password change (Settings → Security)
- [x] Password reset request + reset-via-token (anonymous /forgot-password + /reset-password)
- [x] 2FA via TOTP (RFC 6238) with single-use 64-bit backup codes
- [x] 2FA replay guard via users.last_totp_step
- [x] 2FA Settings → Security panel: enable, verify, disable, regenerate-by-disable+enable
- [x] Login page handles needs_2fa second-step flow (TOTP or backup code)
- [x] Email invitation flow: create + list + revoke (Settings → Members) + anonymous /invitations/[token] accept page
- [x] token_version invalidation: logout / password change / 2FA disable invalidate every outstanding cookie
- [x] Per-org rate limit + per-IP auth-endpoint rate limit
- [x] Per-org quotas (subscriptions, API keys) with advisory-locked atomic claim
- [x] CSRF mitigation via SameSite=lax + JSON-only API
- [x] SSRF defense on subscription URLs (private/loopback/CGNAT/IPv6 ULA blocked; inet_aton-aware)
- [x] Webhook HMAC signing (X-AnyHook-Signature: t=...,v1=...)
- [x] Backup-code peppering via BACKUP_CODE_PEPPER env

---

## Summary

| #  | Feature                        | Status   |
|----|--------------------------------|----------|
| 1  | Subscription Creation Wizard   | DONE     |
| 2  | Subscription List & Management | DONE     |
| 3  | Subscription Detail View       | DONE     |
| 4  | Real-time Status Indicators    | DONE     |
| 5  | Edit/Update Subscription       | DONE     |
| 6  | Dashboard Analytics & Metrics  | DONE     |
| 7  | Webhook Delivery Logs          | DONE     |
| 8  | Notifications & Alerts         | TODO     |
| 9  | Dark Mode & Theming            | PARTIAL  |
| 10 | Error Handling & Resilience    | PARTIAL  |
| 11 | Bulk Operations                | TODO     |
| 12 | Export & Import                | TODO     |
| 13 | Testing & Quality              | PARTIAL  |
| 14 | Performance Optimizations      | TODO     |
| 15 | Authentication & Authorization | DONE     |

**Completed: 9/15 | Partial: 3/15 | Remaining: 3/15**
