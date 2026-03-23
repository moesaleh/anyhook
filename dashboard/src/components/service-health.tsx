"use client";

import { useEffect, useState } from "react";
import { fetchHealth } from "@/lib/api";
import type { HealthResponse } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Database, HardDrive, AlertTriangle } from "lucide-react";

export function ServiceHealth() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    async function check() {
      try {
        const data = await fetchHealth();
        setHealth(data);
        setError(false);
      } catch {
        setError(true);
      }
    }
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-900 px-3 py-2 text-xs text-red-600 dark:text-red-400">
        <AlertTriangle className="h-3.5 w-3.5" />
        API unreachable
      </div>
    );
  }

  if (!health) return null;

  return (
    <div className="flex items-center gap-3">
      <ServiceDot
        label="PostgreSQL"
        icon={Database}
        status={health.services.postgres}
      />
      <ServiceDot
        label="Redis"
        icon={HardDrive}
        status={health.services.redis}
      />
    </div>
  );
}

function ServiceDot({
  label,
  icon: Icon,
  status,
}: {
  label: string;
  icon: typeof Database;
  status: "connected" | "disconnected";
}) {
  const ok = status === "connected";
  return (
    <div
      className="flex items-center gap-1.5 text-xs text-neutral-500"
      title={`${label}: ${status}`}
    >
      <Icon className="h-3 w-3" />
      <span className="hidden sm:inline">{label}</span>
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          ok ? "bg-emerald-500" : "bg-red-500"
        )}
      />
    </div>
  );
}
