const {
  formatSlackPayload,
  formatEmailBody,
  dispatchNotification,
  pollNotificationAttempts,
  recordAttempt,
  NOTIFICATION_RETRY_INTERVALS,
  NOTIFICATION_MAX_ATTEMPTS,
} = require('../../src/lib/notifications');

describe('formatSlackPayload', () => {
  it('produces a text + blocks payload', () => {
    const out = formatSlackPayload({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
      organizationName: 'Acme Inc',
    });
    expect(out.text).toContain('aaaaaaaa');
    expect(out.blocks).toHaveLength(1);
    expect(out.blocks[0].type).toBe('section');
    expect(out.blocks[0].text.type).toBe('mrkdwn');
    expect(out.blocks[0].text.text).toContain('Subscription:');
    expect(out.blocks[0].text.text).toContain('Webhook URL:');
    expect(out.blocks[0].text.text).toContain('Acme Inc');
  });

  it('omits the organization line when not provided', () => {
    const out = formatSlackPayload({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
    });
    expect(out.blocks[0].text.text).not.toContain('Organization:');
  });
});

describe('formatEmailBody', () => {
  it('includes the subscription id, webhook url, and event id', () => {
    const out = formatEmailBody({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
      organizationName: 'Acme Inc',
    });
    expect(out).toContain('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(out).toContain('https://hooks.example.com/in');
    expect(out).toContain('11111111-1111-1111-1111-111111111111');
    expect(out).toContain('Organization: Acme Inc');
  });

  it('omits the Organization line when not provided', () => {
    const out = formatEmailBody({
      subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      webhookUrl: 'https://hooks.example.com/in',
      eventId: '11111111-1111-1111-1111-111111111111',
    });
    expect(out).not.toContain('Organization:');
  });
});

/* ------------------------------------------------------------------------- *
 * P2-20 — notification persistence / retry state-machine + dispatch fan-out.
 *
 * Deterministic + DB-free. We drive the two wire-touching entry points
 * (dispatchNotification, pollNotificationAttempts) through a mock pg pool that
 * records every query so we can assert the persisted state machine:
 *   transient-failure -> backoff retry scheduled at the NEXT ladder step
 *     -> success clears it; failure past max_attempts -> terminal/dlq.
 * The single wire seam (sendOnWire) routes 'email' through emailTransport.send
 * and 'slack' through the HTTP path, so a programmable fakeEmailTransport (the
 * harness pattern from tests/integration/setup.js) lets us script outcomes
 * without real SMTP / network. Slack/channel-error fan-out uses a transport
 * whose send() throws, proving a thrown channel error is swallowed.
 * ------------------------------------------------------------------------- */

const ORG = 'org-7777';

/**
 * Programmable email transport mirroring the integration harness's
 * fakeEmailTransport, but the per-call outcome is scripted via a queue so a
 * single test can drive transient-failure-then-success. Captures calls.
 *
 *   results: array of { delivered, ... } returned in order; the LAST entry
 *            is reused once the queue is drained (steady state).
 *   throwOn: if true, send() throws (a channel error) instead of returning.
 */
function scriptedEmailTransport({ results = [{ delivered: true }], throwOn = false } = {}) {
  const calls = [];
  let i = 0;
  return {
    enabled: true,
    from: 'noreply@anyhook.test',
    calls,
    async send(args) {
      calls.push(args);
      if (throwOn) throw new Error('transport blew up');
      const idx = Math.min(i, results.length - 1);
      i += 1;
      return results[idx];
    },
  };
}

/**
 * Mock pg pool that records queries and serves canned rows for the two SELECTs
 * the notification code issues:
 *   - the notification_preferences lookup in dispatchNotification
 *   - the claim CTE in pollNotificationAttempts (returns `claimRows`)
 * INSERT/UPDATE/sweep statements are recorded (with params) and acked.
 * `failOn(predicate)` lets a test force a specific statement to reject.
 */
function makeMockPool({ prefRows = [], claimRows = [] } = {}) {
  const queries = [];
  let failPredicate = null;
  const pool = {
    queries,
    failOn(pred) {
      failPredicate = pred;
    },
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (failPredicate && failPredicate(sql, params)) {
        throw new Error('forced query failure');
      }
      if (/FROM notification_preferences/.test(sql)) {
        return { rows: prefRows, rowCount: prefRows.length };
      }
      if (/UPDATE notification_attempts n\s+SET locked_at = NOW\(\)/.test(sql)) {
        // The claim CTE.
        return { rows: claimRows, rowCount: claimRows.length };
      }
      // INSERT, status-UPDATE, stale-lock sweep, unlock-on-error: all ack.
      return { rows: [], rowCount: 0 };
    },
  };
  return pool;
}

const find = (pool, re) => pool.queries.filter(q => re.test(q.sql));
const inserts = pool => find(pool, /INSERT INTO notification_attempts/);
const statusUpdates = pool => find(pool, /UPDATE notification_attempts\s+SET status = \$1/);

describe('recordAttempt — synchronous persistence + retry scheduling', () => {
  const emailPref = { id: 'pref-1', channel: 'email', destination: 'ops@example.com' };
  const event = { subscriptionId: 'sub-1', eventId: 'evt-1', organizationName: 'Acme' };

  it('persists a delivered attempt with no next_attempt_at', async () => {
    const pool = makeMockPool();
    await recordAttempt(
      pool,
      emailPref.id,
      ORG,
      emailPref.channel,
      emailPref.destination,
      'dlq',
      event,
      { delivered: true, status: 200 }
    );
    const ins = inserts(pool);
    expect(ins).toHaveLength(1);
    const p = ins[0].params;
    // VALUES order: org, prefId, channel, destination, eventName, payload,
    //   status, attempts, last_error, next_attempt_at
    expect(p[0]).toBe(ORG);
    expect(p[1]).toBe('pref-1');
    expect(p[6]).toBe('delivered');
    expect(p[7]).toBe(1); // first attempt
    expect(p[8]).toBeNull(); // no error
    expect(p[9]).toBeNull(); // delivered → not scheduled for retry
  });

  it('schedules the FIRST ladder step on a transient failure', async () => {
    const pool = makeMockPool();
    const before = Date.now();
    await recordAttempt(pool, emailPref.id, ORG, 'email', emailPref.destination, 'dlq', event, {
      delivered: false,
      reason: 'smtp_error',
      error: 'connection reset',
    });
    const p = inserts(pool)[0].params;
    expect(p[6]).toBe('failed');
    expect(p[7]).toBe(1);
    expect(p[8]).toBe('connection reset'); // last_error prefers .error
    // next_attempt_at ≈ now + INTERVALS[0] minutes (the first ladder step).
    const next = p[9];
    expect(next).toBeInstanceOf(Date);
    const deltaMin = (next.getTime() - before) / 60_000;
    expect(deltaMin).toBeGreaterThanOrEqual(NOTIFICATION_RETRY_INTERVALS[0] - 0.05);
    expect(deltaMin).toBeLessThanOrEqual(NOTIFICATION_RETRY_INTERVALS[0] + 0.5);
  });

  it('falls back to reason then "unknown" for last_error', async () => {
    const pool = makeMockPool();
    await recordAttempt(pool, emailPref.id, ORG, 'email', emailPref.destination, 'dlq', event, {
      delivered: false,
      reason: 'no_transport',
    });
    expect(inserts(pool)[0].params[8]).toBe('no_transport');
  });

  it('swallows a DB error while recording (best-effort, no throw)', async () => {
    const pool = makeMockPool();
    pool.failOn(sql => /INSERT INTO notification_attempts/.test(sql));
    await expect(
      recordAttempt(pool, emailPref.id, ORG, 'email', emailPref.destination, 'dlq', event, {
        delivered: true,
      })
    ).resolves.toBeUndefined();
  });
});

describe('pollNotificationAttempts — retry state machine over the ladder', () => {
  function claimedRow(overrides = {}) {
    return {
      id: 'na-1',
      preference_id: 'pref-1',
      channel: 'email',
      destination: 'ops@example.com',
      event_name: 'dlq',
      payload: { subscriptionId: 'sub-1', eventId: 'evt-1' },
      status: 'failed',
      attempts: 1,
      ...overrides,
    };
  }

  it('returns 0 and issues no status UPDATE when nothing is due', async () => {
    const pool = makeMockPool({ claimRows: [] });
    const n = await pollNotificationAttempts({
      pool,
      emailTransport: scriptedEmailTransport(),
      workerId: 'w1',
    });
    expect(n).toBe(0);
    expect(statusUpdates(pool)).toHaveLength(0);
    // Stale-lock sweep still fires (fire-and-forget) — it's a separate UPDATE.
    expect(
      find(pool, /SET locked_at = NULL, locked_by = NULL\s+WHERE locked_at IS NOT NULL/)
    ).toHaveLength(1);
  });

  it('transient failure on a retry re-schedules at the NEXT ladder step', async () => {
    // Row already at attempts=1 (its initial send failed). The poller retries;
    // it should fail again, bump to attempts=2, stay 'failed', and schedule
    // next_attempt_at at INTERVALS[1] (the SECOND ladder step — idx=nextAttempts-1).
    const pool = makeMockPool({ claimRows: [claimedRow({ attempts: 1 })] });
    const transport = scriptedEmailTransport({
      results: [{ delivered: false, reason: 'smtp_error' }],
    });
    const before = Date.now();
    const n = await pollNotificationAttempts({ pool, emailTransport: transport, workerId: 'w1' });

    expect(n).toBe(1);
    const upd = statusUpdates(pool);
    expect(upd).toHaveLength(1);
    const p = upd[0].params; // [status, attempts, last_error, next_attempt_at, id]
    expect(p[0]).toBe('failed');
    expect(p[1]).toBe(2); // attempts incremented
    expect(p[4]).toBe('na-1');
    const deltaMin = (p[3].getTime() - before) / 60_000;
    const expectMin = NOTIFICATION_RETRY_INTERVALS[1]; // 5m — the next rung
    expect(deltaMin).toBeGreaterThanOrEqual(expectMin - 0.05);
    expect(deltaMin).toBeLessThanOrEqual(expectMin + 0.5);
  });

  it('success on a retry clears the row (status=delivered, no next_attempt_at)', async () => {
    const pool = makeMockPool({ claimRows: [claimedRow({ attempts: 2 })] });
    const transport = scriptedEmailTransport({ results: [{ delivered: true, status: 200 }] });
    const n = await pollNotificationAttempts({ pool, emailTransport: transport, workerId: 'w1' });

    expect(n).toBe(1);
    const p = statusUpdates(pool)[0].params;
    expect(p[0]).toBe('delivered');
    expect(p[1]).toBe(3); // attempts still incremented for the audit trail
    expect(p[2]).toBeNull(); // last_error cleared on success
    expect(p[3]).toBeNull(); // delivered → no further retry scheduled
  });

  it('a failure that reaches max_attempts goes terminal → dlq (no next_attempt_at)', async () => {
    // attempts = MAX-1 (4); nextAttempts = 5 >= MAX → exhausted → 'dlq'.
    const pool = makeMockPool({
      claimRows: [claimedRow({ attempts: NOTIFICATION_MAX_ATTEMPTS - 1 })],
    });
    const transport = scriptedEmailTransport({
      results: [{ delivered: false, reason: 'smtp_error' }],
    });
    const n = await pollNotificationAttempts({ pool, emailTransport: transport, workerId: 'w1' });

    expect(n).toBe(1);
    const p = statusUpdates(pool)[0].params;
    expect(p[0]).toBe('dlq'); // terminal
    expect(p[1]).toBe(NOTIFICATION_MAX_ATTEMPTS);
    expect(p[3]).toBeNull(); // dlq is never retried again
  });

  it('caps the ladder index at the last interval for high attempt counts', async () => {
    // attempts=2 (below MAX-1=4) so it stays 'failed'; nextAttempts=3 →
    // idx=min(2, len-1)=2 → INTERVALS[2] (30m). Guards the Math.min clamp.
    const pool = makeMockPool({ claimRows: [claimedRow({ attempts: 2 })] });
    const transport = scriptedEmailTransport({ results: [{ delivered: false, reason: 'x' }] });
    const before = Date.now();
    await pollNotificationAttempts({ pool, emailTransport: transport, workerId: 'w1' });
    const p = statusUpdates(pool)[0].params;
    expect(p[0]).toBe('failed');
    const deltaMin = (p[3].getTime() - before) / 60_000;
    expect(deltaMin).toBeGreaterThanOrEqual(NOTIFICATION_RETRY_INTERVALS[2] - 0.05);
    expect(deltaMin).toBeLessThanOrEqual(NOTIFICATION_RETRY_INTERVALS[2] + 0.5);
  });

  it('a thrown wire error becomes a recorded failure, not an unhandled throw', async () => {
    const pool = makeMockPool({ claimRows: [claimedRow({ attempts: 1 })] });
    const transport = scriptedEmailTransport({ throwOn: true });
    const n = await pollNotificationAttempts({ pool, emailTransport: transport, workerId: 'w1' });
    expect(n).toBe(1);
    const p = statusUpdates(pool)[0].params;
    expect(p[0]).toBe('failed');
    expect(p[2]).toBe('transport blew up'); // exception message captured as last_error
  });

  it('unlocks the row when the status UPDATE itself fails', async () => {
    const pool = makeMockPool({ claimRows: [claimedRow({ attempts: 1 })] });
    pool.failOn(sql => /UPDATE notification_attempts\s+SET status = \$1/.test(sql));
    const transport = scriptedEmailTransport({ results: [{ delivered: true }] });
    const n = await pollNotificationAttempts({ pool, emailTransport: transport, workerId: 'w1' });
    expect(n).toBe(1);
    // Recovery path: an explicit unlock so the next poll re-claims the row.
    expect(find(pool, /SET locked_at = NULL, locked_by = NULL WHERE id = \$1/)).toHaveLength(1);
  });

  it('returns 0 without throwing when the claim query fails', async () => {
    const pool = makeMockPool({ claimRows: [claimedRow()] });
    pool.failOn(sql => /UPDATE notification_attempts n\s+SET locked_at = NOW\(\)/.test(sql));
    const n = await pollNotificationAttempts({
      pool,
      emailTransport: scriptedEmailTransport(),
      workerId: 'w1',
    });
    expect(n).toBe(0);
    expect(statusUpdates(pool)).toHaveLength(0);
  });
});

describe('dispatchNotification — channel fan-out (only configured channels; errors isolated)', () => {
  const payload = {
    subscriptionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    webhookUrl: 'https://hooks.example.com/in',
    eventId: 'evt-1',
  };

  it('returns [] and attempts nothing when the org has no matching preferences', async () => {
    const pool = makeMockPool({ prefRows: [] });
    const out = await dispatchNotification({
      pool,
      emailTransport: scriptedEmailTransport(),
      organizationId: ORG,
      eventName: 'dlq',
      payload,
    });
    expect(out).toEqual([]);
    expect(inserts(pool)).toHaveLength(0); // no attempt persisted
  });

  it('only attempts channels present in notification_preferences', async () => {
    // Org has a single email preference → exactly one send + one attempt row,
    // and the transport (the email seam) is the only wire touched.
    const pool = makeMockPool({
      prefRows: [
        {
          id: 'pref-email',
          channel: 'email',
          destination: 'ops@example.com',
          events: ['dlq'],
          organization_name: 'Acme',
        },
      ],
    });
    const transport = scriptedEmailTransport({ results: [{ delivered: true, messageId: '<1>' }] });
    const out = await dispatchNotification({
      pool,
      emailTransport: transport,
      organizationId: ORG,
      eventName: 'dlq',
      payload,
    });

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].to).toBe('ops@example.com');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'pref-email', channel: 'email', delivered: true });

    // Persisted exactly one attempt, attributed to the right pref/channel.
    const ins = inserts(pool);
    expect(ins).toHaveLength(1);
    expect(ins[0].params[1]).toBe('pref-email');
    expect(ins[0].params[2]).toBe('email');
    expect(ins[0].params[6]).toBe('delivered');
  });

  it('isolates a thrown channel error (best-effort) and still records the failed attempt', async () => {
    const pool = makeMockPool({
      prefRows: [
        {
          id: 'pref-email',
          channel: 'email',
          destination: 'ops@example.com',
          events: ['dlq'],
          organization_name: 'Acme',
        },
      ],
    });
    // The email transport throws — sendOnWire's caller must swallow it.
    const transport = scriptedEmailTransport({ throwOn: true });
    const out = await dispatchNotification({
      pool,
      emailTransport: transport,
      organizationId: ORG,
      eventName: 'dlq',
      payload,
    });

    // Did not throw; reported a non-delivery for that channel.
    expect(out).toHaveLength(1);
    expect(out[0].delivered).toBe(false);
    // And persisted a 'failed' attempt carrying the exception message.
    const ins = inserts(pool);
    expect(ins).toHaveLength(1);
    expect(ins[0].params[6]).toBe('failed');
    expect(ins[0].params[8]).toBe('transport blew up');
  });

  it('one channel throwing does not block the other (fan-out is isolated)', async () => {
    // Two prefs handled concurrently via Promise.allSettled: an email one that
    // throws (channel error must be swallowed) and a second channel that
    // resolves cleanly. We use an unrecognized channel for the second pref so
    // sendOnWire returns { delivered:false, reason:'unknown_channel' } with NO
    // network/DNS — keeping the test fully offline + deterministic. The email
    // throw must not prevent the other pref's result from being recorded.
    const pool = makeMockPool({
      prefRows: [
        {
          id: 'pref-other',
          channel: 'webhook', // not 'email'/'slack' → handled without IO
          destination: 'n/a',
          events: ['dlq'],
          organization_name: 'Acme',
        },
        {
          id: 'pref-email',
          channel: 'email',
          destination: 'ops@example.com',
          events: ['dlq'],
          organization_name: 'Acme',
        },
      ],
    });
    const transport = scriptedEmailTransport({ throwOn: true });
    const out = await dispatchNotification({
      pool,
      emailTransport: transport,
      organizationId: ORG,
      eventName: 'dlq',
      payload,
    });

    expect(out).toHaveLength(2);
    const byId = Object.fromEntries(out.map(r => [r.id, r]));
    expect(byId['pref-other'].delivered).toBe(false); // unknown_channel, no IO
    expect(byId['pref-other'].reason).toBe('unknown_channel');
    expect(byId['pref-email'].delivered).toBe(false); // threw, swallowed
    // Both attempts persisted (one INSERT per pref).
    expect(inserts(pool)).toHaveLength(2);
  });

  it('returns [] without throwing when the preference lookup fails', async () => {
    const pool = makeMockPool({ prefRows: [] });
    pool.failOn(sql => /FROM notification_preferences/.test(sql));
    const out = await dispatchNotification({
      pool,
      emailTransport: scriptedEmailTransport(),
      organizationId: ORG,
      eventName: 'dlq',
      payload,
    });
    expect(out).toEqual([]);
    expect(inserts(pool)).toHaveLength(0);
  });
});
