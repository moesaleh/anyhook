/**
 * P0-3 regression — subscription-quota advisory lock is released with the
 * SAME key it was acquired with.
 *
 * Background: `makeSubscriptionQuotaCheck` takes a SESSION-level
 * `pg_advisory_lock($1, hashtext($2::text))` on a dedicated pooled connection
 * to serialize an org's concurrent /subscribe count, then releases it once the
 * quota decision is made. The original bug released with
 * `pg_advisory_unlock($1, $2)` — passing the RAW org UUID as the int4 second
 * arg instead of `hashtext($2::text)`. The keys differed, `pg_advisory_unlock`
 * returned false, and because advisory locks are session-scoped the lock rode
 * back onto the pooled connection: after enough /subscribe calls every pooled
 * backend held an un-released org lock and the next acquire blocked forever
 * (silently disabling quota enforcement when it then failed open).
 *
 * tests/lib/quotas.test.js masks this — its stub treats ANY `pg_advisory_*`
 * SQL as a no-op, so lock and unlock are indistinguishable. This file uses a
 * pool stub that DISTINGUISHES lock vs unlock by SQL + args, and asserts:
 *   - unlock runs `pg_advisory_unlock($1, hashtext($2::text))` (NOT the raw
 *     UUID form) with the SAME (namespace, orgId) params as the lock, and
 *   - the stubbed `pg_advisory_unlock` returns TRUE (the lock was actually
 *     released), i.e. no session lock leaks onto the connection after a 2xx
 *     `/subscribe`.
 *
 * Deterministic + DB-free: no Postgres, no network. The SQL strings are the
 * contract this regression guards.
 */

const { makeSubscriptionQuotaCheck, ADVISORY_LOCK_KEY_QUOTAS } = require('../../src/lib/quotas');

const ORG_ID = '11111111-2222-3333-4444-555555555555';

/**
 * Pool stub that records every advisory-lock interaction on the single pooled
 * connection it hands out, and — crucially — answers `pg_advisory_unlock`
 * realistically: it returns TRUE only when the unlock key MATCHES a key that
 * was previously locked. The match is computed exactly the way Postgres would
 * pair the two: lock and unlock must agree on BOTH int4 args, where the second
 * arg is `hashtext(orgId)`.
 *
 * Because the test (like the real connection) never sees a numeric
 * `hashtext()` value, we model the matching on the SQL SHAPE: a call is a
 * `hashtext`-form lock/unlock iff its SQL contains `hashtext($2::text)`. A
 * unlock that passes the RAW UUID (the buggy form, `pg_advisory_unlock($1, $2)`
 * with no hashtext) therefore can NOT match a `hashtext`-form lock and the stub
 * returns FALSE — reproducing the leak the fix prevents.
 */
function makeRecordingPool() {
  const locks = []; // each: { fn:'lock'|'unlock', usesHashtext, key, orgArg, sql }
  const heldKeys = new Set(); // composite "key|hashtext(orgArg)" currently locked

  function classify(sql, params) {
    const usesHashtext = /hashtext\(\$2::text\)/.test(sql);
    const key = params[0];
    const orgArg = params[1];
    // Identity Postgres would use to pair lock/unlock. The second component is
    // the hashtext of the org id ONLY when the SQL actually wraps it; the buggy
    // raw-UUID unlock yields a different (non-hashtext) identity that can never
    // line up with the hashtext-form lock.
    const composite = `${key}|${usesHashtext ? `hashtext(${orgArg})` : `raw(${orgArg})`}`;
    return { usesHashtext, key, orgArg, composite };
  }

  const client = {
    async query(sql, params = []) {
      if (typeof sql === 'string' && sql.includes('pg_advisory_lock')) {
        const c = classify(sql, params);
        heldKeys.add(c.composite);
        locks.push({ fn: 'lock', sql, ...c });
        // pg_advisory_lock returns void; callers ignore the result.
        return { rows: [{}] };
      }
      if (typeof sql === 'string' && sql.includes('pg_advisory_unlock')) {
        const c = classify(sql, params);
        const released = heldKeys.delete(c.composite); // true iff a matching lock was held
        locks.push({ fn: 'unlock', sql, released, ...c });
        return { rows: [{ pg_advisory_unlock: released }] };
      }
      // The quota count query.
      return { rows: [{ used: 0, override: null }] };
    },
    release() {},
  };

  return {
    locks,
    heldKeys,
    async connect() {
      return client;
    },
    async query() {
      return { rows: [{ used: 0, override: null }] };
    },
  };
}

function mockReq(orgId = ORG_ID) {
  return { auth: orgId ? { organizationId: orgId } : null };
}

/**
 * Minimal Express-style res. json()/end fire the 'finish' listeners so the
 * middleware's safety-net release path matches production, but the middleware
 * releases explicitly before then on the happy path — both are exercised.
 */
function mockRes() {
  const headers = {};
  const listeners = { finish: [], close: [] };
  let statusCode = 200;
  let jsonBody = null;
  return {
    headers,
    setHeader(k, v) {
      headers[k] = v;
    },
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
    },
    status(c) {
      statusCode = c;
      return this;
    },
    json(b) {
      jsonBody = b;
      listeners.finish.forEach(fn => fn());
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get jsonBody() {
      return jsonBody;
    },
  };
}

describe('P0-3 — subscription quota advisory unlock key (regression)', () => {
  it('unlocks with hashtext($2::text), the SAME key it locks with', async () => {
    const pool = makeRecordingPool();
    const mw = makeSubscriptionQuotaCheck({ pool, limit: 10 });
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq(), res, () => {
      nextCalled = true;
    });

    // Under the limit → request proceeds (2xx path).
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);

    const lock = pool.locks.find(l => l.fn === 'lock');
    const unlock = pool.locks.find(l => l.fn === 'unlock');
    expect(lock).toBeDefined();
    expect(unlock).toBeDefined();

    // Both sides MUST wrap the org id in hashtext($2::text). The bug was the
    // unlock passing the raw UUID; assert the hashtext form on the unlock SQL.
    expect(lock.sql).toMatch(/pg_advisory_lock\(\$1, hashtext\(\$2::text\)\)/);
    expect(unlock.sql).toMatch(/pg_advisory_unlock\(\$1, hashtext\(\$2::text\)\)/);
    expect(unlock.usesHashtext).toBe(true);

    // Same namespace + same org id passed to both calls.
    expect(lock.key).toBe(ADVISORY_LOCK_KEY_QUOTAS);
    expect(unlock.key).toBe(ADVISORY_LOCK_KEY_QUOTAS);
    expect(lock.orgArg).toBe(ORG_ID);
    expect(unlock.orgArg).toBe(ORG_ID);
  });

  it('pg_advisory_unlock returns true — the lock is actually released (no leak)', async () => {
    const pool = makeRecordingPool();
    const mw = makeSubscriptionQuotaCheck({ pool, limit: 10 });
    await mw(mockReq(), mockRes(), () => {});

    const unlock = pool.locks.find(l => l.fn === 'unlock');
    expect(unlock).toBeDefined();
    // The stub returns true only when the unlock key matches a held lock key.
    // With the raw-UUID bug this would be false (mismatched key) and the lock
    // would leak; the fix makes it true.
    expect(unlock.released).toBe(true);

    // And nothing is left held on the pooled connection after a 2xx.
    expect(pool.heldKeys.size).toBe(0);
  });

  it('releases on the 429 path too (no leaked lock when over quota)', async () => {
    // used (0) is returned by the stub; force a block by using limit 0 so
    // used >= limit. The middleware must still unlock with the hashtext key.
    const pool = makeRecordingPool();
    const mw = makeSubscriptionQuotaCheck({ pool, limit: 0 });
    const res = mockRes();
    await mw(mockReq(), res, () => {});

    expect(res.statusCode).toBe(429);
    const unlock = pool.locks.find(l => l.fn === 'unlock');
    expect(unlock).toBeDefined();
    expect(unlock.usesHashtext).toBe(true);
    expect(unlock.released).toBe(true);
    expect(pool.heldKeys.size).toBe(0);
  });

  it('the buggy raw-UUID unlock form would NOT release the lock (guard sanity)', async () => {
    // Proves the recording pool actually discriminates: a raw-UUID unlock
    // (the pre-fix form) against a hashtext-form lock does NOT match, so the
    // lock stays held. This is what made the regression silent before the fix.
    const pool = makeRecordingPool();
    const client = await pool.connect();
    await client.query('SELECT pg_advisory_lock($1, hashtext($2::text))', [
      ADVISORY_LOCK_KEY_QUOTAS,
      ORG_ID,
    ]);
    const buggy = await client.query('SELECT pg_advisory_unlock($1, $2)', [
      ADVISORY_LOCK_KEY_QUOTAS,
      ORG_ID,
    ]);
    expect(buggy.rows[0].pg_advisory_unlock).toBe(false);
    expect(pool.heldKeys.size).toBe(1); // lock leaked — exactly the P0-3 failure
  });
});
