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
You are part of a VERIFICATION pass over fixes that were just applied. Inspect the CURRENT local code (use Read/Grep/Glob) and the git diff vs the last commit (\`git diff HEAD\`).
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

const TESTRUNNERS = [
  { label: 'test-backend-lint', suite: 'backend eslint', cmd: `cd ${WORKDIR} && npm run lint > /tmp/av-be-lint.log 2>&1; echo "EXIT:$?"; tail -n 80 /tmp/av-be-lint.log` },
  { label: 'test-backend-jest', suite: 'backend jest (unit+integration, needs Postgres)', cmd: `cd ${WORKDIR} && npm test > /tmp/av-be-jest.log 2>&1; echo "EXIT:$?"; tail -n 120 /tmp/av-be-jest.log` },
  { label: 'test-dashboard', suite: 'dashboard lint+typecheck+build+vitest', cmd: `cd ${WORKDIR}/dashboard && (npm run lint && npm run typecheck && npm run build && npx vitest run) > /tmp/av-dash.log 2>&1; echo "EXIT:$?"; tail -n 120 /tmp/av-dash.log` },
].map((c) => ({
  label: c.label, agentType: 'general-purpose', phase: 'Verify+Audit+Test', schema: TESTRUN_SCHEMA,
  prompt: `ROLE: HETZNER TEST RUNNER for "${c.suite}". The verify branch is already cloned + \`npm ci\`'d at ${WORKDIR} on the Hetzner box, with the data stack up and a .env in place.
Load the remote exec tool: call ToolSearch with query "select:mcp__hetzner-moelabs__exec", then invoke mcp__hetzner-moelabs__exec with this exact command:
${c.cmd}
Parse the output: the line "EXIT:N" is the suite's exit code (0 = pass). Return suite, passed (exitCode===0), exitCode, a concise list of distinct failures (test names / error lines), and the log tail. Do not edit any files. If the remote tool is unavailable, set passed=false, exitCode="unavailable" and say so in logTail.`,
}))

// ----- run -----
phase('Verify+Audit+Test')
log(`Phase 1 — ${VERIFIERS.length} fix-verifiers + ${AUDITORS.length} auditors + ${TESTRUNNERS.length} Hetzner test-runners, all in parallel`)
const lane = (c) => agent(c.prompt, { label: c.label, phase: c.phase, agentType: c.agentType, model: 'opus', schema: c.schema })
  .then((r) => ({ label: c.label, kind: c.schema === VERIFY_SCHEMA ? 'verify' : c.schema === AUDIT_SCHEMA ? 'audit' : 'test', result: r }))
  .catch((e) => ({ label: c.label, error: String((e && e.message) || e) }))

const phase1 = await parallel([...VERIFIERS, ...AUDITORS, ...TESTRUNNERS].map((c) => () => lane(c)))

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
