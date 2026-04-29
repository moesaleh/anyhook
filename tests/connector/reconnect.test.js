const { ReconnectScheduler, backoffMs } = require('../../src/subscription-connector/reconnect');

describe('backoffMs', () => {
  it('grows exponentially from base, capped at max', () => {
    // The jitter is ±25% so we just check it's in a sane window
    for (let attempt = 1; attempt <= 10; attempt++) {
      const ms = backoffMs(attempt);
      expect(ms).toBeGreaterThanOrEqual(1000); // BASE_DELAY_MS
      expect(ms).toBeLessThanOrEqual(75_000); // MAX_DELAY_MS + 25% headroom
    }
  });

  it('caps at MAX_DELAY_MS for large attempts', () => {
    // attempt=20 → 1000 * 2^19 = 524s; should clamp + jitter to ≤ 75s
    expect(backoffMs(20)).toBeLessThanOrEqual(75_000);
  });
});

describe('ReconnectScheduler', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedule() invokes fn after a delay', () => {
    const sched = new ReconnectScheduler();
    const fn = jest.fn();
    sched.schedule('id-1', fn);
    expect(fn).not.toHaveBeenCalled();
    jest.advanceTimersByTime(2000);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('attempts() reflects the schedule count', () => {
    const sched = new ReconnectScheduler();
    expect(sched.attempts('id-1')).toBe(0);
    sched.schedule('id-1', () => {});
    expect(sched.attempts('id-1')).toBe(1);
    sched.schedule('id-1', () => {});
    expect(sched.attempts('id-1')).toBe(2);
  });

  it('stop() cancels a pending attempt', () => {
    const sched = new ReconnectScheduler();
    const fn = jest.fn();
    sched.schedule('id-1', fn);
    sched.stop('id-1');
    jest.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
    // After stop, the entry is fully cleared
    expect(sched.attempts('id-1')).toBe(0);
  });

  it('reset() zeroes the attempt counter without calling fn', () => {
    const sched = new ReconnectScheduler();
    const fn = jest.fn();
    sched.schedule('id-1', fn);
    sched.schedule('id-1', fn);
    expect(sched.attempts('id-1')).toBe(2);
    sched.reset('id-1');
    expect(sched.attempts('id-1')).toBe(0);
    jest.advanceTimersByTime(60_000);
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates state across ids', () => {
    const sched = new ReconnectScheduler();
    const a = jest.fn();
    const b = jest.fn();
    sched.schedule('a', a);
    sched.schedule('b', b);
    sched.stop('a');
    jest.advanceTimersByTime(60_000);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('swallows fn errors so a single bad reconnect does not crash the timer', () => {
    const sched = new ReconnectScheduler();
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    sched.schedule('id-1', bad);
    expect(() => jest.advanceTimersByTime(60_000)).not.toThrow();
    expect(bad).toHaveBeenCalled();
  });
});
