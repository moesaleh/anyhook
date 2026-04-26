---
name: feature-development-with-dashboard-integration
description: Workflow command scaffold for feature-development-with-dashboard-integration in anyhook.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-development-with-dashboard-integration

Use this workflow when working on **feature-development-with-dashboard-integration** in `anyhook`.

## Goal

Implements a major feature or enhancement in the subscription dashboard, involving both backend API and frontend dashboard changes, often including new UI components, API endpoints, and updates to the main dashboard view.

## Common Files

- `dashboard/src/app/page.tsx`
- `dashboard/src/app/subscriptions/[id]/page.tsx`
- `dashboard/src/app/subscriptions/new/page.tsx`
- `dashboard/src/app/subscriptions/page.tsx`
- `dashboard/src/components/*.tsx`
- `dashboard/src/lib/api.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create or update backend API endpoints in src/subscription-management/index.js (and sometimes src/webhook-dispatcher/index.js)
- Add or update frontend dashboard pages in dashboard/src/app/ (e.g., page.tsx, subscriptions/[id]/page.tsx, subscriptions/new/page.tsx)
- Add new or update existing React components in dashboard/src/components/
- Update dashboard/src/lib/api.ts for new API calls
- Update dashboard/src/lib/utils.ts if new utilities are needed

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.