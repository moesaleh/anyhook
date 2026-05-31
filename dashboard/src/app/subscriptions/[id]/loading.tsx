/**
 * Route-level instant skeleton for the subscription detail page.
 *
 * Server Component (no "use client") — paints immediately during App
 * Router navigation/suspense, before the client page resolves the
 * subscription by id. Mirrors the detail layout: back link, header,
 * data-flow panel, tabs, and a content grid.
 */
export default function SubscriptionDetailLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto" aria-busy="true">
      {/* Back link */}
      <div className="mb-6 h-4 w-40 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
        <div className="space-y-3">
          <div className="h-7 w-56 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="h-4 w-72 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        </div>
        <div className="flex items-center gap-2">
          <div className="h-9 w-20 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="h-9 w-16 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="h-9 w-20 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        </div>
      </div>

      {/* Live indicator placeholder */}
      <div className="mb-6 h-4 w-48 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />

      {/* Data flow panel */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm mb-6">
        <div className="h-3 w-24 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse mb-4" />
        <div className="h-20 w-full rounded bg-neutral-100 dark:bg-neutral-900 animate-pulse" />
      </div>

      {/* Tabs */}
      <div className="border-b border-neutral-200 dark:border-neutral-800 mb-6 flex gap-6 pb-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={`tab-${i}`}
            className="h-5 w-24 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse"
          />
        ))}
      </div>

      {/* Content grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={`card-${i}`}
            className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm"
          >
            <div className="h-3 w-28 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse mb-4" />
            <div className="space-y-3">
              <div className="h-4 w-full rounded bg-neutral-100 dark:bg-neutral-900 animate-pulse" />
              <div className="h-4 w-3/4 rounded bg-neutral-100 dark:bg-neutral-900 animate-pulse" />
              <div className="h-4 w-2/3 rounded bg-neutral-100 dark:bg-neutral-900 animate-pulse" />
            </div>
          </div>
        ))}
      </div>

      <span className="sr-only">Loading subscription…</span>
    </div>
  );
}
