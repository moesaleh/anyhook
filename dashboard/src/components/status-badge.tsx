import { cn } from "@/lib/utils";

interface StatusBadgeProps {
  status: string;
}

const statusStyles: Record<string, string> = {
  active:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-400 dark:ring-emerald-400/20",
  inactive:
    "bg-neutral-50 text-neutral-600 ring-neutral-500/10 dark:bg-neutral-900 dark:text-neutral-400 dark:ring-neutral-400/10",
  error:
    "bg-red-50 text-red-700 ring-red-600/10 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
};

export function StatusBadge({ status }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        statusStyles[status] || statusStyles.inactive
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "active"
            ? "bg-emerald-500"
            : status === "error"
              ? "bg-red-500"
              : "bg-neutral-400"
        )}
      />
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}
