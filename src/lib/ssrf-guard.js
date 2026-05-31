/**
 * Connect-time SSRF defense (second layer).
 *
 * `src/lib/url-validation.js` validates a webhook/source URL at CREATE time
 * with a synchronous hostname check and NO DNS resolution. That alone is
 * defeated by DNS rebinding: an attacker registers a public hostname, passes
 * create-time validation, then re-points the record at `169.254.169.254`
 * (cloud IMDS) or an RFC1918 host before the outbound request fires. This
 * module closes that gap for the actual connection:
 *
 *   1. RESOLVE  — resolve the hostname (or accept a literal IP) immediately
 *      before connecting and reject if ANY resolved A/AAAA address is
 *      private / loopback / link-local / CGNAT / IMDS. We reject if *any*
 *      address is bad (not just the first) so a record returning one public
 *      and one private address can't smuggle the private one through.
 *   2. PIN      — pick the first PUBLIC resolved address and force the socket
 *      to dial exactly that IP, by injecting a custom `lookup` into the
 *      http/https Agent. This defeats the TOCTOU window: DNS can rebind
 *      between our check and the kernel's connect(), but we no longer ask the
 *      resolver again — we dial the vetted IP. The original hostname is still
 *      used for the TLS SNI / Host header / certificate validation, so HTTPS
 *      keeps working.
 *   3. NO REDIRECTS — `guardedAxiosConfig` sets `maxRedirects: 0`. A pinned
 *      first hop is useless if axios then follows `302 -> http://169.254...`;
 *      callers must treat a 3xx as a (non-)delivery rather than chase it.
 *
 * Built-ins only (`dns`, `http`, `https`, `net`) — no new dependencies. The
 * private-range classification is delegated to `url-validation.isPrivateIp`
 * so the create-time and connect-time layers can never disagree on which
 * ranges are blocked.
 *
 * Usage:
 *   - axios callers (dispatcher webhook POST, Slack notification):
 *       const cfg = await guardedAxiosConfig(url, { timeout: 5000, headers });
 *       await axios.post(url, body, cfg);
 *   - long-lived socket callers (ws / graphql-ws connectors):
 *       await assertConnectAllowed(endpointUrl); // throws if blocked
 *     (these connect via libraries we don't pass an Agent to; the resolve+
 *      reject check is the available guard at connect time.)
 */

const dns = require('dns');
const http = require('http');
const https = require('https');
const net = require('net');

const { isPrivateIp } = require('./url-validation');

/**
 * Error thrown when a target is rejected by the SSRF guard. Carries a stable
 * machine-readable `.reason` so callers (and tests) can branch without string
 * matching, and `.code` for axios/Node-style error handling parity.
 *
 * reason values:
 *   'invalid_url'      — not a parseable URL / unsupported protocol
 *   'no_address'       — hostname resolved to zero addresses
 *   'private_address'  — a resolved (or literal) address is private/IMDS/etc.
 *   'resolve_failed'   — DNS lookup itself errored (NXDOMAIN, timeout, …)
 */
class SsrfBlockedError extends Error {
  constructor(reason, message, details = {}) {
    super(message || `SSRF guard blocked request: ${reason}`);
    this.name = 'SsrfBlockedError';
    this.code = 'ESSRFBLOCKED';
    this.reason = reason;
    // e.g. { host, address } — handy for logs, never the full URL+secret.
    this.details = details;
  }
}

const HTTP_LIKE_PROTOCOLS = new Set(['http:', 'https:']);
const WS_LIKE_PROTOCOLS = new Set(['ws:', 'wss:']);
const ALL_PROTOCOLS = new Set([...HTTP_LIKE_PROTOCOLS, ...WS_LIKE_PROTOCOLS]);

/**
 * Parse `urlString` and pull out the bits the guard needs. Throws
 * SsrfBlockedError('invalid_url') on anything we won't connect to so callers
 * get one consistent failure type.
 */
function parseTarget(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new SsrfBlockedError('invalid_url', 'Unparseable URL');
  }
  if (!ALL_PROTOCOLS.has(url.protocol)) {
    throw new SsrfBlockedError('invalid_url', `Unsupported protocol: ${url.protocol}`);
  }
  // URL.hostname strips the surrounding brackets from an IPv6 literal but
  // KEEPS them out for net.isIP — so this is the right form to classify.
  return url;
}

/**
 * Resolve `urlString` and validate every candidate address.
 *
 * If the host is already an IP literal we classify it directly (no DNS).
 * Otherwise we `dns.lookup(host, { all: true })` and reject if ANY address
 * is private. On success we pin the FIRST public address.
 *
 * @returns {Promise<{ url: URL, pinnedIp: string, family: 4|6 }>}
 * @throws {SsrfBlockedError}
 */
async function resolveAndValidate(urlString) {
  const url = parseTarget(urlString);
  const host = url.hostname;

  // --- Literal IP: no DNS, classify the literal itself. ---
  const literalFamily = net.isIP(host); // 0 if not an IP, else 4 or 6
  if (literalFamily !== 0) {
    if (isPrivateIp(host)) {
      throw new SsrfBlockedError('private_address', 'Target IP is private/blocked', {
        host,
        address: host,
      });
    }
    return { url, pinnedIp: host, family: literalFamily };
  }

  // --- Hostname: resolve ALL addresses, reject if any is private. ---
  let records;
  try {
    // verbatim:false would let the OS reorder; we want every A/AAAA so we
    // can vet them all. `all:true` returns [{ address, family }, ...].
    records = await dns.promises.lookup(host, { all: true });
  } catch (err) {
    throw new SsrfBlockedError('resolve_failed', `DNS lookup failed for ${host}: ${err.message}`, {
      host,
    });
  }

  if (!records || records.length === 0) {
    throw new SsrfBlockedError('no_address', `Host ${host} resolved to no addresses`, { host });
  }

  let pinned = null;
  for (const rec of records) {
    if (isPrivateIp(rec.address)) {
      // Any private answer poisons the whole set — refuse rather than try to
      // cherry-pick, because we can't control which the kernel would pick.
      throw new SsrfBlockedError(
        'private_address',
        `Host ${host} resolves to a private/blocked address`,
        { host, address: rec.address }
      );
    }
    if (pinned === null) pinned = rec; // first public address wins the pin
  }

  // pinned is guaranteed non-null here (length>0 and none threw).
  return { url, pinnedIp: pinned.address, family: pinned.family };
}

/**
 * Build an http/https Agent that ALWAYS dials `pinnedIp`, regardless of what
 * DNS would say at connect time.
 *
 * We subclass the stdlib Agent and override `createConnection`, injecting a
 * `lookup` function that ignores the requested hostname and hands back the
 * pre-validated IP (re-asserting it's public as a belt-and-suspenders check
 * against a caller passing a stale/poisoned pin). Because we only override
 * address resolution — not the `servername`/`host` the TLS layer sees — the
 * certificate is still validated against the original hostname (SNI intact).
 *
 * @param {string} pinnedIp  validated public address from resolveAndValidate
 * @param {4|6}    family     address family of pinnedIp
 * @param {boolean} isHttps   pick https.Agent (TLS) vs http.Agent
 */
function createSafeAgent(pinnedIp, family, isHttps) {
  const Base = isHttps ? https.Agent : http.Agent;

  // Pinned lookup: matches Node's dns.lookup callback contract
  // (err, address, family). We hand back the pinned IP for ANY hostname the
  // socket asks to resolve, after re-checking it's still public.
  const pinnedLookup = (_hostname, _options, callback) => {
    // Node calls lookup as (hostname, options, cb) or (hostname, cb).
    const cb = typeof _options === 'function' ? _options : callback;
    if (isPrivateIp(pinnedIp)) {
      // Should never happen (resolveAndValidate already vetted it), but if a
      // caller constructs an agent directly with a bad pin, fail the dial.
      cb(
        new SsrfBlockedError('private_address', 'Pinned IP is private/blocked', {
          address: pinnedIp,
        })
      );
      return;
    }
    cb(null, pinnedIp, family);
  };

  class SafeAgent extends Base {
    createConnection(options, callback) {
      // Force the socket to resolve via our pinned lookup. We deliberately
      // keep options.host (the original hostname) so TLS SNI + Host header +
      // cert validation continue to use it; only the A/AAAA resolution is
      // overridden. `family` is pinned too so Node doesn't dual-stack probe.
      const opts = { ...options, lookup: pinnedLookup, family };
      return super.createConnection(opts, callback);
    }
  }

  return new SafeAgent({ keepAlive: false });
}

/**
 * Produce an axios config that is SSRF-safe for `urlString`:
 *   - resolves + validates the target (throws SsrfBlockedError if blocked),
 *   - pins the connection to the vetted IP via httpAgent/httpsAgent,
 *   - forces `maxRedirects: 0` so axios can't be bounced to a private host.
 *
 * Returns a NEW object spread over baseConfig (baseConfig is not mutated).
 * Both agents are supplied; axios selects the one matching the request
 * scheme, and pinning the connection makes the unused one harmless.
 *
 * @throws {SsrfBlockedError}
 */
async function guardedAxiosConfig(urlString, baseConfig = {}) {
  const { url, pinnedIp, family } = await resolveAndValidate(urlString);
  const isHttps = url.protocol === 'https:';

  // One agent per scheme. We build the scheme-correct one and a plain agent
  // for the other so axios always has both fields populated; the pin means
  // only the scheme-matching agent is ever exercised for this request.
  const httpAgent = isHttps
    ? new http.Agent({ keepAlive: false })
    : createSafeAgent(pinnedIp, family, false);
  const httpsAgent = isHttps
    ? createSafeAgent(pinnedIp, family, true)
    : new https.Agent({ keepAlive: false });

  return {
    ...baseConfig,
    httpAgent,
    httpsAgent,
    // Never follow redirects — a pinned first hop is moot if axios chases a
    // 302 to an IMDS address. Callers should treat 3xx as a delivery result.
    maxRedirects: 0,
  };
}

/**
 * Lightweight resolve + validate for connect paths that don't go through
 * axios (the ws / graphql-ws source connectors). These libraries open the
 * socket internally and we don't hand them an Agent, so the available guard
 * is to resolve-and-reject right before connecting; on success we return the
 * vetted pin so a caller that CAN pin (future-proofing) has the address.
 *
 * Note: this still leaves a small TOCTOU window for library-managed sockets
 * (they may re-resolve), but it blocks the create-time-only gap and rejects
 * hostnames that currently resolve to a private/IMDS address — the dominant
 * exploit. Pinning these fully requires a custom WebSocket agent and is
 * tracked separately.
 *
 * @returns {Promise<{ pinnedIp: string, family: 4|6 }>}
 * @throws {SsrfBlockedError}
 */
async function assertConnectAllowed(urlString) {
  const { pinnedIp, family } = await resolveAndValidate(urlString);
  return { pinnedIp, family };
}

module.exports = {
  SsrfBlockedError,
  resolveAndValidate,
  createSafeAgent,
  guardedAxiosConfig,
  assertConnectAllowed,
};
