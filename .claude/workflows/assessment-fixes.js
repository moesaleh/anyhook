export const meta = {
  name: 'assessment-fixes',
  description: 'Execute the 50-item AnyHook fix plan via file-disjoint parallel agents in 3 dependency waves',
  phases: [
    { title: 'Foundation', detail: 'Leaf files: ssrf-guard, secrets, infra, ci, migrations, libs, auth, jest, dashboard, docs' },
    { title: 'Services', detail: 'dispatcher, connector, mgmt-app, mgmt-index, notifications (consume Wave-1 helpers)' },
    { title: 'Tests', detail: 'dispatcher/connector/notification suites + coverage gate + dashboard e2e' },
  ],
}

const ROOT = 'C:/Labs/GithubClonedRepos/anyhook'

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'items'],
  properties: {
    summary: { type: 'string', description: 'One-paragraph summary of what you changed' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'status', 'files', 'note'],
        properties: {
          id: { type: 'string', description: 'Fix-plan item id, e.g. P0-3' },
          status: { type: 'string', enum: ['done', 'partial', 'skipped'] },
          files: { type: 'array', items: { type: 'string' } },
          note: { type: 'string' },
        },
      },
    },
    newFiles: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
}

const SHARED = `You are fixing items from the AnyHook tracked fix plan. Repo root: ${ROOT}.

GROUND RULES (critical — violating these breaks a parallel multi-agent run):
- Read ${ROOT}/docs/CODEBASE-ASSESSMENT.md and ${ROOT}/docs/ASSESSMENT-FIX-PLAN.md and search them for YOUR item IDs to get full rationale + exact line refs.
- ONLY create/edit the files explicitly listed under "YOUR FILES". Another agent owns every other file — touching it corrupts the run. You MAY read any file.
- Do NOT edit docs/ASSESSMENT-FIX-PLAN.md or docs/CODEBASE-ASSESSMENT.md (the orchestrator updates the checkboxes).
- Do NOT add npm/pnpm dependencies or modify any lockfile or root package.json unless it is in YOUR FILES. Implement small helpers inline instead of pulling a library.
- Do NOT run \`npm install\`, \`npm test\`, the full jest suite, or any build. You may run \`npx eslint <your files>\` on your own files only. The orchestrator runs the full verification afterward.
- Preserve existing behavior and match the surrounding code style (comment density, naming, error handling idioms). Keep existing tests passing — do not change public function signatures unless the item requires it, and if you must, note it.
- Make the edits real and complete. If an item is genuinely infeasible without breaking something, implement the safest partial the plan allows and mark it "partial" with a clear note. Prefer landing working code over ambition.

Return ONLY the structured object (summary, items[], newFiles[], risks[]).`

// ---------------------------------------------------------------------------
// WAVE 1 — Foundation (disjoint leaf files)
// ---------------------------------------------------------------------------
const FOUNDATION = [
  {
    label: 'ssrf-guard',
    agentType: 'security-engineer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/lib/url-validation.js  (extend; keep all existing exports + behavior)
- ${ROOT}/src/lib/ssrf-guard.js      (NEW)

ITEM P0-4 (foundation half — the shared guard the dispatcher/connector/notifications agents will consume in Wave 2):
Build a connect-time SSRF defense module. url-validation.js currently only validates at create-time and has no DNS resolution.

In url-validation.js: export the existing private/loopback/link-local/CGNAT IP classifier (e.g. \`isPrivateOrLoopbackHost\` / an \`isPrivateIp(addr)\`) so ssrf-guard can reuse it. Do not weaken existing checks (decimal/octal/hex/IPv6-mapped bypasses are already covered and tested by tests/lib/url-validation.test.js — keep them green).

In ssrf-guard.js implement and export:
- \`async function resolveAndValidate(urlString)\`: parse the URL; if host is a literal IP, validate it's public; else dns.promises.lookup(host, { all: true }) and reject if ANY resolved A/AAAA is private/loopback/link-local/CGNAT/IMDS (169.254.169.254). Return { url, pinnedIp, family } (pin the first public address).
- \`function createSafeAgent(pinnedIp, family, isHttps)\`: return a Node http/https Agent subclass instance whose connection always dials \`pinnedIp\` (override createConnection to inject a \`lookup\` that returns the pre-validated pinnedIp, re-asserting it's public) so the original hostname is still used for TLS SNI/cert validation but DNS-rebinding between check and connect is impossible.
- \`async function guardedAxiosConfig(urlString, baseConfig = {})\`: returns { ...baseConfig, httpAgent, httpsAgent, maxRedirects: 0 } after resolveAndValidate; throws a typed error (e.g. SsrfBlockedError with a .reason) if blocked.
- \`async function assertConnectAllowed(urlString)\`: lightweight resolve+validate for ws/graphql connect paths (throws if blocked, returns { pinnedIp, family }).

No new deps — use built-in dns, http, https, net. Write a clear module docstring. Add focused inline comments.`,
  },
  {
    label: 'secrets-env-jwt',
    agentType: 'security-engineer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/.env.example
- ${ROOT}/src/lib/jwt.js

ITEM P0-6 — Placeholder JWT_SECRET passes the length gate.
.env.example ships an uncommented >=32-char JWT_SECRET placeholder, so a copy-paste deploy boots with a public signing key. Fix:
1. In .env.example: comment out the JWT_SECRET line (like BACKUP_CODE_PEPPER / TOTP_SECRET_KEY / ADMIN_API_KEY already are) so the app refuses to start until it's set. Add a one-line comment showing how to generate one: \`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"\`. Do the same hygiene for any other uncommented real-looking secret placeholder you find there.
2. In src/lib/jwt.js: in addition to the existing >=32 length gate, reject the known placeholder value(s) at startup (e.g. anything starting with "please_change_me") with a clear thrown error, so even a copy of the old example fails fast. Keep all existing exports/behavior.`,
  },
  {
    label: 'infra-docker',
    agentType: 'devops-engineer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/Dockerfile
- ${ROOT}/.dockerignore            (NEW)
- ${ROOT}/dashboard/.dockerignore  (NEW)
- ${ROOT}/docker-compose.yml
- ${ROOT}/package.json             (ONLY the dependency move + a migrate script; do not touch other fields)

ITEMS:
- P0-5 — Add .dockerignore at repo root AND dashboard/ excluding at least: \`.env\`, \`.env.*\`, \`node_modules\`, \`.git\`, \`coverage\`, \`tests\`, \`*.md\`, \`.github\`, \`docs\`, \`.claude\`. (Dockerfile uses \`COPY . .\` so this prevents .env/secrets being baked into builder layers.)
- P0-1 / P1-9 (infra half) — Move \`node-pg-migrate\` from devDependencies to dependencies in package.json (so \`npx node-pg-migrate up\` works in the pruned runner image). Keep the existing \`"migrate"\` script. This is the belt-and-suspenders fix; the boot-decoupling half is done by another agent in src/subscription-management/index.js, and the compose migrate service below.
- P1-9 (compose half) — Add a one-shot \`migrate\` service to docker-compose.yml: same image as the app, command runs \`npm run migrate\` (or \`npx node-pg-migrate up\`), depends_on postgres healthy, no \`restart: unless-stopped\` (one-shot: \`restart: "no"\`), shares the DB env. The app services should depend_on it completing (\`condition: service_completed_successfully\`) where compose supports it.
- P1-1 — Remove the fixed \`container_name:\` from the stateless workers subscription-connector and webhook-dispatcher so \`--scale\`/replicas work. Add \`deploy: { replicas: 1 }\` (documented as tunable) to each.
- P1-8 (compose half) — Add a comment block near the kafka service documenting the prod topology (3-broker quorum, RF>=3, min.insync.replicas=2) vs the single-node dev default; do NOT break the working single-node dev compose. If a KAFKA_REPLICATION_FACTOR / KAFKA_PARTITIONS env passthrough is missing on the app services that create topics, add it.
- P2-8 — Add \`deploy.resources.limits\` (memory + cpus, conservative e.g. mem 512M workers / 1G data tier, sized sanely) and a restart backoff where compose supports it for each service; cap the crash-loop.
- P2-10 (compose half) — Parameterize the three app service image tags to \`ghcr.io/moesaleh/anyhook:\${IMAGE_TAG:-latest}\` instead of a hardcoded mutable \`:latest\`.

Keep the dev experience working (a plain \`docker compose up\` must still be valid YAML and start). Validate your compose edits are well-formed YAML.`,
  },
  {
    label: 'ci',
    agentType: 'devops-engineer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/.github/workflows/ci.yml

ITEMS:
- P2-9 — Add an image vulnerability scan + SBOM to the publish job: Trivy (aquasecurity/trivy-action) failing on HIGH/CRITICAL, and an SBOM step (anchore/sbom-action / syft or buildx \`--sbom\`). Optionally a cosign sign/attest step gated behind a secret check.
- P2-10 (CI half) — Add a gated \`deploy\` job (needs: publish, environment: production with required reviewers) that pulls the \`:sha-<commit>\` tag, runs the migration one-shot job FIRST, then a health-gated rolling update with a \`/health\` check and rollback note. A simple SSH \`docker compose pull && up -d\` + post-deploy curl /health is acceptable; keep it behind the environment gate so it no-ops without approval/secrets.
- P1-9 (CI half) — Ensure migrations run as a discrete pre-deploy step (the migrate job/service) rather than relying on app-boot. Reference \`npx node-pg-migrate up\`.
- P1-7 (CI half) — The backend-tests job already runs \`npm run test:coverage\`; ensure it does, and that a coverage failure (the threshold another agent adds to jest.config.js) fails the job. Do not relax it.

Keep all existing jobs/steps working; only add/adjust. Validate YAML well-formedness.`,
  },
  {
    label: 'migrations-sql',
    agentType: 'postgres-pro',
    prompt: `${SHARED}

YOUR FILES (exclusive — create NEW migration files only; pick sequential timestamps AFTER the latest existing one 20260508000000, e.g. 20260509000000, 20260510000000, ...; do NOT edit existing migrations):
- ${ROOT}/migrations/<newts>_*.sql  (one file per item below, or grouped sensibly)

Follow the existing node-pg-migrate SQL-file conventions in ${ROOT}/migrations/ (look at 20260507000000_add_notification_attempts.sql for style: header comment, idempotent guards, explicit up SQL). Each file must be safe to run once in order.

ITEMS:
- P1-4 (schema half) — Create a dedicated idempotency table \`processed_events\` for atomic delivery dedup: \`(subscription_id UUID NOT NULL, event_id TEXT NOT NULL, organization_id UUID, processed_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (subscription_id, event_id))\`. This is the gate the dispatcher will use via \`INSERT ... ON CONFLICT DO NOTHING\`. (Do NOT put a UNIQUE on delivery_events — that table legitimately has multiple rows per (sub,event) across retries.) Index/FK as appropriate; keep it cheap to insert.
- P1-5 (schema half) — Address unbounded delivery_events growth. Add a covering index \`(organization_id, created_at DESC, status)\` to support a bounded stats query, and create a retention mechanism: EITHER convert delivery_events to monthly range partitioning by created_at with a documented DROP-PARTITION aging job, OR (if converting an existing populated table in one migration is unsafe) add a documented scheduled-DELETE approach + the covering index + a comment explaining the partitioning follow-up. Choose the safe option and document the choice in the file header.
- P2-11 — Add composite FK so denormalized organization_id can't mis-attribute rows across tenants: add a UNIQUE constraint on \`subscriptions(subscription_id, organization_id)\` then composite FKs \`delivery_events(subscription_id, organization_id) REFERENCES subscriptions(...)\` and the same for \`pending_retries\`. Guard for existing data consistency; if a backfill/validation is needed, do it NOT VALID + VALIDATE or document.
- P2-12 — Migrate legacy \`subscriptions.created_at\` from TIMESTAMP (no tz) to TIMESTAMPTZ: \`ALTER ... TYPE TIMESTAMPTZ USING created_at AT TIME ZONE 'UTC'\`. Note in the header it's a column rewrite (maintenance window). Optionally add \`DEFAULT gen_random_uuid()\` to the PK if missing.
- P2-13 (schema note) — \`users.totp_secret\` at-rest encryption: the actual encrypt/decrypt wiring is done in the auth path by another agent using src/lib/envelope.js with a plaintext-fallback (no column rename needed since ciphertext fits TEXT). Your part: add a short migration/comment documenting the transition + optionally an \`totp_secret_enc_keyid\` nullable column if helpful for key rotation. Keep it backward compatible.
- P2-16 — Retention sweep for terminal notification_attempts: add a documented scheduled-DELETE (or partial-index-friendly cleanup) for delivered/dlq rows older than N days. Mirror the delivery_events approach, lower volume.
- P2-26 — Add a post-deploy verification migration/comment that catalog-checks the old \`users_email_key\` constraint and \`idx_users_email_lower\` index are actually gone after 20260504000000 (a DO $$ block raising a notice/exception if a stray pre-existing constraint with a non-default name lingers). Non-destructive.

Prefer additive, reversible DDL. Add a \`down\`/comment where the convention uses it.`,
  },
  {
    label: 'libs-quota-ratelimit',
    agentType: 'backend-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/lib/quotas.js
- ${ROOT}/src/lib/rate-limit.js

ITEMS:
- P0-3 (CONFIRMED BUG) — In quotas.js \`makeSubscriptionQuotaCheck\`, the unlock at lines ~76-81 calls \`pg_advisory_unlock($1, $2)\` passing the RAW \`req.auth.organizationId\` UUID, but the lock at ~91-94 uses \`pg_advisory_lock($1, hashtext($2::text))\`. The keys differ so the session-level lock never releases and leaks onto the pooled connection. FIX: change the unlock to \`SELECT pg_advisory_unlock($1, hashtext($2::text))\` with the same [ADVISORY_LOCK_KEY_QUOTAS, req.auth.organizationId] params (mirror the api-key path which is already correct at line ~174). Update the misleading comment.
- P2-7 (quotas half) — Shorten the advisory-lock connection hold. Currently the lock is session-level and held until res 'finish'/'close' (the entire request incl. response flush). Refactor toward holding the lock only across the count+claim window: prefer \`pg_advisory_xact_lock\` inside a short transaction (BEGIN; xact-lock; count; if over-limit rollback+429; else the create handler must run in the same txn) OR, if the create handler can't share the txn cleanly, keep session lock but release it immediately after the quota decision instead of on response finish. Pick the approach that doesn't change the middleware's external contract and keeps quotas.test.js green; if a full xact refactor risks the handler's INSERT racing, implement the "release right after decision" improvement and note the residual.
- P2-2 — In rate-limit.js \`makeRateLimit\`, the \`INCR\` then separate \`EXPIRE\` (only when count===1) is non-atomic: a crash/Redis blip between them strands a TTL-less key that rate-limits an org forever. Make it atomic — a small Lua script (INCR + conditional PEXPIRE) via redis EVAL, or \`SET key 0 EX <ttl> NX\` then INCR, or a MULTI pipeline. Preserve the fail-open intent and existing return shape.
- P2-5 (rate-limit half — XFF) — \`ipKeyFn\` trusts the first \`X-Forwarded-For\` token unconditionally. Only honor XFF when a trusted-proxy flag is set (gate on the same TRUST_PROXY signal Express uses, e.g. process.env.TRUST_PROXY); otherwise fall back to req.ip. (The per-account login/2FA throttling half of P2-5 is done by the auth agent.)

Keep all exports stable. Match existing style and the detailed comment idiom in these files.`,
  },
  {
    label: 'auth',
    agentType: 'backend-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/subscription-management/auth.js

You may READ src/lib/envelope.js, src/lib/totp.js, src/lib/rate-limit.js to use their exports (do not edit them).

ITEMS:
- P2-25 — Standardize ROLLBACK handling. auth.js uses bare \`await client.query('ROLLBACK')\` in catch blocks (register ~307, 2fa/verify-setup ~612, create-org ~841, add-member ~952, remove-member ~1018, accept-invite ~1683). If the failure was connection-level, the ROLLBACK itself rejects and escapes the catch, leaving the request hanging (response never sent). FIX: change every catch-block rollback to \`await client.query('ROLLBACK').catch(() => {})\` (mirroring app.js). Optionally introduce a private \`withTransaction(pool, fn)\` helper in this file and route these handlers through it, but the minimal safe fix (the .catch on every ROLLBACK) is required at all listed sites — grep for every \`ROLLBACK\` to be exhaustive.
- P2-5 (auth half — per-account throttling) — Login (\`/auth/login\`) and 2FA verify (\`/auth/2fa/verify-login\`) are IP-rate-limited only. Add a per-account failed-attempt counter with backoff/temporary lockout (Redis-keyed by user id/email, e.g. \`login:fail:<id>\`) on BOTH password and TOTP verification: increment on failure, clear on success, and reject with a 429/lockout once a threshold is exceeded within a window. Keep the existing constant-time/dummy-hash enumeration defenses intact. Use the redis client already available to these handlers.
- P2-13 (auth/wiring half) — Encrypt users.totp_secret at rest using src/lib/envelope.js. On 2FA enrollment, store the envelope ciphertext (+ key id if the schema has the column) instead of the plaintext Base32 secret; on verify, decrypt via envelope with a PLAINTEXT FALLBACK (detect already-ciphertext vs legacy plaintext by format) so existing rows keep working with no data migration. If envelope.js lacks a needed key/env, gate the encryption behind that env being present and fall back to current behavior with a logged warning (mark this item partial in that case).

Keep auth.test.js / two-factor.test.js green. Match the file's existing structure and logging.`,
  },
  {
    label: 'jest-config',
    agentType: 'test-automator',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/jest.config.js

ITEM P1-7 (config half) — \`collectCoverageFrom\` is scoped to \`['src/lib/**/*.js']\` only, excluding the riskiest code (dispatcher/connector/management) and making the coverage number misleading. Broaden it to include the service dirs while excluding harness scripts:
\`collectCoverageFrom: ['src/lib/**/*.js', 'src/webhook-dispatcher/**/*.js', 'src/subscription-connector/**/*.js', 'src/subscription-management/**/*.js', '!src/test/**']\`
Do NOT add a coverageThreshold yet — a Wave-3 agent adds it after the new dispatcher/connector tests exist (so the threshold can be calibrated to real numbers without falsely failing CI). Keep maxWorkers/globalSetup and all other settings exactly as-is.`,
  },
  {
    label: 'dashboard-polling',
    agentType: 'nextjs-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/dashboard/src/app/page.tsx
- ${ROOT}/dashboard/src/app/subscriptions/page.tsx
- ${ROOT}/dashboard/src/app/subscriptions/[id]/page.tsx
- ${ROOT}/dashboard/src/components/service-health.tsx
- ${ROOT}/dashboard/src/components/dlq-alert.tsx
- ${ROOT}/dashboard/src/components/live-indicator.tsx
- ${ROOT}/dashboard/src/lib/use-visible-polling.ts   (NEW)
- ${ROOT}/dashboard/src/app/loading.tsx               (NEW)
- ${ROOT}/dashboard/src/app/error.tsx                 (NEW)
- ${ROOT}/dashboard/src/app/subscriptions/loading.tsx (NEW)
- ${ROOT}/dashboard/src/app/subscriptions/[id]/loading.tsx (NEW)

ITEMS:
- P2-27 — "Real-time" is unbounded setInterval polling that never pauses on hidden tabs. Create a \`useVisiblePolling(callback, intervalMs)\` hook (NEW use-visible-polling.ts) that runs the callback on an interval but pauses when \`document.hidden\` and resumes on \`visibilitychange\`, centralizing the setInterval/clearInterval boilerplate and returning an \`isPolling\` boolean. Refactor every polling loop in your owned pages/components to use it (dashboard 10s ×3, detail 10s ×3, service-health 30s, dlq-alert 30s; also the export-menu page if it polls). Drive the dashboard \`LiveIndicator\` from the hook's real \`isPolling\` state instead of the hard-coded \`isPolling={true}\`. The export-menu KEYBOARD a11y on subscriptions/page.tsx is owned by another agent — leave the menu markup alone, only change its polling.
- P2-28 (route shells, minimal-safe) — Add route-level \`loading.tsx\` (instant skeletons) for the dashboard, subscriptions, and subscription-detail routes, and a root \`error.tsx\` route error boundary. Do NOT convert pages to Server Components or remove "use client" — keep the CSR app working; just add the App Router loading/error files (these can be Server Components themselves). Reuse existing skeleton/empty-state components if present.

Keep TypeScript strict-clean (this project has strict:true). Match existing component patterns.`,
  },
  {
    label: 'dashboard-api',
    agentType: 'nextjs-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/dashboard/src/lib/api.ts
- ${ROOT}/dashboard/src/lib/auth-context.tsx
- ${ROOT}/dashboard/middleware.ts            (locate it; may be dashboard/middleware.ts)
- ${ROOT}/dashboard/src/lib/public-paths.ts  (NEW)

ITEMS:
- P2-29 — Collapse the ~2 dozen near-identical fetch blocks in api.ts into one typed helper \`async function request<T>(path, init, opts?: { auth?: boolean; fallbackMsg?: string }): Promise<T>\` that runs apiFetch, optionally checkAuth, parses JSON-or-{}, and throws a typed \`ApiError(status, message)\` (add the class). Route all exported endpoints through it. Preserve the existing specialized error classes (RateLimitError/TimeoutError/OfflineError/AuthError) and the read-vs-mutation timeout behavior; preserve which endpoints intentionally skip checkAuth (login/register/2FA-setup) — encode that via the \`auth\` opt. Do NOT change function names/return types that pages import.
- P2-31 — The set of public/unauthenticated routes is defined twice and disagrees: middleware.ts allows /login,/register,/forgot-password,/reset-password,/invitations/*; AuthProvider's PUBLIC_PATHS has only /login,/register. Create NEW \`dashboard/src/lib/public-paths.ts\` exporting a single \`PUBLIC_PATHS\` + \`PUBLIC_PREFIXES\` (and a \`isPublicPath(path)\` helper) and import it from BOTH middleware.ts and auth-context.tsx; align the provider's 401-redirect logic so it doesn't redirect on genuinely public routes.

Keep TS strict-clean. Don't touch pages/components (other agents own them).`,
  },
  {
    label: 'dashboard-a11y-tooling',
    agentType: 'nextjs-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/dashboard/src/components/sidebar.tsx
- ${ROOT}/dashboard/src/components/delivery-table.tsx
- ${ROOT}/dashboard/src/app/settings/page.tsx
- ${ROOT}/dashboard/src/app/layout.tsx
- ${ROOT}/dashboard/package.json
- ${ROOT}/dashboard/tsconfig.json
- ${ROOT}/dashboard/eslint.config.mjs
- ${ROOT}/dashboard/src/app/manifest.ts   (NEW)

ITEMS:
- P2-30 (your subset: sidebar + delivery-table) — Keyboard a11y. Sidebar org picker: add Escape + outside-click close with focus return and aria-expanded. delivery-table rows: the expand/collapse \`<tr onClick>\` needs a focusable disclosure (a real <button> in the chevron cell, or row with role/button + tabIndex=0 + aria-expanded + Enter/Space handler). (The subscriptions export menu is owned by another agent.)
- P2-32 — Replace native \`window.confirm()\` in settings/page.tsx (member removal, api-key revoke) with the app's existing \`DeleteDialog\` (or a generic ConfirmDialog) + surface results via the existing \`toast()\`. Add a confirmation to the role change too. Import DeleteDialog/toast; do not reimplement them.
- P2-33 — Tooling: add a \`"typecheck": "tsc --noEmit"\` script to dashboard/package.json; bump tsconfig \`compilerOptions.target\` from ES2017 to ES2020; in eslint.config.mjs, instead of blanket-warning react-hooks rules, either re-enable them as errors or scope the relaxation narrowly (a comment explaining why). Do not add deps.
- P2-34 — PWA: add \`dashboard/src/app/manifest.ts\` (Next metadata route) with name/short_name/icons(reuse existing public icons if any)/theme_color/background_color/display, and add a \`viewport\`/\`themeColor\` export (or metadata) in layout.tsx. If you'd rather declare installability a non-goal, instead add a short justifying comment in layout.tsx near the service-worker registration — but completing the manifest is preferred.

Keep TS strict-clean; match existing component/styling patterns (Tailwind etc.).`,
  },
  {
    label: 'docs-readme',
    agentType: 'backend-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/README.md
- ${ROOT}/docs/ARCHITECTURE.md   (NEW)

ITEM P2-23 — The README still describes the pre-outbox SYNCHRONOUS flow ("...stores it in PostgreSQL and Redis, and sends an event to Kafka") and omits the outbox, pending_retries, update_events topic, multi-tenancy (orgs/quotas/rate-limit), notification persistence, and the internal metrics server. Refresh the README architecture/flow sections to match the real implementation (read src/lib/outbox.js, src/webhook-dispatcher/index.js, src/subscription-management/{app,index}.js, the migrations, and docs/CODEBASE-ASSESSMENT.md to ground every claim). Specifically:
- Document the real delivery guarantee: at-least-once with best-effort/DB-enforced dedup (NOT exactly-once/ordered).
- Describe the transactional outbox -> dispatcher drainer -> Kafka -> delivery + pending_retries retry ladder + DLQ flow.
- Enumerate ALL Kafka topics including update_events; list the three per-service entry points (subscription-management, subscription-connector, webhook-dispatcher index.js each).
- Note the connector single-pod caveat (until P1-2 lands) and the metrics server (internal 9090).
Create docs/ARCHITECTURE.md with a fuller architecture writeup + a couple of lightweight ADR-style notes (outbox decision, at-least-once+dedup decision). Keep claims accurate to the code — do not invent features.`,
  },
]

// ---------------------------------------------------------------------------
// WAVE 2 — Services (heavy files; consume Wave-1 helpers). Disjoint files.
// ---------------------------------------------------------------------------
const SERVICES = [
  {
    label: 'dispatcher',
    agentType: 'node-specialist',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/webhook-dispatcher/index.js
- ${ROOT}/src/webhook-dispatcher/outbox-drainer.js   (NEW — extracted module)

Wave-1 already created ${ROOT}/src/lib/ssrf-guard.js and ${ROOT}/migrations added a \`processed_events\` table — READ both and use them.

ITEMS (all in webhook-dispatcher):
- P1-3 — Make webhook delivery concurrent + lower timeout. The consumer uses \`eachMessage\` with no \`partitionsConsumedConcurrently\`, and a 30s axios timeout → one slow endpoint head-of-line-blocks everything (~5/s). FIX: set \`partitionsConsumedConcurrently\` on consumer.run to the partition count (env KAFKA_PARTITIONS, default 8); add a small inline bounded-concurrency pool (NO new deps — write a tiny \`pLimit(n)\` helper) for the outbound POSTs with SAFE offset commits (only commit offsets for fully-handled messages); cut the webhook axios timeout to env WEBHOOK_TIMEOUT_MS default 8000 (8s).
- P1-4 (code half) — Atomic idempotency via the new \`processed_events\` table: replace the SELECT-then-act dedup with \`INSERT INTO processed_events (subscription_id, event_id, organization_id) VALUES (...) ON CONFLICT DO NOTHING RETURNING 1\`. If no row returned → already processed → skip delivery. Keep delivery_events recording behavior (it still gets one row per attempt). This makes dedup a DB-enforced atomic gate even under rebalance double-delivery.
- P0-4 (dispatcher half) — Before every outbound \`axios.post(webhookUrl, ...)\`, build config via ssrf-guard's \`guardedAxiosConfig(webhookUrl, baseCfg)\` (resolve+validate+pin + \`maxRedirects:0\`); if it throws SsrfBlocked, treat as a hard delivery failure (record failure, do NOT enqueue infinite retries — fail into DLQ/failed) and log. This closes the create-time-only SSRF (TOCTOU/redirect-to-IMDS) at send time.
- P2-3 — Close the DLQ loop: add an exported \`redriveDlqEvent(message)\` that re-enqueues a dlq_events payload into pending_retries (reset retry_count), and add a \`dlq_events\` lag/size Prometheus gauge. (The notification WORDING fix is owned by the notifications agent.) A full standalone dlq consumer is optional; the redrive function + gauge is the required minimum.
- P2-6 (dispatcher half) — Demote per-delivery/per-message \`info\` logs that serialize payloads down to \`debug\`; keep lifecycle (connect/disconnect/DLQ) at info. Never JSON.stringify a payload at info.
- P1-8 (dispatcher producer half) — Configure the Kafka producer used for outbox draining with \`acks: 'all'\`, \`idempotent: true\`, a sane \`maxInFlightRequests\`, and compression via env (P2-15).
- P2-1 (this entrypoint) — Add \`process.on('unhandledRejection', ...)\` (log) and \`process.on('uncaughtException', ...)\` (log + orderly shutdown) wired to the existing graceful-shutdown path.
- P2-18 — Extract the outbox drainer (pollOutbox + its claim/publish/mark/failure logic) into NEW outbox-drainer.js exporting \`startOutboxDrainer({...deps})\`/\`stop\`, imported and started by index.js. Pure refactor — SAME runtime (still started by the dispatcher process); improves cohesion. Don't change its behavior.

TESTABILITY: export the pure functions a Wave-3 test suite will exercise: handleConnectionEvent, sendWebhook, enqueueRetry, processClaimedRetry, claimDueRetries, and the outbox drainer's claim/deliver step. Keep the runtime wiring intact.

This is a large file — be systematic, preserve every existing behavior not explicitly changed, and keep the manual-commit/idempotency/GREATEST-guard semantics intact.`,
  },
  {
    label: 'connector',
    agentType: 'node-specialist',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/subscription-connector/index.js
- ${ROOT}/src/subscription-connector/handlers/baseHandler.js
- ${ROOT}/src/subscription-connector/handlers/graphqlHandler.js
- ${ROOT}/src/subscription-connector/handlers/webSocketHandler.js

Wave-1 created ${ROOT}/src/lib/ssrf-guard.js — READ and use it. Do NOT touch reconnect.js (its tests must stay green) unless strictly necessary; if you must, note it.

ITEMS:
- P1-2 — Shard upstream connections by partition ownership. \`reloadActiveSubscriptions()\` runs on EVERY pod and SCANs all \`sub:*\` then connects to every subscription → N-fold duplicate upstream connections when scaled. FIX: connect only to subscriptions whose \`subscriptionId\` maps to a Kafka partition currently assigned to THIS pod. Use kafkajs consumer group assignment (listen to \`consumer.events.GROUP_JOIN\` / the GROUP_JOIN payload's memberAssignment to learn owned partitions for the relevant topic; recompute owned set on each rebalance) and a partitioner consistent with how events are keyed (key = subscriptionId; mirror kafkajs default murmur2 partitioning against KAFKA_PARTITIONS). On rebalance, connect newly-owned and disconnect no-longer-owned subscriptions. If assignment isn't yet available at startup, defer the reload until the first GROUP_JOIN. Add a per-instance open-connection Prometheus gauge. Also CAP concurrent reconnects on reload with a tiny inline \`pLimit(n)\` (no new deps) to avoid a thundering reconnect storm. Depends on P1-1 (already done in compose). If full partition-ownership proves infeasible to do safely, implement the concurrency cap + open-connection gauge + a clear single-pod-constraint log/comment and mark this PARTIAL.
- P1-10 — Connector Postgres fallback on Redis miss. \`reloadActiveSubscriptions()\`/\`handleMessage()\` read subscription config ONLY from Redis; a flush/eviction silently darkens all connections. FIX: on startup and on a Redis miss, read the subscription row from Postgres and re-warm Redis (mirror the dispatcher's processClaimedRetry fallback). Treat a true not-found (absent in PG too) as "unsubscribe"; a Redis-only miss must NOT drop a live subscription. You'll need the pg pool available to the connector (wire it in index.js if not already).
- P0-4 (connector handlers half) — graphqlHandler/webSocketHandler open connections to \`args.endpoint_url\` with NO SSRF check at connect time. Before opening, call ssrf-guard \`assertConnectAllowed(endpoint_url)\` and refuse on block; where the ws/graphql-ws client supports a custom http/https \`agent\`, pass ssrf-guard's safe pinned agent.
- P2-17 — Connector graceful shutdown must drain upstream sockets. \`BaseHandler.disconnect()\` is a no-op stub; \`shutdown()\` abandons upstream sockets to the 10s force-exit. Implement a real close/drain: iterate connectionHandlers, close upstream ws/graphql sockets (await graceful close frames within the force-exit budget) BEFORE disconnecting Kafka/Redis. Track active connections per handler so shutdown can await them.
- P2-6 (connector handlers half) — Demote the per-message full-payload \`info\` logs (webSocketHandler logs decodedMessage; graphqlHandler logs JSON.stringify(data) per "next") to \`debug\`; keep counts/lifecycle at info.
- P2-15 (connector half) — \`raiseConnectionEvent\`/the connector producer: enable compression (env codec) and allow batching rather than awaiting each single-message send in lockstep where safe.
- P1-8 (connector producer half) — producer config \`acks:'all'\` + \`idempotent:true\` + maxInFlight cap.
- P2-1 (this entrypoint) — add process unhandledRejection/uncaughtException handlers wired to graceful shutdown.

Preserve the manual-commit-even-on-error contract (prevents partition lockup), the \`sub:*\` SCAN-prefix filter, event_type filtering, and reconnect wiring. Keep handler public methods stable so reconnect.test.js stays green.`,
  },
  {
    label: 'mgmt-app',
    agentType: 'backend-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/subscription-management/app.js

ITEMS:
- P0-2 (CONFIRMED BUG) — \`createApp()\` calls \`dispatchNotification({...})\` inside \`notifyQuotaWarning\` (~line 191) but app.js never imports it → ReferenceError, swallowed → quota-warning notifications silently never fire. FIX: add \`const { dispatchNotification } = require('../lib/notifications');\` (verify the export name in src/lib/notifications.js). Ensure the notifyQuotaWarning wiring actually reaches a transport.
- P1-5 (app half) — The org-wide \`/deliveries/stats\` aggregate (~lines 490-522) has NO time bound → full-table scan that worsens with tenant age. FIX: bound the summary to a window (e.g. last 30 days) so it uses the covering index a Wave-1 migration added \`(organization_id, created_at DESC, status)\`; keep the 24h/7d figures but compute them within the bounded window. Don't change the response shape pages depend on (or keep it backward-compatible).
- P2-4 — Redact/remove \`webhook_secret\` from the admin \`/redis\` and \`/redis/:key\` dumps. The cache stores full rows incl. webhook_secret and \`withoutSecret()\` isn't applied there → admin key can read every tenant's signing secret. Apply a redaction (reuse/extend \`withoutSecret\`) to any value returned from these endpoints; never return webhook_secret after creation. (Optionally gate the bulk dump behind a NODE_ENV!=production check — note if you do.)
- P2-19 — Bound/validate \`args.headers\` in \`validateSubscriptionInput\` (~lines 59-87): require an object of string->string, bounded count and total bytes, reject non-string values, before they're spread into outbound ws/axios. Add a clear 400 on violation.
- P2-7 (app/bulk half) — In \`/subscribe/bulk\`, batch the up-to-100 INSERTs (multi-row VALUES) and pipeline the Redis SETs instead of serial round-trips while holding the advisory lock; shorten the lock hold. Keep correctness (per-row validation, quota) intact. (The quotas.js lock-hold change is owned by another agent — coordinate by using the same lock key/namespace exported from quotas.js.)
- P2-6 (app half) — demote any per-request payload-serializing info logs here to debug.

This is a large file. Preserve all routes, auth, multi-tenant WHERE filters, and existing tests (integration suites use supertest against createApp). Match style.`,
  },
  {
    label: 'mgmt-index',
    agentType: 'devops-engineer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/subscription-management/index.js
- ${ROOT}/scripts/                         (you may ADD a migrate helper script here if useful; don't edit unrelated scripts)

ITEMS:
- P0-1 / P1-9 (code half) — Decouple migrations from app boot. Currently \`applyMigrations()\` (~lines 108-121) shells \`npm run migrate\` during startup (~line 163) and \`process.exit(1)\` on failure (~171-174) — this crash-loops the pruned production image and races across multi-pod boots. FIX: make boot NOT run migrations by default. Introduce an env flag (e.g. \`RUN_MIGRATIONS_ON_BOOT\`, default false in production) so the app assumes the schema is current; migrations run via the dedicated one-shot compose \`migrate\` service / CI job (added by other agents) using \`npx node-pg-migrate up\`. If RUN_MIGRATIONS_ON_BOOT is true (dev convenience), keep the current behavior but call \`npx node-pg-migrate up\` (works whether or not it's a devDep). Add a startup readiness check that fails fast with a CLEAR message if a critical expected table is missing (so a forgotten migration is obvious without crash-looping silently).
- P1-8 (mgmt producer + topic half) — The producer here and \`createKafkaTopics()\` (~line 123-148, RF default 1 at ~134): configure the producer with \`acks:'all'\` + \`idempotent:true\`; keep RF/partitions env-driven and document the prod RF>=3 expectation in a comment. Don't break single-node dev.
- P2-1 (this entrypoint) — add \`process.on('unhandledRejection')\` + \`process.on('uncaughtException')\` wired to the existing graceful shutdown.

Keep the liveness/readiness split and graceful-shutdown behavior intact. Don't touch app.js (another agent owns it) — only index.js wiring.`,
  },
  {
    label: 'notifications',
    agentType: 'backend-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/src/lib/notifications.js

Wave-1 created ${ROOT}/src/lib/ssrf-guard.js — READ and use it.

ITEMS:
- P0-4 (notifications half) — \`sendSlackNotification\` does \`axios.post(pref.destination, ...)\` with no \`maxRedirects\` cap (follows up to 5) and no connect-time SSRF check → a 302 to 169.254.169.254 exfiltrates IMDS creds. FIX: route the Slack/webhook outbound through ssrf-guard's \`guardedAxiosConfig(destination, baseCfg)\` (resolve+validate+pin + maxRedirects:0); reject private/IMDS destinations.
- P2-3 (wording half) — The DLQ notification text claims the event "has been published to the dlq_events Kafka topic for downstream processing." Since the redrive is now an explicit admin action (the dispatcher agent adds redriveDlqEvent + a gauge), correct/soften the wording to accurately describe that it's parked in the DLQ awaiting operator redrive (don't over-promise automatic downstream processing).
- P2-6 / P2-20 prep — Ensure \`dispatchNotification\` and \`pollNotificationAttempts\` don't log secrets/full payloads at info; keep the persistence/retry state machine intact and EXPORT the functions a Wave-3 test will exercise (dispatchNotification channel fan-out, pollNotificationAttempts backoff/terminal) if they aren't already exported.

Keep formatSlackPayload/formatEmailBody and all existing exports + behavior stable (tests/lib/notifications.test.js must stay green). Match style.`,
  },
]

// ---------------------------------------------------------------------------
// WAVE 3 — Tests + coverage gate + dashboard e2e. Depend on Wave-2 code.
// ---------------------------------------------------------------------------
const TESTS = [
  {
    label: 'tests-dispatcher',
    agentType: 'test-automator',
    prompt: `${SHARED}

YOUR FILES (exclusive — create NEW test files; you OWN the whole tests/webhook-dispatcher/ dir):
- ${ROOT}/tests/webhook-dispatcher/*.test.js  (NEW)

Read src/webhook-dispatcher/index.js + src/webhook-dispatcher/outbox-drainer.js (just modified in Wave 2 — they now EXPORT pure functions) and tests/integration/setup.js (reuse its in-memory Redis stub / fakeEmailTransport / no-op Kafka patterns; mock pg/redis/axios/producer).

ITEMS:
- P1-6 (dispatcher half) — Cover the delivery/retry/DLQ/idempotency engine with mocks: success records status='success'; first-failure enqueues a retry; the backoff ladder [15,60,120,360,720,1440]; idempotency skip when processed_events already has the row (ON CONFLICT path); retrying→dlq at retryCount===maxRetries; the GREATEST(retry_count) clobber-guard; the subscription-deleted-mid-retry 'failed' branch; the truncated-body 'cannot parse → DLQ' branch; Redis-miss → Postgres-fallback → re-warm; the outbox drainer claim/deliver/mark + failure paths. Mock axios for 200/500/timeout/connection-refused.
- P2-21 — Dispatcher send-time SSRF test: assert a cached subscription whose webhook_url resolves to a private/IMDS address is NOT delivered (mock dns/ssrf-guard to force a private resolution) and is recorded as failed/DLQ rather than POSTed.

Use jest. Keep tests deterministic and DB-free (pure unit, injected mocks) so they run without a live Postgres. If a function isn't exported, note it as a risk rather than editing src.`,
  },
  {
    label: 'tests-connector',
    agentType: 'test-automator',
    prompt: `${SHARED}

YOUR FILES (exclusive — you OWN tests/connector/ except the existing reconnect.test.js which you may extend but not break):
- ${ROOT}/tests/connector/*.test.js  (NEW handler/consumer tests; keep reconnect.test.js green)

Read src/subscription-connector/index.js + handlers/{baseHandler,graphqlHandler,webSocketHandler}.js (modified in Wave 2). Use an EventEmitter stub for the ws/graphql-ws client.

ITEM P1-6 (connector half) — Cover: handleMessage topic dispatch + graceful-return branches; the manual-commit-even-on-error contract; \`reloadActiveSubscriptions\` only touches \`sub:*\` keys (not rate-limit counters); WebSocketHandler event_type filtering (non-matching dropped vs matching calls raiseConnectionEvent); intentionalClose vs unexpected-close→_scheduleReconnect wiring; constructor-throw → schedule-retry; baseHandler.raiseConnectionEvent generates the eventId the dispatcher idempotency depends on; GraphQLHandler disconnect-before-reconnect; the new P1-10 Postgres-fallback-on-Redis-miss path; and (if implemented) the P1-2 partition-ownership filter.

Deterministic, DB-free unit tests with injected mocks. Note any unexported function as a risk instead of editing src.`,
  },
  {
    label: 'tests-notif-quota',
    agentType: 'test-automator',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/tests/lib/notifications.test.js   (EXTEND — keep existing format-helper tests green)
- ${ROOT}/tests/lib/quotas-advisory.test.js (NEW)

ITEMS:
- P2-20 — Notification persistence/retry state-machine tests in notifications.test.js: drive an attempt through transient-failure → backoff retry scheduled with next ladder step → success clears it; failure past max_attempts → terminal/dlq. Cover dispatchNotification fan-out: only channels present in notification_preferences are attempted; a thrown channel error is swallowed (best-effort). Use the harness's fakeEmailTransport + a mock pool (see tests/integration/setup.js patterns).
- P0-3 regression (new quotas-advisory.test.js) — assert the subscription-quota path unlocks with the SAME key it locks with: with a pool stub that DISTINGUISHES lock vs unlock SQL/args, prove \`pg_advisory_unlock\` is called with \`hashtext($2::text)\` (not the raw UUID) and returns true — i.e. no leaked lock after a 2xx. (This is the regression test for the confirmed P0-3 fix.)

Deterministic, DB-free. jest.`,
  },
  {
    label: 'coverage-gate',
    agentType: 'test-automator',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/jest.config.js   (add coverageThreshold ONLY; another agent already broadened collectCoverageFrom — keep it)

ITEM P1-7 (gate half) — Add a \`coverageThreshold\` to jest.config.js wired as a hard gate. Calibrate it to be a RATCHET, not a breakage: set the global floor a few points BELOW realistic current coverage now that dispatcher/connector/notification tests exist (e.g. global: { lines: 35, statements: 35, branches: 25, functions: 30 } as a starting safe floor) and a HIGHER per-directory floor for \`src/lib\` (e.g. lines 70). Do NOT set floors so high that CI fails on the current tree — if unsure, you MAY run \`npx jest --coverage --coverageReporters=text-summary\` (this is the one exception to the no-test-run rule, read-only, to read the numbers) and set each floor ~5 points under the measured value. Keep everything else in jest.config.js intact.`,
  },
  {
    label: 'tests-dashboard-e2e',
    agentType: 'nextjs-developer',
    prompt: `${SHARED}

YOUR FILES (exclusive):
- ${ROOT}/dashboard/e2e/*.spec.ts  (NEW specs only; don't edit existing specs)

ITEM P2-22 — Add Playwright specs for the negative/auth flows the backend enforces, reusing the existing \`page.route\` mocking pattern from the current specs (read dashboard/e2e/ to match style/config): SSRF 400 on subscription create, quota 429 handling, expired-session (401) mid-session redirect to /login, org-switch, and api-key create/revoke lifecycle. Mock all backend responses (no live backend). Keep them aligned with the existing Playwright config so \`npx playwright test\` would discover them. Do not modify playwright.config or existing specs.`,
  },
]

// ---------------------------------------------------------------------------
// Drive the waves: barrier between waves (true dependency), parallel within.
// ---------------------------------------------------------------------------
function runLane(lane, phaseName) {
  return agent(lane.prompt, {
    label: lane.label,
    phase: phaseName,
    agentType: lane.agentType,
    model: 'opus', // honor the user's explicit request: run every workflow agent on Opus
    schema: SCHEMA,
  }).then((r) => ({ lane: lane.label, result: r })).catch((e) => ({ lane: lane.label, error: String(e && e.message || e) }))
}

phase('Foundation')
log(`Wave 1 — Foundation: ${FOUNDATION.length} file-disjoint agents`)
const wave1 = await parallel(FOUNDATION.map((l) => () => runLane(l, 'Foundation')))

phase('Services')
log(`Wave 2 — Services: ${SERVICES.length} agents (consume Wave-1 helpers: ssrf-guard, processed_events)`)
const wave2 = await parallel(SERVICES.map((l) => () => runLane(l, 'Services')))

phase('Tests')
log(`Wave 3 — Tests: ${TESTS.length} agents (depend on Wave-2 code)`)
const wave3 = await parallel(TESTS.map((l) => () => runLane(l, 'Tests')))

return {
  wave1,
  wave2,
  wave3,
}
