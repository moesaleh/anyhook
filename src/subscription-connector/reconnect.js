/**
 * Reconnect scheduler — exponential backoff with cancellation.
 *
 * Both source-handlers (GraphQL + WebSocket) need the same shape:
 * when the transport drops unexpectedly, retry the connect after a
 * growing delay until either it succeeds or disconnect() is called.
 *
 * Defaults: 1s → 2s → 4s → 8s → 16s → 32s → 60s (capped at MAX_DELAY_MS).
 * No upper bound on attempts — operators can rely on the cache eventually
 * coming back when the source is reachable again. Each scheduled attempt
 * is cancellable via stop() so disconnect() doesn't race a pending timer.
 */

const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;

function backoffMs(attempt) {
  // attempt is 1-based; clamp to MAX_DELAY_MS.
  const exp = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1));
  // Add up to ±25% jitter so synchronized clients don't reconnect in
  // lockstep and DDoS the source on a flap.
  const jitter = exp * (Math.random() * 0.5 - 0.25);
  return Math.max(BASE_DELAY_MS, Math.floor(exp + jitter));
}

/**
 * Track per-subscription reconnect state so a handler can:
 *   schedule(id, fn): queue an attempt; calls fn() after backoff.
 *   stop(id):         cancel any pending attempt + clear attempt count.
 *   reset(id):        clear the attempt count (call after a successful
 *                     connect so the next disconnect starts fresh).
 *
 * Internally each entry is { attempts, timer }. Idempotent across
 * schedule()/stop().
 */
class ReconnectScheduler {
  constructor({ baseDelayMs = BASE_DELAY_MS, maxDelayMs = MAX_DELAY_MS } = {}) {
    this.entries = new Map();
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  schedule(id, fn) {
    const entry = this.entries.get(id) || { attempts: 0, timer: null };
    if (entry.timer) clearTimeout(entry.timer);
    entry.attempts += 1;
    const delay = backoffMs(entry.attempts);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      try {
        fn();
      } catch {
        // fn errors are the handler's problem — schedule will be
        // re-invoked on the next close event.
      }
    }, delay);
    this.entries.set(id, entry);
    return delay;
  }

  stop(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.entries.delete(id);
  }

  reset(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.attempts = 0;
    entry.timer = null;
    this.entries.set(id, entry);
  }

  attempts(id) {
    const entry = this.entries.get(id);
    return entry ? entry.attempts : 0;
  }

  // Test hook
  _hasTimer(id) {
    return !!(this.entries.get(id) && this.entries.get(id).timer);
  }
}

module.exports = { ReconnectScheduler, backoffMs, BASE_DELAY_MS, MAX_DELAY_MS };
