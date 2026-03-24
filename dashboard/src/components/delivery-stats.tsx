import { cn, formatDate } from "@/lib/utils";
import {
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  TrendingUp,
  AlertTriangle,
} from "lucide-react";
import type { DeliveryStats } from "@/lib/api";

interface DeliveryStatsCardProps {
  stats: DeliveryStats | null;
  loading?: boolean;
}

export function DeliveryStatsCard({ stats, loading }: DeliveryStatsCardProps) {
  if (loading || !stats) {
    return (
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
          Delivery Metrics
        </h3>
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <div className="h-3.5 w-3.5 border-2 border-neutral-300 border-t-transparent rounded-full animate-spin" />
          Loading...
        </div>
      </div>
    );
  }

  const hasDeliveries = stats.total_deliveries > 0;
  const rateColor =
    stats.success_rate >= 95
      ? "text-emerald-600 dark:text-emerald-400"
      : stats.success_rate >= 80
        ? "text-amber-600 dark:text-amber-400"
        : "text-red-600 dark:text-red-400";

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
      <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
        Delivery Metrics
      </h3>

      {!hasDeliveries ? (
        <p className="text-sm text-neutral-400">
          No deliveries recorded yet.
        </p>
      ) : (
        <div className="space-y-3">
          {/* Success rate — the most important metric */}
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sm text-neutral-500">
              <TrendingUp className="h-3.5 w-3.5" />
              Success Rate
            </span>
            <span className={cn("text-lg font-bold", rateColor)}>
              {stats.success_rate}%
            </span>
          </div>

          <div className="h-px bg-neutral-100 dark:bg-neutral-800" />

          {/* Counts grid */}
          <div className="grid grid-cols-2 gap-3">
            <Metric
              icon={<CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />}
              label="Successful"
              value={stats.successful}
            />
            <Metric
              icon={<XCircle className="h-3.5 w-3.5 text-red-500" />}
              label="Failed"
              value={stats.failed}
            />
            <Metric
              icon={<Clock className="h-3.5 w-3.5 text-amber-500" />}
              label="Retrying"
              value={stats.retrying}
            />
            <Metric
              icon={<AlertTriangle className="h-3.5 w-3.5 text-purple-500" />}
              label="Dead Letter"
              value={stats.dlq}
            />
          </div>

          <div className="h-px bg-neutral-100 dark:bg-neutral-800" />

          {/* Timing */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-neutral-500">
                <Zap className="h-3.5 w-3.5" />
                Avg Latency
              </span>
              <span className="font-medium font-mono">
                {stats.avg_response_time_ms != null
                  ? `${stats.avg_response_time_ms}ms`
                  : "—"}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Last 24h</span>
              <span className="font-medium">{stats.deliveries_24h}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">Last 7d</span>
              <span className="font-medium">{stats.deliveries_7d}</span>
            </div>
            {stats.last_delivery_at && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-neutral-500">Last Delivery</span>
                <span className="text-xs text-neutral-400 font-mono">
                  {formatDate(stats.last_delivery_at)}
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <div>
        <p className="text-xs text-neutral-500">{label}</p>
        <p className="text-sm font-bold">{value}</p>
      </div>
    </div>
  );
}
