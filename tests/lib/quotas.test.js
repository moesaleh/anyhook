const {
  makeSubscriptionQuotaCheck,
  makeApiKeyQuotaCheck,
  DEFAULTS,
} = require('../../src/lib/quotas');

function mockPool(count, override = null) {
  return {
    async query() {
      // Matches the new shape: subselects return `used` + `override`.
      return { rows: [{ used: count, override }] };
    },
  };
}

function mockBrokenPool() {
  return {
    async query() {
      throw new Error('connection refused');
    },
  };
}

function mockReq(orgId = 'org-1') {
  return { auth: orgId ? { organizationId: orgId } : null };
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
    status(c) {
      statusCode = c;
      return this;
    },
    json(b) {
      jsonBody = b;
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

describe('makeSubscriptionQuotaCheck', () => {
  it('throws if pool is missing', () => {
    expect(() => makeSubscriptionQuotaCheck({})).toThrow(/pool/);
  });

  it('uses default limit (100) when none provided', () => {
    expect(DEFAULTS.subscriptions).toBe(100);
  });

  it('passes through under the limit and sets quota headers', async () => {
    const mw = makeSubscriptionQuotaCheck({ pool: mockPool(5), limit: 10 });
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq(), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.headers['X-Quota-Limit']).toBe('10');
    expect(res.headers['X-Quota-Used']).toBe('5');
  });

  it('blocks at exactly the limit (used >= limit, not >)', async () => {
    const mw = makeSubscriptionQuotaCheck({ pool: mockPool(10), limit: 10 });
    const res = mockRes();
    await mw(mockReq(), res, () => {});
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody).toMatchObject({
      error: expect.stringContaining('Subscription quota exceeded'),
      quota: 'subscriptions',
      used: 10,
      limit: 10,
    });
  });

  it('blocks above the limit', async () => {
    const mw = makeSubscriptionQuotaCheck({ pool: mockPool(99), limit: 10 });
    const res = mockRes();
    await mw(mockReq(), res, () => {});
    expect(res.statusCode).toBe(429);
  });

  it('skips when req.auth is missing (defers to auth layer)', async () => {
    const mw = makeSubscriptionQuotaCheck({ pool: mockPool(99), limit: 1 });
    const res = mockRes();
    let nextCalled = false;
    await mw({ auth: null }, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.headers['X-Quota-Limit']).toBeUndefined();
  });

  it('fails OPEN on pool error (logs but allows the request)', async () => {
    const logged = [];
    const log = { error: (msg, meta) => logged.push({ msg, meta }) };
    const mw = makeSubscriptionQuotaCheck({ pool: mockBrokenPool(), limit: 1, log });
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq(), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(logged.length).toBe(1);
    expect(logged[0].msg).toMatch(/Subscription quota check failed/);
  });

  it('honors per-org override (overrides default limit)', async () => {
    // Override = 2; default limit = 999. Expect block at 2.
    const mw = makeSubscriptionQuotaCheck({ pool: mockPool(2, 2), limit: 999 });
    const res = mockRes();
    await mw(mockReq(), res, () => {});
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody.limit).toBe(2);
    expect(res.headers['X-Quota-Limit']).toBe('2');
  });

  it('falls back to default when override is null', async () => {
    const mw = makeSubscriptionQuotaCheck({ pool: mockPool(0, null), limit: 5 });
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq(), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.headers['X-Quota-Limit']).toBe('5');
  });
});

describe('makeApiKeyQuotaCheck', () => {
  it('throws if pool is missing', () => {
    expect(() => makeApiKeyQuotaCheck({})).toThrow(/pool/);
  });

  it('uses default limit (10) when none provided', () => {
    expect(DEFAULTS.apiKeys).toBe(10);
  });

  it('passes through under the limit and sets quota headers', async () => {
    const mw = makeApiKeyQuotaCheck({ pool: mockPool(2), limit: 5 });
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq(), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.headers['X-Quota-Used']).toBe('2');
  });

  it('blocks at the limit', async () => {
    const mw = makeApiKeyQuotaCheck({ pool: mockPool(5), limit: 5 });
    const res = mockRes();
    await mw(mockReq(), res, () => {});
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody.quota).toBe('api_keys');
  });

  it('skips when req.auth is missing', async () => {
    const mw = makeApiKeyQuotaCheck({ pool: mockPool(99), limit: 1 });
    const res = mockRes();
    let nextCalled = false;
    await mw({ auth: null }, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });

  it('fails OPEN on pool error', async () => {
    const log = { error: () => {} };
    const mw = makeApiKeyQuotaCheck({ pool: mockBrokenPool(), limit: 1, log });
    const res = mockRes();
    let nextCalled = false;
    await mw(mockReq(), res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBe(200);
  });

  it('honors per-org api_keys override', async () => {
    const mw = makeApiKeyQuotaCheck({ pool: mockPool(1, 1), limit: 999 });
    const res = mockRes();
    await mw(mockReq(), res, () => {});
    expect(res.statusCode).toBe(429);
    expect(res.jsonBody.limit).toBe(1);
  });
});
