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
- [x] Status filter dropdown (All / Connected / Disconnected / Active / Error)
- [x] Pagination (10 per page)
- [x] Copy subscription ID to clipboard
- [x] External link to webhook URL
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
- [x] Destination card: webhook URL with external link, HTTP method, retry policy summary
- [x] **Configuration tab**: GraphQL query / WebSocket message code block with copy
- [x] Headers displayed as key-value table
- [x] Full JSON args with copy-to-clipboard
- [x] **Activity tab**: connection timeline with animated state indicators
- [x] Delivery logs placeholder (future feature)
- [x] Visual data flow diagram: Source → AnyHook → Webhook (color-coded by connection state)
- [x] Live/Pause toggle for auto-refresh polling
- [x] Back navigation to subscriptions list
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
**Status: TODO**

- [ ] Edit button on subscription detail page
- [ ] Pre-populated form with current subscription values
- [ ] Inline editing for webhook URL (quick edit without full form)
- [ ] Update API call (`PUT /subscriptions/:id`) already exists in backend
- [ ] Confirmation before saving changes
- [ ] Success/error toast notification after update

---

## 6. Dashboard Analytics & Metrics
**Status: TODO**

- [ ] Event delivery counter per subscription (success / failure / retried)
- [ ] Delivery success rate percentage display
- [ ] Mini sparkline charts on stat cards showing trends over time
- [ ] Latency metrics (average webhook response time)
- [ ] Time-series chart: events delivered over last 24h / 7d / 30d
- [ ] Backend: event logging and aggregation endpoints

---

## 7. Webhook Delivery Logs
**Status: TODO**

- [ ] Activity tab: real delivery history table (replaces placeholder)
- [ ] Per-delivery row: timestamp, HTTP status code, response time, payload size
- [ ] Retry tracking: which deliveries were retried and how many times
- [ ] Dead letter queue (DLQ) viewer: failed deliveries after max retries
- [ ] Payload inspector: expandable JSON viewer for request/response body
- [ ] Filter by status (success / failed / retrying)
- [ ] Backend: persist delivery events to Postgres (currently ephemeral)

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
- [ ] Global error boundary (catch unhandled React errors)
- [ ] Offline detection banner ("You appear to be offline")
- [ ] Request timeout handling with user-friendly message
- [ ] Rate limiting feedback from API

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
**Status: TODO**

- [ ] Component unit tests (Jest + React Testing Library)
- [ ] API integration tests
- [ ] E2E tests for creation wizard flow
- [ ] E2E tests for delete flow
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
**Status: TODO**

- [ ] Login page
- [ ] API key or JWT-based auth
- [ ] Protected routes (redirect to login if unauthenticated)
- [ ] User profile / settings page
- [ ] Role-based access (admin vs read-only)

---

## Summary

| #  | Feature                        | Status   |
|----|--------------------------------|----------|
| 1  | Subscription Creation Wizard   | DONE     |
| 2  | Subscription List & Management | DONE     |
| 3  | Subscription Detail View       | DONE     |
| 4  | Real-time Status Indicators    | DONE     |
| 5  | Edit/Update Subscription       | TODO     |
| 6  | Dashboard Analytics & Metrics  | TODO     |
| 7  | Webhook Delivery Logs          | TODO     |
| 8  | Notifications & Alerts         | TODO     |
| 9  | Dark Mode & Theming            | PARTIAL  |
| 10 | Error Handling & Resilience    | PARTIAL  |
| 11 | Bulk Operations                | TODO     |
| 12 | Export & Import                | TODO     |
| 13 | Testing & Quality              | TODO     |
| 14 | Performance Optimizations      | TODO     |
| 15 | Authentication & Authorization | TODO     |

**Completed: 4/15 | Partial: 2/15 | Remaining: 9/15**
