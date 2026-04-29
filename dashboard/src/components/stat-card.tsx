import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";
import { Sparkline } from "./sparkline";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  description?: string;
  className?: string;
  /** Optional numeric series — when present, renders a trend sparkline
   *  in the lower-right of the card. */
  trend?: number[];
  /** Sparkline color override class (defaults to indigo). */
  trendClassName?: string;
}

export function StatCard({
  title,
  value,
  icon: Icon,
  description,
  className,
  trend,
  trendClassName,
}: StatCardProps) {
  return (
    <div
      className={cn(
        "rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm",
        className
      )}
    >
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-neutral-500 dark:text-neutral-400">
          {title}
        </p>
        <Icon className="h-4 w-4 text-neutral-400 dark:text-neutral-600" />
      </div>
      <p className="mt-2 text-2xl font-bold tracking-tight">{value}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        {description ? (
          <p className="text-xs text-neutral-500 flex-1 min-w-0">{description}</p>
        ) : (
          <span className="flex-1" />
        )}
        {trend && trend.length > 1 && (
          <Sparkline data={trend} className={trendClassName} />
        )}
      </div>
    </div>
  );
}
