"use client";

import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
  connected?: boolean;
  showPulse?: boolean;
  size?: "sm" | "md";
}

const statusStyles: Record<string, string> = {
  active:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-400 dark:ring-emerald-400/20",
  inactive:
    "bg-neutral-50 text-neutral-600 ring-neutral-500/10 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-neutral-400/10",
  error:
    "bg-red-50 text-red-700 ring-red-600/10 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
  disconnected:
    "bg-amber-50 text-amber-700 ring-amber-600/10 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-400/20",
};

function getEffectiveStatus(status: string, connected?: boolean): string {
  if (connected === undefined) return status;
  if (status === "active" && connected) return "active";
  if (status === "active" && !connected) return "disconnected";
  return status;
}

function getLabel(effectiveStatus: string): string {
  switch (effectiveStatus) {
    case "active":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "error":
      return "Error";
    default:
      return effectiveStatus.charAt(0).toUpperCase() + effectiveStatus.slice(1);
  }
}

export function StatusBadge({
  status,
  connected,
  showPulse = true,
  size = "sm",
}: StatusBadgeProps) {
  const effectiveStatus = getEffectiveStatus(status, connected);
  const isLive = effectiveStatus === "active" && showPulse;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full font-medium ring-1 ring-inset",
        size === "sm" ? "px-2.5 py-0.5 text-xs" : "px-3 py-1 text-sm",
        statusStyles[effectiveStatus] || statusStyles.inactive
      )}
    >
      {/* Status dot with optional pulse animation */}
      <span className="relative flex h-2 w-2">
        {isLive && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
        )}
        <span
          className={cn(
            "relative inline-flex h-2 w-2 rounded-full",
            effectiveStatus === "active"
              ? "bg-emerald-500"
              : effectiveStatus === "error"
                ? "bg-red-500"
                : effectiveStatus === "disconnected"
                  ? "bg-amber-500"
                  : "bg-neutral-400"
          )}
        />
      </span>
      {getLabel(effectiveStatus)}
    </span>
  );
}
