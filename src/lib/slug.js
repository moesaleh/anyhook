/**
 * URL-friendly slug from an arbitrary display name.
 *
 * Lowercases, replaces non-alphanumeric runs with single hyphens, trims
 * leading/trailing hyphens, caps at 64 chars. Falls back to 'org' if the
 * input would yield an empty string.
 */

const MAX_LENGTH = 64;

function slugify(name) {
  return (
    String(name == null ? '' : name)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_LENGTH) || 'org'
  );
}

module.exports = { slugify, MAX_LENGTH };
