import { cn } from "@/lib/utils";

interface DeliveryStatusBadgeProps {
  status: "success" | "failed" | "retrying" | "dlq";
}

const styles: Record<string, string> = {
  success:
    "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-950 dark:text-emerald-400 dark:ring-emerald-400/20",
  failed:
    "bg-red-50 text-red-700 ring-red-600/10 dark:bg-red-950 dark:text-red-400 dark:ring-red-400/20",
  retrying:
    "bg-amber-50 text-amber-700 ring-amber-600/10 dark:bg-amber-950 dark:text-amber-400 dark:ring-amber-400/20",
  dlq: "bg-purple-50 text-purple-700 ring-purple-600/10 dark:bg-purple-950 dark:text-purple-400 dark:ring-purple-400/20",
};

const labels: Record<string, string> = {
  success: "Success",
  failed: "Failed",
  retrying: "Retrying",
  dlq: "DLQ",
};

const dotColors: Record<string, string> = {
  success: "bg-emerald-500",
  failed: "bg-red-500",
  retrying: "bg-amber-500",
  dlq: "bg-purple-500",
};

export function DeliveryStatusBadge({ status }: DeliveryStatusBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset",
        styles[status] || styles.failed
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          dotColors[status] || "bg-neutral-400"
        )}
      />
      {labels[status] || status}
    </span>
  );
}
