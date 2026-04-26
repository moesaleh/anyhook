const { isPrivateOrLoopbackHost, isValidUrl } = require('../../src/lib/url-validation');

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
});
