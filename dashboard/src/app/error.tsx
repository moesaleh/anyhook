"use client";

import { useEffect } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";

/**
 * Root route error boundary (App Router).
 *
 * Catches render/data errors thrown anywhere in the route subtree that
 * the in-tree <ErrorBoundary> (a render-only class boundary in layout)
 * doesn't already handle — e.g. errors surfaced through Suspense/loading
 * boundaries. Must be a Client Component and accept `{ error, reset }`.
 *
 * Visuals mirror components/error-boundary.tsx so recovery looks the
 * same wherever it fires.
 */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("Route error:", error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[300px] p-8">
      <div className="flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-6 py-4 text-sm text-red-700 dark:text-red-400 max-w-lg">
        <AlertCircle className="h-5 w-5 flex-shrink-0" />
        <div>
          <p className="font-medium">Something went wrong</p>
          <p className="mt-1 text-xs opacity-75">
            {error?.message || "An unexpected error occurred."}
          </p>
        </div>
      </div>
      <button
        onClick={() => reset()}
        className="mt-4 inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
      >
        <RefreshCw className="h-4 w-4" />
        Try Again
      </button>
    </div>
  );
}
