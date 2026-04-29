const {
  isPrivateOrLoopbackHost,
  isValidUrl,
  parseInetAtonIPv4,
  ipv6EmbeddedIPv4,
} = require('../../src/lib/url-validation');

describe('isPrivateOrLoopbackHost', () => {
  it.each([
    ['localhost', true],
    ['localhost.localdomain', true],
    ['my.localhost', true],
    ['127.0.0.1', true],
    ['127.255.255.255', true],
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false], // just outside the range
    ['172.32.0.1', false], // just outside the range
    ['192.168.0.1', true],
    ['192.169.0.1', false],
    ['169.254.169.254', true], // AWS/GCP IMDS
    ['100.64.0.1', true], // CGNAT
    ['100.127.255.255', true],
    ['100.128.0.1', false], // outside CGNAT
    ['100.63.255.255', false], // outside CGNAT
    ['8.8.8.8', false],
    ['1.1.1.1', false],
    ['0.0.0.0', true],
    ['::1', true],
    ['::', true],
    ['fe80::1', true],
    ['fc00::1', true],
    ['fd00::1', true],
    ['2001:db8::1', false],
    ['example.com', false],
  ])('isPrivateOrLoopbackHost(%j) === %j', (hostname, expected) => {
    expect(isPrivateOrLoopbackHost(hostname)).toBe(expected);
  });

  it('treats null/empty as private (defensive)', () => {
    expect(isPrivateOrLoopbackHost(null)).toBe(true);
    expect(isPrivateOrLoopbackHost('')).toBe(true);
    expect(isPrivateOrLoopbackHost(undefined)).toBe(true);
  });

  it('handles IPv6 brackets', () => {
    expect(isPrivateOrLoopbackHost('[::1]')).toBe(true);
  });
});

describe('isValidUrl', () => {
  // Default behavior: respect ALLOW_PRIVATE_WEBHOOK_TARGETS env var.
  // Tests below force allowPrivate explicitly to be deterministic.

  it('accepts valid public URLs', () => {
    expect(isValidUrl('https://example.com/webhook')).toBe(true);
    expect(isValidUrl('http://example.com')).toBe(true);
    expect(isValidUrl('wss://stream.example.com')).toBe(true);
    expect(isValidUrl('ws://feed.example.com:8080')).toBe(true);
  });

  it('rejects non-allowed schemes', () => {
    expect(isValidUrl('file:///etc/passwd')).toBe(false);
    expect(isValidUrl('javascript:alert(1)')).toBe(false);
    expect(isValidUrl('data:text/plain,hello')).toBe(false);
    expect(isValidUrl('ftp://example.com')).toBe(false);
  });

  it('rejects loopback by default', () => {
    expect(isValidUrl('http://localhost:3001')).toBe(false);
    expect(isValidUrl('http://127.0.0.1')).toBe(false);
  });

  it('rejects private IPs by default', () => {
    expect(isValidUrl('http://10.0.0.1')).toBe(false);
    expect(isValidUrl('http://192.168.1.1')).toBe(false);
    expect(isValidUrl('http://169.254.169.254')).toBe(false);
    expect(isValidUrl('http://100.64.0.1')).toBe(false);
  });

  it('respects allowPrivate option', () => {
    expect(isValidUrl('http://localhost:3001', { allowPrivate: true })).toBe(true);
    expect(isValidUrl('http://10.0.0.1', { allowPrivate: true })).toBe(true);
  });

  it('respects allowedProtocols option', () => {
    expect(isValidUrl('http://example.com', { allowedProtocols: ['https:'] })).toBe(false);
    expect(isValidUrl('https://example.com', { allowedProtocols: ['https:'] })).toBe(true);
    expect(isValidUrl('ws://example.com', { allowedProtocols: ['https:'] })).toBe(false);
  });

  it.each([null, undefined, '', 'not a url', 0, false, {}])('rejects %p', input => {
    expect(isValidUrl(input)).toBe(false);
  });

  // SSRF bypass forms. Node's WHATWG URL parser canonicalises IPv4
  // decimal-integer / octal / hex / short forms into dotted-decimal
  // before isValidUrl sees the hostname, so the existing dotted regex
  // catches them. The IPv6-mapped IPv4 hex form is NOT canonicalised
  // and is the actual bypass we close in this fix.
  it.each([
    'http://2130706433/', // 127.0.0.1 as 32-bit int
    'http://0177.0.0.1/', // octal-mixed
    'http://0x7f.0.0.1/', // hex-mixed
    'http://0x7f000001/', // hex-32bit
    'http://127.1/', // 2-part short form
    'http://10.1/', // 2-part short form
    'http://[::ffff:7f00:1]/', // IPv6-mapped IPv4 in HEX form (the real bypass)
    'http://[::ffff:0a00:1]/', // 10.0.0.1 mapped, hex form
    'http://[::1]/', // IPv6 loopback
  ])('rejects SSRF bypass URL %s', url => {
    expect(isValidUrl(url)).toBe(false);
  });
});

describe('parseInetAtonIPv4 (defense-in-depth for direct callers)', () => {
  it.each([
    // Standard dotted
    ['127.0.0.1', 0x7f000001],
    ['10.0.0.1', 0x0a000001],
    ['0.0.0.0', 0],
    ['255.255.255.255', 0xffffffff],
    // 32-bit decimal integer
    ['2130706433', 0x7f000001],
    ['0', 0],
    ['4294967295', 0xffffffff],
    // Octal forms
    ['0177.0.0.1', 0x7f000001],
    ['0177.000.000.001', 0x7f000001],
    // Hex forms
    ['0x7f.0.0.1', 0x7f000001],
    ['0x7f000001', 0x7f000001],
    ['0xa.0.0.1', 0x0a000001],
    // Short forms (last part absorbs the rest)
    ['127.1', 0x7f000001],
    ['10.0.1', 0x0a000001],
    ['172.16.1', 0xac100001],
    // Invalid — should return null
    ['08', null], // 8 isn't a valid octal digit
    ['09', null],
    ['256.0.0.1', null], // first octet > 255 in 4-part form
    ['4294967296', null], // exceeds 32 bits
    ['', null],
    ['example.com', null],
    ['127.0.0.1.5', null], // 5 parts
    ['1.2.3.4.', null], // trailing dot
    ['.1.2.3', null], // leading dot
  ])('parseInetAtonIPv4(%j) === %j', (input, expected) => {
    expect(parseInetAtonIPv4(input)).toBe(expected);
  });

  it.each([
    // Confirm direct calls to isPrivateOrLoopbackHost defend against
    // the same forms (covers a caller that bypasses isValidUrl).
    ['2130706433', true],
    ['0177.0.0.1', true],
    ['0x7f.0.0.1', true],
    ['0x7f000001', true],
    ['127.1', true],
    ['134744072', false], // 8.8.8.8
    ['0xa.0.0.1', true], // 10.0.0.1
    ['08', false], // not a parseable IP — falls through to "not private"
  ])('isPrivateOrLoopbackHost(%j) === %j', (h, expected) => {
    expect(isPrivateOrLoopbackHost(h)).toBe(expected);
  });
});

describe('ipv6EmbeddedIPv4', () => {
  it.each([
    ['::ffff:127.0.0.1', '127.0.0.1'],
    ['::ffff:7f00:1', '127.0.0.1'], // hex form (canonical Node output)
    ['::ffff:7f00:0001', '127.0.0.1'], // hex form with leading zeros
    ['::ffff:0a00:1', '10.0.0.1'],
    ['::ffff:0808:0808', '8.8.8.8'],
    ['::127.0.0.1', '127.0.0.1'], // deprecated IPv4-compat
    ['2001:db8::1', null], // not embedded v4
    ['::1', null],
    ['fe80::1', null],
  ])('ipv6EmbeddedIPv4(%j) === %j', (h, expected) => {
    expect(ipv6EmbeddedIPv4(h)).toBe(expected);
  });

  // The full integration: a hex-mapped private IPv4 inside an IPv6
  // host string (the SSRF bypass we're closing).
  it.each([
    ['::ffff:7f00:1', true],
    ['::ffff:0a00:1', true],
    ['::ffff:0808:0808', false], // 8.8.8.8 (public)
    ['[::ffff:7f00:1]', true], // brackets stripped
  ])('isPrivateOrLoopbackHost(%j) === %j (IPv6-mapped)', (h, expected) => {
    expect(isPrivateOrLoopbackHost(h)).toBe(expected);
  });
});
