---
name: database-table-addition-with-migration-and-api
description: Workflow command scaffold for database-table-addition-with-migration-and-api in anyhook.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /database-table-addition-with-migration-and-api

Use this workflow when working on **database-table-addition-with-migration-and-api** in `anyhook`.

## Goal

Adds a new database table with a migration, updates backend logic to use the new table, and exposes new API endpoints to interact with it.

## Common Files

- `migrations/*.sql`
- `src/subscription-management/index.js`
- `src/webhook-dispatcher/index.js`
- `dashboard/src/components/*.tsx`
- `dashboard/src/app/subscriptions/[id]/page.tsx`
- `dashboard/src/lib/api.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Create a new migration file in migrations/ (e.g., migrations/YYYYMMDD_create_table.sql)
- Update backend logic in src/subscription-management/index.js and/or src/webhook-dispatcher/index.js to use the new table
- Add or update API endpoints to expose the new data
- Update frontend dashboard components and pages to display or interact with the new data
- Update dashboard/src/lib/api.ts for new API calls

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.