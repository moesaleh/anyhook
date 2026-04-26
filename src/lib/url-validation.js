/**
 * URL validation with SSRF defense.
 *
 * isValidUrl() rejects URLs whose hostname resolves to a loopback,
 * private (RFC1918), link-local (incl. AWS/GCP IMDS), CGNAT, or IPv6
 * ULA/link-local address. By default `http`, `https`, `ws`, `wss` are
 * the only accepted schemes.
 *
 * Note: this is a SYNCHRONOUS hostname check — we don't resolve DNS,
 * which means an attacker can still defeat it by pointing a public
 * hostname at a private IP. A robust SSRF defense also pins the IP
 * after resolution and re-checks before connecting. Treat this as
 * the first layer.
 */

function isPrivateOrLoopbackHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname)
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

  if (h === 'localhost' || h === 'localhost.localdomain' || h.endsWith('.localhost')) {
    return true;
  }

  // IPv6: loopback, unspecified, link-local (fe80::/10), unique-local (fc00::/7)
  if (h === '::1' || h === '::') return true;
  if (h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — fall through to the v4 check below
  const v4MappedMatch = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4Candidate = v4MappedMatch ? v4MappedMatch[1] : h;

  const ipv4Match = v4Candidate.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 10) return true; // RFC1918
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + IMDS
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
    if (a === 192 && b === 168) return true; // RFC1918
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }

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

module.exports = { isPrivateOrLoopbackHost, isValidUrl, DEFAULT_PROTOCOLS };
