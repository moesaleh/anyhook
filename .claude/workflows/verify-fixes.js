export const meta = {
  name: 'verify-fixes',
  description: 'Parallel verifiers + auditors + Hetzner test-runners over the applied fixes, then synthesize defects and apply corrective fixes',
  phases: [
    { title: 'Verify+Audit+Test', detail: 'Parallel: per-group fix verifiers, adversarial auditors, and Hetzner test-runners' },
    { title: 'Synthesize', detail: 'Merge all findings + test failures into a deduped, file-grouped defect list' },
    { title: 'Fix', detail: 'Dynamic parallel corrective-fix agents, one per owning file' },
  ],
}

// args (passed at launch by the orchestrator):
//   { workdir, project, branch, env: {DATABASE_URL, REDIS_URL, KAFKA_BROKERS}, priorResults: {...}, planPath, assessmentPath }
const A = args || {}
const ROOT = 'C:/Labs/GithubClonedRepos/anyhook'
const WORKDIR = A.workdir || '/root/anyhook-verify'
const PLAN = A.planPath || `${ROOT}/docs/ASSESSMENT-FIX-PLAN.md`
const ASSESS = A.assessmentPath || `${ROOT}/docs/CODEBASE-ASSESSMENT.md`
const PRIOR = JSON.stringify(A.priorResults || {}, null, 2)

const COMMON = `Repo (local working tree, already edited by the fix workflow): ${ROOT}.
The fix plan is ${PLAN} and the rationale is ${ASSESS} — search them for item IDs.
You are part of a VERIFICATION pass over fixes that were just applied. Inspect the CURRENT local code (use Read/Grep/Glob) and the git diff of ALL the applied fixes vs the pre-fix baseline (\`git diff main\` — local branch \`main\` is the baseline commit before any fixes; the checked-out branch holds the fixes).
Hetzner test results captured by the orchestrator before this run (authoritative test signal):
${PRIOR}
Be precise and evidence-based: cite file:line. Do NOT edit files in this phase. Return ONLY the structured object.`

// ----- schemas -----
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'items'],
  properties: {
    summary: { type: 'string' },
    items: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence', 'issue'],
      properties: {
        id: { type: 'string' },
        status: { type: 'string', enum: ['implemented', 'partial', 'missing', 'incorrect'] },
        evidence: { type: 'string', description: 'file:line proving the verdict' },
        issue: { type: 'string', description: 'empty if fully implemented; else what is wrong/missing' },
      } } },
  },
}
const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['title', 'severity', 'file', 'line', 'issue', 'suggestedFix', 'confidence'],
      properties: {
        title: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'info'] },
        file: { type: 'string', description: 'repo-relative path of the file to change' },
        line: { type: 'string' },
        issue: { type: 'string' },
        suggestedFix: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      } } },
  },
}
const TESTRUN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['suite', 'passed', 'exitCode', 'logTail', 'failures'],
  properties: {
    suite: { type: 'string' },
    passed: { type: 'boolean' },
    exitCode: { type: 'string' },
    failures: { type: 'array', items: { type: 'string' } },
    logTail: { type: 'string' },
  },
}
const SYNTH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['greenlight', 'summary', 'defects'],
  properties: {
    greenlight: { type: 'boolean', description: 'true if no actionable defects remain (safe to commit)' },
    summary: { type: 'string' },
    defects: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['key', 'severity', 'file', 'description', 'suggestedFix'],
      properties: {
        key: { type: 'string' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        file: { type: 'string', description: 'the single repo-relative file whose edit fixes this defect' },
        description: { type: 'string' },
        suggestedFix: { type: 'string' },
      } } },
  },
}
const FIX_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['file', 'status', 'changes'],
  properties: {
    file: { type: 'string' },
    status: { type: 'string', enum: ['fixed', 'partial', 'skipped'] },
    changes: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
}

// ----- Phase 1 cohorts -----
const VERIFIERS = [
  { label: 'verify-P0', group: 'the 6 P0 blocker items (P0-1..P0-6)' },
  { label: 'verify-P1', group: 'the 10 P1 items (P1-1..P1-10)' },
  { label: 'verify-P2-backend', group: 'P2 backend/correctness/perf/security items: P2-1,2,3,4,5,6,7,15,18,19,24,25' },
  { label: 'verify-P2-data', group: 'P2 data-layer items: P2-11,12,13,16,26 (the new migrations) — also sanity-check P1-4/P1-5 schema halves' },
  { label: 'verify-P2-frontend', group: 'P2 dashboard items: P2-27,28,29,30,31,32,33,34' },
  { label: 'verify-tests', group: 'testing items: P1-6, P1-7, P2-20, P2-21, P2-22 (do the new test files exist and assert the right things?)' },
].map((c) => ({
  ...c, agentType: 'code-reviewer', phase: 'Verify+Audit+Test', schema: VERIFY_SCHEMA,
  prompt: `${COMMON}

ROLE: FIX VERIFIER. For ${c.group}, confirm each item is ACTUALLY implemented in the current code as the fix plan specifies. For every item return status implemented|partial|missing|incorrect with file:line evidence and a precise issue note when not fully done. Read the real code — do not trust comments. Flag anything that looks applied but is wrong (e.g. an import added but unused, a guard added but bypassable, a migration that won't run).`,
}))

const AUDITORS = [
  { label: 'audit-security', type: 'security-auditor', lens: 'SECURITY: SSRF guard (src/lib/ssrf-guard.js + dispatcher/connector/notifications wiring) — is resolve+pin+maxRedirects:0 actually enforced and not bypassable (rebinding, redirects, IPv6)? jwt placeholder rejection, .env hygiene, auth per-account throttle + XFF gating, webhook_secret redaction. Find real holes.' },
  { label: 'audit-correctness', type: 'code-reviewer', lens: 'CORRECTNESS: the confirmed bugs (P0-3 advisory unlock now uses hashtext on BOTH sides? P0-2 import wired to a transport?), dispatcher idempotency via processed_events ON CONFLICT, concurrency pool + safe offset commits, connector partition-ownership sharding + Postgres fallback, rate-limit atomic INCR+EXPIRE. Did any fix introduce a NEW bug, deadlock, or unhandled rejection?' },
  { label: 'audit-regression', type: 'code-reviewer', lens: 'REGRESSION: did any change break a public function signature, an existing test contract, an Express route shape, or DI wiring used by tests/integration/setup.js? Cross-check changed exports against their importers. Anything that would make a previously-green test fail.' },
  { label: 'audit-data', type: 'postgres-pro', lens: 'DATA/MIGRATIONS: the 7 new migrations — will they run in order without error on a populated DB? Reversibility, lock strength, composite-FK backfill validity, the TIMESTAMPTZ rewrite, processed_events shape, retention safety. Flag any migration that would fail or lock a table dangerously.' },
  { label: 'audit-frontend', type: 'nextjs-developer', lens: 'FRONTEND: TS strict correctness (would tsc --noEmit pass?), the new useVisiblePolling hook + loading/error routes, api.ts request<T> refactor preserving call sites, public-paths dedupe imported by both middleware and auth-context, a11y handlers, manifest. Find broken imports/types/runtime errors.' },
].map((c) => ({
  label: c.label, agentType: c.type, phase: 'Verify+Audit+Test', schema: AUDIT_SCHEMA,
  prompt: `${COMMON}

ROLE: ADVERSARIAL AUDITOR. Lens — ${c.lens}
Try to BREAK the fixes. Report concrete, actionable findings only (each with the exact file to change + a suggested fix). Prefer high-confidence defects over speculation; mark confidence honestly. Empty findings is a valid result if the work is clean.`,
}))

// REAL adversarial probe runners. The Hetzner box already has the verify branch
// cloned + npm ci'd at ${WORKDIR}, real Postgres (localhost:55432, db 'anyhook'),
// Redis (localhost:56379), Kafka (localhost:59092), schema migrated, and
// ${WORKDIR}/.env.test with all connection vars. Each agent runs on the REAL
// code against REAL infra (NOT mocks) and proves one item. Isolation: use a
// distinct DB name / Redis key prefix / Kafka topic+group prefix so probes
// don't collide when run in parallel.
const PROBE_ENV = `On the Hetzner box, every probe command must first cd + source env:
  cd ${WORKDIR} && set -a && . ./.env.test && set +a
Connection: DATABASE_URL (postgres @localhost:55432/anyhook), REDIS_URL (@localhost:56379), KAFKA_BROKERS (localhost:59092). psql: PGPASSWORD=postgres psql -h localhost -p 55432 -U postgres.
To migrate a FRESH isolated db: create it, then \`TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/<db> node -e "require('./tests/integration/global-setup')()"\`.
Write your probe script under ${WORKDIR}/verify-scenarios/<name>.js requiring the REAL ../src modules. Run with \`timeout 90 node verify-scenarios/<name>.js; echo EXIT:$?\` and capture to a log. NEVER mock the module under test — the whole point is real execution.`
const PROBE_RUNNERS = [
  { label: 'probe-ratelimit', isolation: 'Redis key prefix rlprobe:', prove: 'P2-2 atomic rate-limit. First READ ${WORKDIR}/src/lib/rate-limit.js to learn makeRateLimit/ipKeyFn signatures + the exact Redis key it writes. Then require the REAL rate-limit.js against the REAL Redis client (REDIS_URL). Fire the limiter through several requests and PROVE the counter key ALWAYS carries a TTL (redis PTTL > 0) immediately after the first increment — i.e. INCR+EXPIRE is atomic (Lua/MULTI/SET-NX), with no TTL-less window that would permanently lock an org. Also confirm it fails OPEN if Redis errors.' },
  { label: 'probe-data-integrity', isolation: 'fresh db av_data', prove: 'P1-4 + P2-11 + P2-12 on REAL Postgres. Create a fresh migrated db av_data. (a) IDEMPOTENCY: INSERT the same (subscription_id,event_id) into processed_events twice with ON CONFLICT DO NOTHING — prove exactly ONE row survives (the dedup gate is DB-enforced). (b) COMPOSITE FK: insert an org+subscription, then attempt a delivery_events row whose organization_id does NOT match the subscription owner — prove the composite FK REJECTS it (P2-11). (c) TIMESTAMPTZ: query information_schema.columns and prove subscriptions.created_at is timestamp WITH time zone (P2-12). Report each sub-result.' },
  { label: 'probe-quota-warning', isolation: 'fresh db av_quota', prove: 'P0-2 quota_warning actually fires (it was a ReferenceError before — dispatchNotification not imported). On a fresh migrated db, build the REAL app via require("./src/subscription-management/app").createApp with a real pg pool, the in-memory redis stub pattern from tests/integration/setup.js, AND a spy notifyQuotaWarning (or assert against the real dispatchNotification path). Register/seed an org with a low subscription limit, create subscriptions until it crosses the 80% warn threshold via the real /subscribe route (supertest), and PROVE the quota-warning dispatch path is invoked (spy called / a notification_attempts row written) — NOT a swallowed ReferenceError. If wiring an end-to-end supertest flow is too heavy, at minimum require app.js and assert dispatchNotification is in scope (no ReferenceError) by exercising notifyQuotaWarning directly.' },
  { label: 'probe-service-boot', isolation: 'no published ports needed', prove: 'P0-1 + P1-9 + P2-1: the services actually BOOT against real infra (the original P0-1 was a boot crash-loop). For EACH of src/subscription-management/index.js, src/webhook-dispatcher/index.js, src/subscription-connector/index.js: start it as a real process with the sourced env + RUN_MIGRATIONS_ON_BOOT=false, give it ~12s, and prove it reaches a connected/listening state WITHOUT crash-exiting (capture stdout/stderr; grep for "listening"/"connected" and for any uncaught throw or process.exit(1)). For subscription-management also curl its /health/live. Kill each after. Report per-service boot status + first error line if any.' },
  { label: 'probe-dispatcher-ssrf-e2e', isolation: 'Kafka topic/group prefix sse2e, Redis prefix sse2e:', prove: 'P0-4 send-time SSRF end-to-end through the REAL dispatcher (the generated dispatcher.test.js MOCKS ssrf-guard, so this is the only real proof). Seed a subscription whose webhook_url resolves to a private/IMDS address (e.g. http://127.0.0.1.nip.io:PORT/ pointing at a local listener) into Redis+PG, start a local HTTP listener on that port, drive a connection_event through the dispatcher delivery path, and PROVE the private listener is NEVER hit and the attempt is recorded failed/DLQ (not delivered). Kafka is up at localhost:59092 — if a full Kafka round-trip proves too fragile in the time budget, instead require the dispatcher\'s exported sendWebhook (with the REAL ssrf-guard, only pg/redis/producer mocked) and prove it refuses the private URL and never connects to the listener. Report which mode you used and the result.' },
].map((c) => ({
  label: c.label, agentType: 'general-purpose', phase: 'Verify+Audit+Test', schema: TESTRUN_SCHEMA,
  prompt: `ROLE: REAL ADVERSARIAL PROBE on the Hetzner box (load it first: ToolSearch "select:mcp__hetzner-moelabs__exec").
${PROBE_ENV}
Isolation for this probe: ${c.isolation}.
PROVE: ${c.prove}
Author a real probe script, run it on Hetzner, and report: suite=${c.label}, passed (true only if the property is genuinely demonstrated), exitCode, failures (specific), logTail (the decisive output). This is real execution — a mock of the thing under test = automatic FAIL. If infra is genuinely unavailable, passed=false + explain in logTail.`,
}))

// ----- run -----
phase('Verify+Audit+Test')
log(`Phase 1 — ${VERIFIERS.length} fix-verifiers + ${AUDITORS.length} auditors + ${PROBE_RUNNERS.length} real Hetzner probes, all in parallel`)
const lane = (c) => agent(c.prompt, { label: c.label, phase: c.phase, agentType: c.agentType, model: 'opus', schema: c.schema })
  .then((r) => ({ label: c.label, kind: c.schema === VERIFY_SCHEMA ? 'verify' : c.schema === AUDIT_SCHEMA ? 'audit' : 'test', result: r }))
  .catch((e) => ({ label: c.label, error: String((e && e.message) || e) }))

const phase1 = await parallel([...VERIFIERS, ...AUDITORS, ...PROBE_RUNNERS].map((c) => () => lane(c)))

// ----- Phase 2: synthesize -----
phase('Synthesize')
const synth = await agent(
  `${COMMON}

ROLE: SYNTHESIZER. Below is the raw output of all fix-verifiers, adversarial auditors, and Hetzner test-runners as JSON:

${JSON.stringify(phase1, null, 2)}

Produce the consolidated, DEDUPED defect list that must be fixed before commit. Rules:
- Include: any verifier item that is missing/incorrect/partial in a way that matters; any auditor finding of severity medium+ with high/medium confidence; every failing test suite (map each failure to the single file that must change).
- Drop: duplicates, speculation, low-confidence noise, and anything already passing.
- For EACH defect set "file" to the ONE repo-relative file whose edit resolves it (so fixes can run in parallel without write conflicts). If a defect needs multiple files, split it into multiple defects.
- Set greenlight=true ONLY if there are zero actionable defects and all test suites passed.
Return the SYNTH schema.`,
  { label: 'synthesize', phase: 'Synthesize', agentType: 'architect-reviewer', model: 'opus', schema: SYNTH_SCHEMA },
).catch((e) => ({ greenlight: false, summary: 'synthesis failed: ' + String((e && e.message) || e), defects: [] }))

// ----- Phase 3: dynamic parallel corrective fixes, grouped by owning file -----
const actionable = (synth.defects || []).filter((d) => d && d.file)
const byFile = {}
for (const d of actionable) { (byFile[d.file] = byFile[d.file] || []).push(d) }
const groups = Object.entries(byFile)

let fixes = []
if (groups.length === 0) {
  log('Phase 3 — no actionable defects; nothing to fix. ✅')
} else {
  phase('Fix')
  log(`Phase 3 — ${groups.length} corrective-fix agents (one per owning file), in parallel`)
  fixes = await parallel(groups.map(([file, ds]) => () =>
    agent(
      `${COMMON.replace('Do NOT edit files in this phase.', 'You MAY and SHOULD edit ONLY the one file below.')}

ROLE: CORRECTIVE FIX agent. You own EXACTLY this file (edit nothing else): ${file}
Apply minimal, correct fixes for these confirmed defects (do not regress anything else, keep style + existing tests in mind):
${ds.map((d, i) => `${i + 1}. [${d.severity}] ${d.description}\n   suggested: ${d.suggestedFix}`).join('\n')}
Read the file, make the edits, and return the FIX schema.`,
      { label: `fix:${file.split('/').pop()}`, phase: 'Fix', agentType: file.includes('dashboard/') ? 'nextjs-developer' : file.endsWith('.sql') ? 'postgres-pro' : 'node-specialist', model: 'opus', schema: FIX_SCHEMA },
    ).then((r) => ({ file, result: r })).catch((e) => ({ file, error: String((e && e.message) || e) })),
  ))
}

return {
  phase1,
  synthesis: synth,
  fixesApplied: fixes,
  greenlightBeforeFixes: !!synth.greenlight,
  defectCount: actionable.length,
}
