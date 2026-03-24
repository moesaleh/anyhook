"use client";

import { cn, timeAgo } from "@/lib/utils";

interface LiveIndicatorProps {
  lastUpdated: Date | null;
  isPolling: boolean;
  intervalMs: number;
}

export function LiveIndicator({
  lastUpdated,
  isPolling,
  intervalMs,
}: LiveIndicatorProps) {
  return (
    <div
      className="inline-flex items-center gap-2 text-xs text-neutral-500"
      aria-live="polite"
      aria-atomic="true"
    >
      <span className="relative flex h-2 w-2">
        {isPolling && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            isPolling ? "bg-indigo-500" : "bg-neutral-400"
          )}
        />
      </span>
      <span>
        {isPolling ? "Live" : "Paused"}
        {lastUpdated && ` \u00b7 Updated ${timeAgo(lastUpdated)}`}
        {isPolling && ` \u00b7 ${intervalMs / 1000}s`}
      </span>
    </div>
  );
}
