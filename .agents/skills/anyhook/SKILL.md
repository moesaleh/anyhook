```markdown
# anyhook Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill teaches the core development patterns and workflows used in the `anyhook` TypeScript codebase. The repository focuses on subscription management and webhook dispatching, with a dashboard frontend. It covers conventions for file structure, code style, and provides step-by-step guides for adding features, database tables, and performing comprehensive bugfixes or hardening sweeps. The skill also outlines how to write and locate tests, and suggests helpful CLI commands for common workflows.

---

## Coding Conventions

**File Naming**
- Use camelCase for file names.
  - Example: `subscriptionManager.ts`, `webhookDispatcher.ts`

**Import Style**
- Prefer alias imports for clarity and modularity.
  - Example:
    ```typescript
    import api from '@/lib/api';
    import { Subscription } from '@/models/subscription';
    ```

**Export Style**
- Mixed: both default and named exports are used.
  - Example:
    ```typescript
    // Named export
    export function createSubscription(data: SubscriptionData) { ... }

    // Default export
    export default SubscriptionManager;
    ```

**Frontend Structure**
- Dashboard frontend files are in `dashboard/src/app/` and `dashboard/src/components/`.
- API utilities and helpers are in `dashboard/src/lib/`.

**Backend Structure**
- Main logic in `src/subscription-management/` and `src/webhook-dispatcher/`.
- Handlers in `src/subscription-connector/handlers/`.

---

## Workflows

### Feature Development with Dashboard Integration
**Trigger:** When adding a significant new feature or capability to the subscription dashboard (e.g., detail view, analytics, creation wizard).  
**Command:** `/feature-dashboard-integration`

1. Create or update backend API endpoints in `src/subscription-management/index.js` (and sometimes `src/webhook-dispatcher/index.js`).
2. Add or update frontend dashboard pages in `dashboard/src/app/` (e.g., `page.tsx`, `subscriptions/[id]/page.tsx`, `subscriptions/new/page.tsx`).
3. Add new or update existing React components in `dashboard/src/components/`.
4. Update `dashboard/src/lib/api.ts` for new API calls.
5. Update `dashboard/src/lib/utils.ts` if new utilities are needed.
6. Update `docker-compose.yml` or dashboard service config if needed.
7. Optionally update `productfeatures.md` to track feature status.

**Example:**
```typescript
// Adding a new API call
// dashboard/src/lib/api.ts
export async function fetchSubscriptionDetail(id: string) {
  return api.get(`/api/subscriptions/${id}`);
}
```

---

### Database Table Addition with Migration and API
**Trigger:** When adding a new data entity or logging capability (e.g., `delivery_events`) to the system.  
**Command:** `/new-table`

1. Create a new migration file in `migrations/` (e.g., `migrations/20240601_create_delivery_events.sql`).
2. Update backend logic in `src/subscription-management/index.js` and/or `src/webhook-dispatcher/index.js` to use the new table.
3. Add or update API endpoints to expose the new data.
4. Update frontend dashboard components and pages to display or interact with the new data.
5. Update `dashboard/src/lib/api.ts` for new API calls.
6. Optionally update `productfeatures.md` to track feature status.

**Example:**
```sql
-- migrations/20240601_create_delivery_events.sql
CREATE TABLE delivery_events (
  id SERIAL PRIMARY KEY,
  subscription_id INTEGER REFERENCES subscriptions(id),
  event_type TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);
```
```typescript
// dashboard/src/lib/api.ts
export async function getDeliveryEvents(subscriptionId: number) {
  return api.get(`/api/subscriptions/${subscriptionId}/delivery_events`);
}
```

---

### Comprehensive Bugfix and Hardening Sweep
**Trigger:** When addressing multiple bugs, security issues, and code quality improvements in one pass.  
**Command:** `/audit-fix`

1. Fix backend bugs and add input validation in `src/subscription-management/index.js`, `src/webhook-dispatcher/index.js`, and `src/subscription-connector/handlers/`.
2. Update frontend components for error handling, accessibility, and deduplication in `dashboard/src/components/`.
3. Update `dashboard/src/lib/utils.ts` for shared utilities.
4. Update `.env.example` for new or clarified environment variables.
5. Remove dead code and improve error responses.
6. Add graceful shutdown and connection pool limits.

**Example:**
```typescript
// src/subscription-management/index.js
if (!req.body.subscriptionId) {
  return res.status(400).json({ error: 'Missing subscriptionId' });
}
```
```env
# .env.example
DB_POOL_MAX=10
```

---

## Testing Patterns

- Test files follow the `*.test.*` pattern (e.g., `api.test.ts`).
- The testing framework is not explicitly detected, but tests are likely colocated with implementation files or in dedicated test directories.
- To write a test:
  ```typescript
  // api.test.ts
  import { fetchSubscriptionDetail } from './api';

  test('fetchSubscriptionDetail returns data', async () => {
    const data = await fetchSubscriptionDetail('123');
    expect(data).toHaveProperty('id', '123');
  });
  ```

---

## Commands

| Command                         | Purpose                                                         |
|----------------------------------|-----------------------------------------------------------------|
| /feature-dashboard-integration   | Start a new feature with backend and dashboard integration       |
| /new-table                      | Add a new database table with migration and API endpoints        |
| /audit-fix                      | Perform a comprehensive bugfix, security, and hardening sweep    |
```
