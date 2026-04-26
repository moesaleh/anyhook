const { makeRateLimit, DEFAULTS } = require('../../src/lib/rate-limit');

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
});
