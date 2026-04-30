"use client";

import { useEffect } from "react";

/**
 * Registers /sw.js on the client. Mounted once from the root layout.
 *
 * Only runs in production-build pages — a service worker bound during
 * `next dev` would keep serving stale chunks while you iterate.
 * Detection via NODE_ENV is reliable in a Next.js client component
 * (Next inlines NODE_ENV as a build-time string).
 */
export function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    // navigator.serviceWorker.register returns a promise; failures are
    // logged but don't block rendering.
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("Service worker registration failed:", err);
    });
  }, []);
  return null;
}
