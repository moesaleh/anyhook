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
 * Build a dotted-decimal IPv4 string from two 16-bit hextets (the low
 * 32 bits of an IPv6 address), e.g. (0x7f00, 0x0001) -> "127.0.0.1".
 */
function hextetsToIPv4(high, low) {
  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

/**
 * Return the embedded IPv4 (as a dotted-decimal string) for an IPv4-in-
 * IPv6 hostname, or null. Handles:
 *   ::ffff:1.2.3.4         dotted (canonical IPv4-mapped)
 *   ::ffff:7f00:1          hex (NOT canonicalised by Node URL parser)
 *   ::1.2.3.4              deprecated IPv4-compatible
 *   64:ff9b::1.2.3.4       NAT64 well-known prefix (RFC 6052), dotted
 *   64:ff9b::7f00:1        NAT64, hex low 32 bits
 *   64:ff9b:1::7f00:1      NAT64 local-use prefix (RFC 8215)
 *   2002:7f00:1::          6to4 (RFC 3056) — v4 in bits 16..47
 *
 * NAT64 and 6to4 matter for SSRF: on a NAT64-enabled host an attacker
 * AAAA of 64:ff9b::a9fe:a9fe routes to 169.254.169.254 (IMDS). Decoding
 * the embedded v4 here lets isPrivateIPv4Number reject it.
 */
function ipv6EmbeddedIPv4(h) {
  let m = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];

  m = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) return hextetsToIPv4(parseInt(m[1], 16), parseInt(m[2], 16));

  m = h.match(/^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];

  // NAT64 well-known prefix 64:ff9b::/96 (RFC 6052) and the RFC 8215
  // local-use prefix 64:ff9b:1::/48. The embedded IPv4 occupies the low
  // 32 bits, expressed either dotted or as two hex hextets.
  m = h.match(/^64:ff9b(?::1)?::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (m) return m[1];

  m = h.match(/^64:ff9b(?::1)?::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (m) return hextetsToIPv4(parseInt(m[1], 16), parseInt(m[2], 16));

  // 6to4 2002::/16 (RFC 3056): the IPv4 is bits 16..47, i.e. the two
  // hextets immediately after the 2002 prefix.
  m = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4})(?::.*)?$/);
  if (m) return hextetsToIPv4(parseInt(m[1], 16), parseInt(m[2], 16));

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

  // IPv6: loopback, unspecified, link-local (fe80::/10), unique-local (fc00::/7).
  // The fc/fd/fe80 prefixes are only meaningful for an IPv6 *literal*, which
  // always contains a ':'. Requiring a hextet boundary (':' after the prefix)
  // means a DNS hostname that merely starts with those letters — e.g.
  // fcm.googleapis.com (Firebase Cloud Messaging) or fdroid.org — is NOT
  // string-rejected here; it falls through to be resolved and re-classified
  // on its actual A/AAAA records by the connect-time guard.
  if (h === '::1' || h === '::') return true;
  if (/^fe80:/.test(h) || /^f[cd][0-9a-f]{0,2}:/.test(h)) return true;

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

/**
 * Classify a single resolved IP literal (the form `dns.lookup` returns:
 * dotted-decimal IPv4 or canonical/compressed IPv6 — no inet_aton tricks,
 * no brackets) as private/loopback/link-local/CGNAT/IMDS.
 *
 * This is the connect-time counterpart of isPrivateOrLoopbackHost: that
 * function defends a *hostname* (and so must handle every encoding bypass),
 * whereas this one is fed already-resolved addresses by ssrf-guard and so
 * only needs to recognise the canonical literal forms. It delegates to the
 * exact same IPv4/IPv6 classifiers, so the two paths can never disagree on
 * which ranges are blocked.
 *
 * Returns true (block) for anything it cannot positively classify as a
 * public address — fail-closed, since an unrecognised literal at connect
 * time is safer treated as untrusted.
 */
function isPrivateIp(addr) {
  if (!addr || typeof addr !== 'string') return true;
  // Reuse the hostname classifier: it strips brackets/zone-ids, handles
  // ::1 / :: / fe80:: / fc:: / fd::, decodes IPv4-mapped IPv6, and runs the
  // dotted-decimal form through the same isPrivateIPv4Number gate.
  return isPrivateOrLoopbackHost(addr);
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
  // Connect-time classifier for already-resolved IP literals — consumed by
  // src/lib/ssrf-guard.js to re-check each DNS-resolved address.
  isPrivateIp,
  isValidUrl,
  DEFAULT_PROTOCOLS,
  // exported for unit tests
  parseInetAtonIPv4,
  ipv6EmbeddedIPv4,
  isPrivateIPv4Number,
};
