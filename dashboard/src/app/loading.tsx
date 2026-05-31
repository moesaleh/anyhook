/**
 * Route-level instant skeleton for the dashboard.
 *
 * Rendered by the App Router during navigation/suspense before the
 * client page mounts and fetches. Server Component (no "use client")
 * so it ships zero JS and paints immediately. Mirrors the dashboard
 * layout: header, two 4-up stat grids, and the table panel.
 */
function SkeletonCard() {
  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="h-4 w-28 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        <div className="h-4 w-4 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
      </div>
      <div className="mt-3 h-7 w-16 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
      <div className="mt-2 h-3 w-32 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
    </div>
  );
}

export default function DashboardLoading() {
  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto" aria-busy="true">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="h-7 w-40 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
          <div className="mt-2 h-4 w-56 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
        </div>
        <div className="h-10 w-44 rounded-lg bg-neutral-200 dark:bg-neutral-800 animate-pulse" />
      </div>

      {/* Live indicator placeholder */}
      <div className="mb-6 h-4 w-48 rounded bg-neutral-200 dark:bg-neutral-800 animate-pulse" />

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={`stat-${i}`} />
        ))}
      </div>

      {/* Delivery stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonCard key={`delivery-${i}`} />
        ))}
      </div>

      {/* Table panel */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6">
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div
              key={`row-${i}`}
              className="h-10 w-full rounded bg-neutral-100 dark:bg-neutral-900 animate-pulse"
            />
          ))}
        </div>
      </div>

      <span className="sr-only">Loading dashboard…</span>
    </div>
  );
}
