const { makeRateLimit, DEFAULTS, defaultKeyFn, ipKeyFn } = require('../../src/lib/rate-limit');

/**
 * In-memory mock Redis. Just enough surface for the rate-limit module:
 *   - incr(key) -> Number
 *   - expire(key, seconds) -> 1
 * Tracks calls for assertions.
 */
function mockRedis(initialCounts = {}) {
  const counts = { ...initialCounts };
  const expireCalls = [];
  return {
    counts,
    expireCalls,
    async incr(key) {
      counts[key] = (counts[key] || 0) + 1;
      return counts[key];
    },
    async expire(key, seconds) {
      expireCalls.push({ key, seconds });
      return 1;
    },
  };
}

function mockReq(orgId = 'org-1') {
  return {
    auth: orgId ? { organizationId: orgId } : null,
  };
}

function mockRes() {
  const headers = {};
  let statusCode = 200;
  let jsonBody = null;
  return {
    headers,
    setHeader(k, v) {
      headers[k] = v;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      jsonBody = body;
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

describe('makeRateLimit', () => {
  it('throws if redisClient is missing', () => {
    expect(() => makeRateLimit({})).toThrow(/redisClient/);
  });

  it('uses defaults when no config provided', () => {
    const mw = makeRateLimit({ redisClient: mockRedis() });
    expect(typeof mw).toBe('function');
    expect(DEFAULTS.limit).toBe(600);
    expect(DEFAULTS.windowSec).toBe(60);
  });
});

describe('rate-limit middleware', () => {
  it('passes through and sets headers for first request', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({ redisClient: redis, limit: 5, windowSec: 60 });
    const req = mockReq('org-1');
    const res = mockRes();
    let nextCalled = false;
    await mw(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.headers['X-RateLimit-Limit']).toBe('5');
    expect(res.headers['X-RateLimit-Remaining']).toBe('4');
    expect(res.headers['X-RateLimit-Reset']).toBeDefined();
    expect(res.statusCode).toBe(200);
  });

  it('only calls expire on the first hit of a bucket', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({ redisClient: redis, limit: 10, windowSec: 60 });
    for (let i = 0; i < 3; i++) {
      await mw(mockReq('org-1'), mockRes(), () => {});
    }
    expect(redis.expireCalls.length).toBe(1);
  });

  it('returns 429 when over the limit', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({ redisClient: redis, limit: 2, windowSec: 60 });
    let nextCount = 0;
    const next = () => nextCount++;

    await mw(mockReq('org-1'), mockRes(), next); // 1
    await mw(mockReq('org-1'), mockRes(), next); // 2
    const blockedRes = mockRes();
    await mw(mockReq('org-1'), blockedRes, next); // 3 — over

    expect(nextCount).toBe(2);
    expect(blockedRes.statusCode).toBe(429);
    expect(blockedRes.jsonBody).toMatchObject({
      error: expect.stringContaining('Rate limit exceeded'),
      limit: 2,
      windowSec: 60,
    });
    expect(blockedRes.headers['Retry-After']).toBeDefined();
  });

  it('isolates orgs (org A hitting limit does not affect org B)', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({ redisClient: redis, limit: 1, windowSec: 60 });

    let aBlocked = false;
    let bAllowed = false;

    await mw(mockReq('org-A'), mockRes(), () => {});
    const aRes = mockRes();
    await mw(mockReq('org-A'), aRes, () => {});
    if (aRes.statusCode === 429) aBlocked = true;

    await mw(mockReq('org-B'), mockRes(), () => {
      bAllowed = true;
    });

    expect(aBlocked).toBe(true);
    expect(bAllowed).toBe(true);
  });

  it('passes through when there is no req.auth (defers to auth layer)', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({ redisClient: redis, limit: 1, windowSec: 60 });
    const req = { auth: null };
    const res = mockRes();
    let nextCalled = false;
    await mw(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    // No headers set (we didn't count anything)
    expect(res.headers['X-RateLimit-Limit']).toBeUndefined();
  });

  it('fails OPEN on Redis errors (logs but allows the request)', async () => {
    const brokenRedis = {
      async incr() {
        throw new Error('ECONNREFUSED');
      },
      async expire() {
        throw new Error('ECONNREFUSED');
      },
    };
    const logged = [];
    const logger = { error: (msg, meta) => logged.push({ msg, meta }) };
    const mw = makeRateLimit({ redisClient: brokenRedis, limit: 1, windowSec: 60, logger });

    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq('org-1'), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(logged.length).toBe(1);
    expect(logged[0].msg).toMatch(/Rate limit check failed/);
  });

  it('uses configurable prefix in the Redis key', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({
      redisClient: redis,
      limit: 5,
      windowSec: 60,
      prefix: 'custom-prefix',
    });
    await mw(mockReq('org-1'), mockRes(), () => {});
    const keys = Object.keys(redis.counts);
    expect(keys.length).toBe(1);
    expect(keys[0].startsWith('custom-prefix:org-1:')).toBe(true);
  });

  it('different time buckets create different keys', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({ redisClient: redis, limit: 100, windowSec: 60 });
    const realDateNow = Date.now;
    try {
      Date.now = () => 1700000000000; // bucket A
      await mw(mockReq('org-1'), mockRes(), () => {});
      Date.now = () => 1700000000000 + 70 * 1000; // bucket B (>60s later)
      await mw(mockReq('org-1'), mockRes(), () => {});
    } finally {
      Date.now = realDateNow;
    }
    expect(Object.keys(redis.counts).length).toBe(2);
  });

  it('uses a custom keyFn when provided', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({
      redisClient: redis,
      limit: 5,
      windowSec: 60,
      keyFn: req => req.headers['x-tenant-id'],
    });
    await mw({ headers: { 'x-tenant-id': 'tenant-A' } }, mockRes(), () => {});
    const keys = Object.keys(redis.counts);
    expect(keys.length).toBe(1);
    expect(keys[0]).toContain(':tenant-A:');
  });

  it('skips when keyFn returns falsy', async () => {
    const redis = mockRedis();
    const mw = makeRateLimit({
      redisClient: redis,
      limit: 5,
      windowSec: 60,
      keyFn: () => null,
    });
    let nextCalled = false;
    await mw({}, mockRes(), () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(Object.keys(redis.counts).length).toBe(0);
  });
});

describe('defaultKeyFn (per-organization)', () => {
  it('returns organizationId when req.auth is present', () => {
    expect(defaultKeyFn({ auth: { organizationId: 'org-1' } })).toBe('org-1');
  });

  it('returns falsy when req.auth is missing', () => {
    expect(defaultKeyFn({})).toBeFalsy();
    expect(defaultKeyFn({ auth: null })).toBeFalsy();
  });
});

describe('ipKeyFn', () => {
  it('takes the leftmost X-Forwarded-For when present', () => {
    expect(ipKeyFn({ headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } })).toBe(
      '203.0.113.7'
    );
  });

  it('trims whitespace around the XFF value', () => {
    expect(ipKeyFn({ headers: { 'x-forwarded-for': '  203.0.113.7  ' } })).toBe('203.0.113.7');
  });

  it('handles a single-IP XFF', () => {
    expect(ipKeyFn({ headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe('203.0.113.7');
  });

  it('falls back to req.ip when XFF is absent', () => {
    expect(ipKeyFn({ headers: {}, ip: '198.51.100.5' })).toBe('198.51.100.5');
  });

  it('falls back to connection.remoteAddress when neither XFF nor req.ip is set', () => {
    expect(ipKeyFn({ headers: {}, connection: { remoteAddress: '198.51.100.5' } })).toBe(
      '198.51.100.5'
    );
  });

  it('falls back to socket.remoteAddress as a last resort', () => {
    expect(ipKeyFn({ headers: {}, socket: { remoteAddress: '198.51.100.5' } })).toBe(
      '198.51.100.5'
    );
  });

  it('returns "unknown" when nothing is identifiable', () => {
    expect(ipKeyFn({ headers: {} })).toBe('unknown');
  });

  it('ignores empty XFF and falls through', () => {
    expect(ipKeyFn({ headers: { 'x-forwarded-for': '' }, ip: '203.0.113.7' })).toBe('203.0.113.7');
  });

  it('different IPs counted separately by middleware', async () => {
    const counts = {};
    const redis = {
      async incr(key) {
        counts[key] = (counts[key] || 0) + 1;
        return counts[key];
      },
      async expire() {
        return 1;
      },
    };
    const mw = makeRateLimit({
      redisClient: redis,
      limit: 1,
      windowSec: 60,
      keyFn: ipKeyFn,
    });

    const reqA = { headers: { 'x-forwarded-for': '1.1.1.1' } };
    const reqB = { headers: { 'x-forwarded-for': '2.2.2.2' } };

    let aOk = false;
    let bOk = false;
    await mw(reqA, mockRes(), () => {
      aOk = true;
    });
    await mw(reqB, mockRes(), () => {
      bOk = true;
    });

    expect(aOk).toBe(true);
    expect(bOk).toBe(true);
    expect(Object.keys(counts).length).toBe(2);
  });
});
