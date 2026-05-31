/**
 * Route-level instant skeleton for the subscriptions list.
 *
 * Server Component (no "use client") — paints immediately during App
 * Router navigation/suspense, before the client page fetches its first
 * page of data. Mirrors the list layout: header, search bar, and table.
 */
export default function SubscriptionsLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto" aria-busy="true">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="h-7 w-44 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="mt-2 h-4 w-64 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        </div>
        <div className="flex items-center gap-3">
          <div className="h-10 w-24 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="h-10 w-24 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="h-10 w-44 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        </div>
      </div>

      {/* Search bar placeholder */}
      <div className="mb-4 h-10 w-full rounded-lg bg-neutral-100 dark:bg-neutral-900 animate-pulse" />

      {/* Live indicator placeholder */}
      <div className="mb-6 h-4 w-48 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />

      {/* Table panel */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6">
        <div className="space-y-3">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={`row-${i}`}
              className="h-10 w-full rounded bg-neutral-100 dark:bg-neutral-900 animate-pulse"
            />
          ))}
        </div>
      </div>

      <span className="sr-only">Loading subscriptions…</span>
    </div>
  );
}
