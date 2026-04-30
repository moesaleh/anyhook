/**
 * AnyHook dashboard service worker.
 *
 * Goals — narrow on purpose:
 *   1. Cache /_next/static/* (immutable bundles + chunks) so navigation
 *      between dashboard pages doesn't re-pull JS/CSS over the wire.
 *   2. Cache /favicon.ico + any same-origin /public assets for the same
 *      reason.
 *
 * Non-goals:
 *   - Don't cache HTML routes. Next.js renders auth-gated content; a
 *     stale HTML shell would leak a logged-out user's view to a logged-
 *     in session (or vice versa).
 *   - Don't cache /api or NEXT_PUBLIC_API_URL responses. Those are user-
 *     scoped + dynamic; freshness wins.
 *   - No background sync, no push. The DLQ banner already polls.
 *
 * Strategy: stale-while-revalidate for static assets. The cache name is
 * version-tagged; bumping STATIC_CACHE_VERSION on each deploy invalidates
 * the previous cache via the cleanup pass in `activate`.
 *
 * Lifecycle:
 *   install   — pre-cache nothing (Next chunks are deploy-specific +
 *               their URLs aren't known here). The first navigation
 *               populates the cache lazily.
 *   activate  — purge any non-current caches.
 *   fetch     — handler below: SWR for /_next/static/*, network for the
 *               rest.
 */

const STATIC_CACHE_VERSION = 'anyhook-static-v1';

self.addEventListener('install', () => {
  // Take over from any previous SW immediately on the next reload.
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(name => name.startsWith('anyhook-static-') && name !== STATIC_CACHE_VERSION)
          .map(name => caches.delete(name))
      );
      // Start serving from this SW for clients that loaded a page
      // before activate finished.
      await self.clients.claim();
    })()
  );
});

function isStaticAsset(url) {
  // Only same-origin static buckets. Cross-origin (lucide CDN, etc.)
  // is handled by the browser's HTTP cache on its own.
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/_next/static/')) return true;
  if (url.pathname === '/favicon.ico') return true;
  if (url.pathname.startsWith('/public/')) return true;
  return false;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // POST / PUT / DELETE always hit the network.
  const url = new URL(req.url);
  if (!isStaticAsset(url)) return; // Network-only.

  event.respondWith(
    (async () => {
      const cache = await caches.open(STATIC_CACHE_VERSION);
      const cached = await cache.match(req);
      // Stale-while-revalidate: serve from cache if present, then update
      // the cache in the background. New asset URLs are immutable
      // (Next.js builds with content hashes) so the cached entry is the
      // freshest we'll get for that URL.
      const networkPromise = fetch(req)
        .then(res => {
          if (res && res.status === 200) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(err => {
          // Offline + nothing in cache → propagate the error.
          if (!cached) throw err;
          return cached;
        });
      return cached || networkPromise;
    })()
  );
});
