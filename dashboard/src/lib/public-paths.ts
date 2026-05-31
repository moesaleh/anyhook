// Single source of truth for which dashboard routes are reachable
// without a session cookie. Imported by BOTH the edge middleware
// (dashboard/middleware.ts) and the client AuthProvider
// (src/lib/auth-context.tsx) so the two layers can never drift.
//
// Keep this module dependency-free (no next/* or browser globals) so it
// is safe to import from the edge runtime, server components, and the
// client alike.

/** Exact-match routes that don't require a session cookie. */
export const PUBLIC_PATHS = new Set<string>([
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password",
]);

// Path prefixes that don't require a session cookie. Used for routes
// with dynamic segments (e.g. /invitations/[token]) where exact-match
// against the Set isn't sufficient.
export const PUBLIC_PREFIXES: readonly string[] = ["/invitations/"];

/**
 * True when `pathname` is reachable anonymously — either an exact public
 * route or under a public prefix. Mirrors the gate the middleware uses,
 * so the AuthProvider only redirects on 401 for genuinely protected
 * paths.
 */
export function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))
  );
}
