"use client";

import { useEffect, useState, useCallback, type ChangeEvent } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Plus,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { SubscriptionTable } from "@/components/subscription-table";
import { DeleteDialog } from "@/components/delete-dialog";
import { EmptyState } from "@/components/empty-state";
import { LiveIndicator } from "@/components/live-indicator";
import { ImportDialog } from "@/components/import-dialog";
import {
  fetchSubscriptionsPage,
  fetchAllStatuses,
  deleteSubscription,
} from "@/lib/api";
import type { Subscription, SubscriptionPage } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { useDebounced } from "@/lib/utils";
import { downloadFile, exportAsCsv, exportAsJson } from "@/lib/export";

const POLL_INTERVAL = 10000;
const PAGE_SIZE = 25;

/**
 * Subscriptions list — server-side paginated.
 *
 * URL is the source of truth for `page` + `search` so the back button
 * + sharing-a-link both work as expected. The table component still
 * handles in-memory status filtering + sort within the current page;
 * server-side ordering is fixed at created_at DESC.
 *
 * Status filter (connected/disconnected/active) lives client-side
 * because "connected" is a Redis-cache fact, not a DB column.
 */
export default function SubscriptionsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPage = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
  const initialSearch = searchParams.get("q") || "";

  const [page, setPage] = useState(initialPage);
  const [searchInput, setSearchInput] = useState(initialSearch);
  const debouncedSearch = useDebounced(searchInput, 250);

  const [data, setData] = useState<SubscriptionPage | null>(null);
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPolling, setIsPolling] = useState(true);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const toast = useToast();

  // Sync page + search to URL whenever they change.
  useEffect(() => {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
    const qs = params.toString();
    router.replace(qs ? `/subscriptions?${qs}` : "/subscriptions");
  }, [page, debouncedSearch, router]);

  // Reset to page 1 whenever the search term changes (settled value).
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch]);

  const loadData = useCallback(
    async (showRefresh = false) => {
      try {
        if (showRefresh) setRefreshing(true);
        setError(null);
        const [pageResult, statuses] = await Promise.all([
          fetchSubscriptionsPage(page, PAGE_SIZE, debouncedSearch),
          fetchAllStatuses().catch(() => null),
        ]);
        setData(pageResult);
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
    [page, debouncedSearch]
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!isPolling) return;
    const interval = setInterval(() => loadData(), POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isPolling, loadData]);

  function handleDelete(id: string) {
    setDeleteTarget(id);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(deleteTarget);
    const idShort = deleteTarget.slice(0, 8);
    try {
      await deleteSubscription(deleteTarget);
      toast.success(`Subscription ${idShort}… deleted`);
      // Refresh to pick up the new total / page contents.
      await loadData(true);
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

  async function handleBulkDelete(ids: string[]) {
    if (ids.length === 0) return;
    setBulkDeleting(true);
    const results = await Promise.allSettled(ids.map((id) => deleteSubscription(id)));
    const succeeded = results.filter((r) => r.status === "fulfilled").length;
    const failed = ids.length - succeeded;
    if (failed === 0) {
      toast.success(`Deleted ${succeeded} subscription${succeeded === 1 ? "" : "s"}`);
    } else if (succeeded === 0) {
      toast.error(`Failed to delete ${failed} subscription${failed === 1 ? "" : "s"}`);
    } else {
      toast.error(
        `Deleted ${succeeded} of ${ids.length} subscriptions`,
        `${failed} delete${failed === 1 ? "" : "s"} failed.`
      );
    }
    setBulkDeleting(false);
    await loadData(true);
  }

  function timestampedFilename(ext: "json" | "csv") {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    return `anyhook-subscriptions-${ts}.${ext}`;
  }

  /**
   * Export operates on the CURRENT PAGE only — the API is paginated
   * server-side and we don't want to silently fetch all pages on a
   * single Export click. For an org-wide export, the operator should
   * use the API directly with a high `?limit=`.
   */
  function handleExport(format: "json" | "csv") {
    if (!data || data.subscriptions.length === 0) {
      toast.info("Nothing to export on this page");
      return;
    }
    if (format === "json") {
      downloadFile(
        exportAsJson(data.subscriptions),
        timestampedFilename("json"),
        "application/json"
      );
    } else {
      downloadFile(
        exportAsCsv(data.subscriptions),
        timestampedFilename("csv"),
        "text/csv"
      );
    }
    toast.success(
      `Exported ${data.subscriptions.length} subscription${data.subscriptions.length === 1 ? "" : "s"}`,
      `Format: ${format.toUpperCase()} · current page only`
    );
  }

  const total = data?.total ?? 0;
  const pages = data?.pages ?? 1;
  const subscriptions: Subscription[] = data?.subscriptions ?? [];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Subscriptions</h1>
          <p className="text-sm text-neutral-500 mt-1">
            {total > 0
              ? `${total} total · page ${page} of ${pages}`
              : "Manage all your webhook subscriptions"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowImport(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
          >
            <Upload className="h-4 w-4" /> Import
          </button>
          <ExportMenu
            disabled={subscriptions.length === 0}
            onExport={handleExport}
          />
          <button
            onClick={() => loadData(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
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

      {/* Server-side search bar */}
      <div className="mb-4 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
        <input
          type="text"
          value={searchInput}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchInput(e.target.value)}
          placeholder="Search by ID, webhook URL, or endpoint..."
          aria-label="Search subscriptions"
          className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 pl-9 pr-4 py-2 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>

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
        debouncedSearch.trim() ? (
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-12 text-center text-sm text-neutral-500">
            No subscriptions match <span className="font-mono">{debouncedSearch}</span>.
          </div>
        ) : (
          <EmptyState />
        )
      ) : (
        <>
          <SubscriptionTable
            subscriptions={subscriptions}
            connectedIds={connectedIds}
            onDelete={handleDelete}
            deleting={deleting}
            onBulkDelete={handleBulkDelete}
            bulkDeleting={bulkDeleting}
          />

          {/* Server-side pagination footer */}
          {pages > 1 && (
            <div className="flex items-center justify-between mt-4 text-sm text-neutral-500">
              <span>
                Showing {(page - 1) * PAGE_SIZE + 1}–
                {Math.min(page * PAGE_SIZE, total)} of {total}
              </span>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="h-4 w-4" /> Prev
                </button>
                <span aria-live="polite">
                  Page {page} of {pages}
                </span>
                <button
                  onClick={() => setPage((p) => Math.min(pages, p + 1))}
                  disabled={page === pages}
                  className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      <DeleteDialog
        open={deleteTarget !== null}
        subscriptionId={deleteTarget || ""}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        loading={deleting !== null}
      />

      <ImportDialog
        open={showImport}
        onClose={() => setShowImport(false)}
        onImported={() => loadData(true)}
      />
    </div>
  );
}

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
