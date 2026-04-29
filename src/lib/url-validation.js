/**
 * URL validation with SSRF defense.
 *
 * isValidUrl() rejects URLs whose hostname resolves to a loopback,
 * private (RFC1918), link-local (incl. AWS/GCP IMDS), CGNAT, or IPv6
 * ULA/link-local address. By default `http`, `https`, `ws`, `wss` are
 * the only accepted schemes.
 *
 * Bypass coverage: Node's WHATWG URL parser canonicalizes IPv4 in
 * decimal-integer (`2130706433`), octal (`0177.0.0.1`), hex (`0x7f.0.0.1`),
 * and short forms (`127.1`) into dotted-decimal automatically, so the
 * dotted regex catches them once they pass through `new URL()`.
 *
 * IPv6-mapped IPv4 in HEX form (`[::ffff:7f00:1]`) is NOT canonicalized
 * to dotted form, so we explicitly decode it. We also accept the raw
 * inet_aton numeric forms when isPrivateOrLoopbackHost is called
 * directly (i.e. NOT via isValidUrl) so external callers can't end-run
 * the protection.
 *
 * Note: this is a SYNCHRONOUS hostname check — we don't resolve DNS,
 * which means an attacker can still defeat it by pointing a public
 * hostname at a private IP (DNS rebinding). A robust SSRF defense
 * also pins the IP after resolution and re-checks before connecting.
 * Treat this as the first layer.
 */

/**
 * Parse an IPv4 hostname in any inet_aton-accepted form into its
 * 32-bit unsigned value, or null if it isn't a parseable IPv4.
 *
 * Accepted forms (each part may be decimal, octal with leading 0, or
 * hex with 0x prefix):
 *   a.b.c.d   standard
 *   a.b.c     last part is 16-bit
 *   a.b       last part is 24-bit
 *   a         single 32-bit number
 *
 * The WHATWG URL parser already does this canonicalisation for us
 * inside isValidUrl, but isPrivateOrLoopbackHost is also exported and
 * called directly with raw hostnames — defending it here closes that
 * end-run.
 */
function parseInetAtonIPv4(str) {
  if (typeof str !== 'string' || str.length === 0) return null;
  const parts = str.split('.');
  if (parts.length === 0 || parts.length > 4) return null;

  const nums = [];
  for (const part of parts) {
    if (part === '') return null;
    let n;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      n = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]*$/.test(part)) {
      // pure octal (or just '0')
      n = parseInt(part, 8);
    } else if (/^(0|[1-9][0-9]*)$/.test(part)) {
      n = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }

  // Per-part width depends on how many parts were given.
  const limits = {
    1: [0xffffffff],
    2: [0xff, 0xffffff],
    3: [0xff, 0xff, 0xffff],
    4: [0xff, 0xff, 0xff, 0xff],
  };
  const lim = limits[nums.length];
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] > lim[i]) return null;
  }

  // Build 32-bit value with multiplication (avoids the signed-overflow
  // weirdness of `n << 24`).
  let result;
  if (nums.length === 1) {
    result = nums[0];
  } else if (nums.length === 2) {
    result = nums[0] * 0x1000000 + nums[1];
  } else if (nums.length === 3) {
    result = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2];
  } else {
    result = nums[0] * 0x1000000 + nums[1] * 0x10000 + nums[2] * 0x100 + nums[3];
  }
  return result >>> 0;
}

function isPrivateIPv4Number(n) {
  if (n < 0 || n > 0xffffffff) return true;
  const a = (n >>> 24) & 0xff;
  const b = (n >>> 16) & 0xff;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + IMDS
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

/**
 * Return the embedded IPv4 (as a dotted-decimal string) for an IPv4-in-
 * IPv6 hostname, or null. Handles:
 *   ::ffff:1.2.3.4     dotted (canonical IPv4-mapped)
 *   ::ffff:7f00:1      hex (NOT canonicalised by Node URL parser)
 *   ::1.2.3.4          deprecated IPv4-compatible
 */
function ipv6EmbeddedIPv4(h) {
  let m = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];

  m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) {
    const high = parseInt(m[1], 16);
    const low = parseInt(m[2], 16);
    return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
  }

  m = h.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];

  return null;
}

function isPrivateOrLoopbackHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0]; // strip IPv6 zone identifier (e.g. fe80::1%eth0)

  if (h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost')) {
    return true;
  }

  // IPv6: loopback, unspecified, link-local (fe80::/10), unique-local (fc00::/7)
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  // IPv4-in-IPv6 — extract the v4 then fall through to the v4 check.
  const embedded = ipv6EmbeddedIPv4(h);
  const candidate = embedded || h;

  // inet_aton-style parse covers dotted, decimal, octal, hex, and short
  // forms. Node's URL parser already canonicalises most of these for
  // hostnames it sees, but callers that bypass URL parsing (or older
  // Node versions) get covered here too.
  const n = parseInetAtonIPv4(candidate);
  if (n !== null) return isPrivateIPv4Number(n);

  return false;
}

const DEFAULT_PROTOCOLS = ['http:', 'https:', 'ws:', 'wss:'];

function isValidUrl(str, options = {}) {
  if (str == null || typeof str !== 'string' || str.length === 0) return false;

  const allowedProtocols = options.allowedProtocols || DEFAULT_PROTOCOLS;
  const allowPrivate =
    options.allowPrivate !== undefined
      ? Boolean(options.allowPrivate)
      : process.env.ALLOW_PRIVATE_WEBHOOK_TARGETS === 'true';

  let url;
  try {
    url = new URL(str);
  } catch {
    return false;
  }
  if (!allowedProtocols.includes(url.protocol)) return false;
  if (!allowPrivate && isPrivateOrLoopbackHost(url.hostname)) return false;
  return true;
}

module.exports = {
  isPrivateOrLoopbackHost,
  isValidUrl,
  DEFAULT_PROTOCOLS,
  // exported for unit tests
  parseInetAtonIPv4,
  ipv6EmbeddedIPv4,
};
