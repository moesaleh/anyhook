"use client";

import { useEffect, useState } from "react";
import { Radio, Key } from "lucide-react";
import { fetchQuotas, type QuotasResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 30_000;

/**
 * Compact quota usage display for the sidebar. Polls every 30s; renders
 * a per-resource bar with used/limit and color-codes the bar based on
 * how full it is (green < 50%, amber 50-80%, red > 80%).
 *
 * Renders nothing until the first fetch resolves so we don't flash
 * incorrect zeros.
 */
export function QuotaIndicator() {
  const [quotas, setQuotas] = useState<QuotasResponse | null>(null);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const q = await fetchQuotas();
        if (alive) setQuotas(q);
      } catch {
        // Silent — quota display is non-critical UX
      }
    }
    load();
    const id = setInterval(load, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!quotas) return null;

  return (
    <div className="px-3 py-3 border-t border-neutral-200 dark:border-neutral-800 space-y-3">
      <p className="text-[10px] font-medium text-neutral-500 uppercase tracking-wider">
        Org usage
      </p>
      <QuotaBar
        icon={<Radio className="h-3 w-3" />}
        label="Subscriptions"
        usage={quotas.subscriptions}
      />
      <QuotaBar icon={<Key className="h-3 w-3" />} label="API keys" usage={quotas.api_keys} />
    </div>
  );
}

function QuotaBar({
  icon,
  label,
  usage,
}: {
  icon: React.ReactNode;
  label: string;
  usage: { used: number; limit: number };
}) {
  const pct = usage.limit > 0 ? (usage.used / usage.limit) * 100 : 0;
  const clamped = Math.min(100, Math.max(0, pct));
  const color =
    pct >= 80
      ? "bg-red-500"
      : pct >= 50
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="flex items-center gap-1.5 text-neutral-600 dark:text-neutral-400">
          {icon}
          {label}
        </span>
        <span
          className={cn(
            "font-mono",
            pct >= 80
              ? "text-red-600 dark:text-red-400"
              : "text-neutral-500 dark:text-neutral-400"
          )}
        >
          {usage.used} / {usage.limit}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
        <div
          className={cn("h-full transition-all duration-300", color)}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}
