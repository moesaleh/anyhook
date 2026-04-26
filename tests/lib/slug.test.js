const { slugify, MAX_LENGTH } = require('../../src/lib/slug');

describe('slugify', () => {
  it('lowercases', () => {
    expect(slugify('ACME Corp')).toBe('acme-corp');
  });

  it('replaces non-alphanumeric runs with single hyphens', () => {
    expect(slugify('Hello, World!')).toBe('hello-world');
    expect(slugify('a___b')).toBe('a-b');
    expect(slugify('a   b')).toBe('a-b');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('---hi---')).toBe('hi');
    expect(slugify('!!hi!!')).toBe('hi');
  });

  it(`truncates to ${MAX_LENGTH} chars`, () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBe(MAX_LENGTH);
  });

  it('falls back to "org" for empty/null/undefined', () => {
    expect(slugify('')).toBe('org');
    expect(slugify(null)).toBe('org');
    expect(slugify(undefined)).toBe('org');
  });

  it('falls back to "org" when input is all non-alphanumeric', () => {
    expect(slugify('!!!')).toBe('org');
    expect(slugify('   ')).toBe('org');
    expect(slugify('---')).toBe('org');
  });

  it('preserves digits', () => {
    expect(slugify('Acme 2026')).toBe('acme-2026');
  });

  it('normalizes unicode to nothing (defensive)', () => {
    // Non-ASCII chars are stripped (current behavior). Document it.
    expect(slugify('café')).toBe('caf');
  });
});
