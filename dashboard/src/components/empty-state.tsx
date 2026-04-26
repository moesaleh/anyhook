import { Radio, Plus } from "lucide-react";
import Link from "next/link";

export function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4">
      <div className="w-16 h-16 rounded-full bg-indigo-50 dark:bg-indigo-950 flex items-center justify-center mb-4">
        <Radio className="h-8 w-8 text-indigo-600 dark:text-indigo-400" />
      </div>
      <h3 className="text-lg font-semibold mb-1">No subscriptions yet</h3>
      <p className="text-sm text-neutral-500 text-center max-w-sm mb-6">
        Create your first subscription to start proxying real-time data from
        GraphQL or WebSocket sources to your webhook endpoints.
      </p>
      <Link
        href="/subscriptions/new"
        className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm"
      >
        <Plus className="h-4 w-4" />
        Create Subscription
      </Link>
    </div>
  );
}
