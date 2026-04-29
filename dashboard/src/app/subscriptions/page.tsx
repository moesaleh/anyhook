"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Plus, AlertCircle, Download, RefreshCw } from "lucide-react";
import { SubscriptionTable } from "@/components/subscription-table";
import { DeleteDialog } from "@/components/delete-dialog";
import { EmptyState } from "@/components/empty-state";
import { LiveIndicator } from "@/components/live-indicator";
import {
  fetchSubscriptions,
  fetchAllStatuses,
  deleteSubscription,
} from "@/lib/api";
import type { Subscription } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { downloadFile, exportAsCsv, exportAsJson } from "@/lib/export";

const POLL_INTERVAL = 10000;

export default function SubscriptionsPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const toast = useToast();

  const loadData = useCallback(
    async (showRefresh = false) => {
      try {
        if (showRefresh) setRefreshing(true);
        setError(null);
        const [subs, statuses] = await Promise.all([
          fetchSubscriptions(),
          fetchAllStatuses().catch(() => null),
        ]);
        setSubscriptions(subs);
        if (statuses) {
          setConnectedIds(
            new Set(
              statuses.statuses
                .filter((s) => s.connected)
                .map((s) => s.subscription_id)
            )
          );
        }
        setLastUpdated(new Date());
      } catch {
        setError("Unable to connect to the API.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!isPolling) return;
    const interval = setInterval(() => loadData(), POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isPolling, loadData]);

  async function handleDelete(id: string) {
    setDeleteTarget(id);
  }

  function timestampedFilename(ext: "json" | "csv") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    return `anyhook-subscriptions-${ts}.${ext}`;
  }

  function handleExport(format: "json" | "csv") {
    if (subscriptions.length === 0) {
      toast.info("Nothing to export — no subscriptions in this organization");
      return;
    }
    if (format === "json") {
      downloadFile(
        exportAsJson(subscriptions),
        timestampedFilename("json"),
        "application/json"
      );
    } else {
      downloadFile(
        exportAsCsv(subscriptions),
        timestampedFilename("csv"),
        "text/csv"
      );
    }
    toast.success(
      `Exported ${subscriptions.length} subscription${subscriptions.length === 1 ? "" : "s"}`,
      `Format: ${format.toUpperCase()}`
    );
  }

  async function handleBulkDelete(ids: string[]) {
    if (ids.length === 0) return;
    setBulkDeleting(true);
    // Fire deletes in parallel; collect successes/failures so partial
    // outcomes still update the UI cleanly.
    const results = await Promise.allSettled(ids.map((id) => deleteSubscription(id)));
    const succeeded: string[] = [];
    let failed = 0;
    results.forEach((r, i) => {
      if (r.status === "fulfilled") succeeded.push(ids[i]);
      else failed++;
    });
    if (succeeded.length > 0) {
      const succeededSet = new Set(succeeded);
      setSubscriptions((prev) =>
        prev.filter((s) => !succeededSet.has(s.subscription_id))
      );
      setConnectedIds((prev) => {
        const next = new Set(prev);
        succeededSet.forEach((id) => next.delete(id));
        return next;
      });
    }
    if (failed === 0) {
      toast.success(`Deleted ${succeeded.length} subscription${succeeded.length === 1 ? "" : "s"}`);
    } else if (succeeded.length === 0) {
      toast.error(`Failed to delete ${failed} subscription${failed === 1 ? "" : "s"}`);
    } else {
      toast.error(
        `Deleted ${succeeded.length} of ${ids.length} subscriptions`,
        `${failed} delete${failed === 1 ? "" : "s"} failed.`
      );
    }
    setBulkDeleting(false);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(deleteTarget);
    const idShort = deleteTarget.slice(0, 8);
    try {
      await deleteSubscription(deleteTarget);
      setSubscriptions((prev) =>
        prev.filter((s) => s.subscription_id !== deleteTarget)
      );
      setConnectedIds((prev) => {
        const next = new Set(prev);
        next.delete(deleteTarget);
        return next;
      });
      toast.success(`Subscription ${idShort}… deleted`);
    } catch (err) {
      toast.error(
        "Failed to delete subscription",
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setDeleting(null);
      setDeleteTarget(null);
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Manage all your webhook subscriptions
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ExportMenu
            disabled={subscriptions.length === 0}
            onExport={handleExport}
          />
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
            />
            Refresh
          </button>
          <Link
            href="/subscriptions/new"
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm"
          >
            <Plus className="h-4 w-4" />
            New Subscription
          </Link>
        </div>
      </div>

      {/* Live Indicator */}
      <div className="mb-6">
        <LiveIndicator
          lastUpdated={lastUpdated}
          isPolling={isPolling}
          intervalMs={POLL_INTERVAL}
        />
      </div>

      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-12 flex items-center justify-center">
          <div className="flex items-center gap-3 text-sm text-neutral-500">
            <div className="h-4 w-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
            Loading subscriptions...
          </div>
        </div>
      ) : subscriptions.length === 0 && !error ? (
        <EmptyState />
      ) : (
        <SubscriptionTable
          subscriptions={subscriptions}
          connectedIds={connectedIds}
          onDelete={handleDelete}
          deleting={deleting}
          onBulkDelete={handleBulkDelete}
          bulkDeleting={bulkDeleting}
        />
      )}

      <DeleteDialog
        open={deleteTarget !== null}
        subscriptionId={deleteTarget || ""}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        loading={deleting !== null}
      />
    </div>
  );
}

/**
 * Tiny dropdown for the JSON / CSV export choice. Closes on outside
 * click + Escape. No third-party menu lib.
 */
function ExportMenu({
  disabled,
  onExport,
}: {
  disabled: boolean;
  onExport: (format: "json" | "csv") => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onClick() {
      setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, [open]);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors disabled:opacity-60"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Download className="h-4 w-4" /> Export
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 mt-1 z-10 w-32 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg overflow-hidden text-sm"
        >
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              onExport("json");
              setOpen(false);
            }}
            className="block w-full text-left px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            JSON
          </button>
          <button
            role="menuitem"
            type="button"
            onClick={() => {
              onExport("csv");
              setOpen(false);
            }}
            className="block w-full text-left px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-900"
          >
            CSV
          </button>
        </div>
      )}
    </div>
  );
}
