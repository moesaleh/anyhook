"use client";

import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

/**
 * Top-of-page banner that shows while navigator.onLine === false.
 * Subscribes to the `online` / `offline` window events so it
 * disappears the moment connectivity comes back. Doesn't render
 * anything on the server (where navigator is undefined).
 *
 * The banner is non-modal — the rest of the page stays interactive
 * (some routes work entirely client-side; cached data is still
 * useful). The api.ts apiFetch already short-circuits to OfflineError
 * before fetch attempts, so reads/writes during offline produce a
 * clear error rather than a long timeout.
 */
export function OfflineBanner() {
  const [online, setOnline] = useState(true);

  useEffect(() => {
    if (typeof navigator !== "undefined") {
      setOnline(navigator.onLine);
    }
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  if (online) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-amber-100 dark:bg-amber-950/70 border-b border-amber-200 dark:border-amber-800 text-amber-900 dark:text-amber-200 text-xs py-1.5"
    >
      <WifiOff className="h-3.5 w-3.5" />
      <span>You appear to be offline. Reconnecting will resume normal operation.</span>
    </div>
  );
}
