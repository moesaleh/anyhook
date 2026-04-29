/**
 * Redis key conventions for subscription cache entries.
 *
 * Subscription rows are mirrored into Redis so the connector + dispatcher
 * can look them up cheaply. They share the Redis instance with other
 * data — rate-limit counters, future cache entries — so subscription
 * keys MUST be namespaced. Without the prefix, a SCAN over the whole
 * keyspace would also return rate-limit keys, which the connector then
 * tries to JSON.parse + treat as subscriptions (it logs errors and
 * skips them, but every connector pod fans out and contacts every
 * upstream once per startup).
 *
 * `sub:<uuid>` is the canonical form. SCAN MATCH 'sub:*' is the only
 * supported way to list active subscription cache entries.
 */

const SUBSCRIPTION_KEY_PREFIX = 'sub:';
const SUBSCRIPTION_KEY_PATTERN = `${SUBSCRIPTION_KEY_PREFIX}*`;

function subscriptionCacheKey(subscriptionId) {
  return `${SUBSCRIPTION_KEY_PREFIX}${subscriptionId}`;
}

/**
 * Strip the `sub:` prefix to recover the bare subscription_id, or
 * return null if the key isn't a subscription cache entry.
 */
function subscriptionIdFromKey(key) {
  if (typeof key !== 'string' || !key.startsWith(SUBSCRIPTION_KEY_PREFIX)) return null;
  return key.slice(SUBSCRIPTION_KEY_PREFIX.length);
}

module.exports = {
  SUBSCRIPTION_KEY_PREFIX,
  SUBSCRIPTION_KEY_PATTERN,
  subscriptionCacheKey,
  subscriptionIdFromKey,
};
