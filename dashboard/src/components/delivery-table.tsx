"use client";

import { useState, useEffect, useCallback } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ChevronRight as ChevronRightIcon,
  RefreshCw,
  Clock,
  Hash,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { DeliveryStatusBadge } from "./delivery-status-badge";
import { PayloadViewer } from "./payload-viewer";
import { fetchDeliveries } from "@/lib/api";
import type { DeliveryEvent } from "@/lib/api";

interface DeliveryTableProps {
  subscriptionId: string;
  isPolling?: boolean;
  pollIntervalMs?: number;
}

const PAGE_SIZE = 15;

export function DeliveryTable({
  subscriptionId,
  isPolling = true,
  pollIntervalMs = 10000,
}: DeliveryTableProps) {
  const [deliveries, setDeliveries] = useState<DeliveryEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadDeliveries = useCallback(
    async (showRefresh = false) => {
      try {
        if (showRefresh) setRefreshing(true);
        const data = await fetchDeliveries(
          subscriptionId,
          page,
          PAGE_SIZE,
          statusFilter
        );
        setDeliveries(data.deliveries);
        setTotal(data.total);
        setPages(data.pages);
        setError(null);
      } catch {
        setError("Failed to load delivery history.");
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [subscriptionId, page, statusFilter]
  );

  useEffect(() => {
    setLoading(true);
    loadDeliveries();
  }, [loadDeliveries]);

  useEffect(() => {
    if (!isPolling) return;
    const interval = setInterval(() => loadDeliveries(), pollIntervalMs);
    return () => clearInterval(interval);
  }, [isPolling, pollIntervalMs, loadDeliveries]);

  function formatBytes(bytes: number | null): string {
    if (bytes == null) return "—";
    if (bytes < 1024) return `${bytes}B`;
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  function formatLatency(ms: number | null): string {
    if (ms == null) return "—";
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  }

  function httpStatusColor(code: number | null): string {
    if (code == null) return "text-neutral-400";
    if (code >= 200 && code < 300)
      return "text-emerald-600 dark:text-emerald-400";
    if (code >= 400 && code < 500)
      return "text-amber-600 dark:text-amber-400";
    return "text-red-600 dark:text-red-400";
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-8 flex items-center justify-center">
        <div className="flex items-center gap-3 text-sm text-neutral-500">
          <div className="h-4 w-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          Loading delivery history...
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value="all">All Statuses</option>
            <option value="success">Success</option>
            <option value="failed">Failed</option>
            <option value="retrying">Retrying</option>
            <option value="dlq">Dead Letter Queue</option>
          </select>
          <span className="text-xs text-neutral-500">
            {total} {total === 1 ? "delivery" : "deliveries"}
          </span>
        </div>
        <button
          onClick={() => loadDeliveries(true)}
          disabled={refreshing}
          className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
        >
          <RefreshCw
            className={cn("h-3.5 w-3.5", refreshing && "animate-spin")}
          />
          Refresh
        </button>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-sm">
        <table className="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800">
          <thead className="bg-neutral-50 dark:bg-neutral-900">
            <tr>
              <th className="w-8 px-3 py-2.5" />
              <th className="px-3 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" /> Time
                </span>
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Status
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                HTTP
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Latency
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Size
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                <span className="flex items-center gap-1">
                  <Hash className="h-3 w-3" /> Retry
                </span>
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Event ID
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
            {deliveries.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-sm text-neutral-500"
                >
                  {statusFilter === "all"
                    ? "No deliveries recorded yet. Deliveries will appear here once the webhook dispatcher starts processing events."
                    : `No deliveries with status "${statusFilter}".`}
                </td>
              </tr>
            ) : (
              deliveries.map((d) => {
                const isExpanded = expandedRow === d.delivery_id;
                return (
                  <DeliveryRow
                    key={d.delivery_id}
                    delivery={d}
                    isExpanded={isExpanded}
                    onToggle={() =>
                      setExpandedRow(isExpanded ? null : d.delivery_id)
                    }
                    formatBytes={formatBytes}
                    formatLatency={formatLatency}
                    httpStatusColor={httpStatusColor}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–
            {Math.min(page * PAGE_SIZE, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Prev
            </button>
            <span>
              {page} / {pages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page === pages}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 px-2.5 py-1 text-xs hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next <ChevronRightIcon className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Single Delivery Row ─────────────────────────────────────────── */

function DeliveryRow({
  delivery,
  isExpanded,
  onToggle,
  formatBytes,
  formatLatency,
  httpStatusColor,
}: {
  delivery: DeliveryEvent;
  isExpanded: boolean;
  onToggle: () => void;
  formatBytes: (b: number | null) => string;
  formatLatency: (ms: number | null) => string;
  httpStatusColor: (code: number | null) => string;
}) {
  return (
    <>
      <tr
        className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors cursor-pointer"
        onClick={onToggle}
      >
        <td className="px-3 py-2.5 text-center">
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-neutral-400 inline" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-neutral-400 inline" />
          )}
        </td>
        <td className="px-3 py-2.5 text-xs text-neutral-600 dark:text-neutral-400 font-mono whitespace-nowrap">
          {new Date(delivery.created_at).toLocaleString()}
        </td>
        <td className="px-3 py-2.5">
          <DeliveryStatusBadge status={delivery.status} />
        </td>
        <td className="px-3 py-2.5">
          <span
            className={cn(
              "text-xs font-mono font-medium",
              httpStatusColor(delivery.http_status_code)
            )}
          >
            {delivery.http_status_code ?? "—"}
          </span>
        </td>
        <td className="px-3 py-2.5 text-xs font-mono text-neutral-600 dark:text-neutral-400">
          {formatLatency(delivery.response_time_ms)}
        </td>
        <td className="px-3 py-2.5 text-xs font-mono text-neutral-600 dark:text-neutral-400">
          {formatBytes(delivery.payload_size_bytes)}
        </td>
        <td className="px-3 py-2.5 text-xs font-mono text-neutral-500">
          {delivery.retry_count > 0 ? `#${delivery.retry_count}` : "—"}
        </td>
        <td className="px-3 py-2.5 text-xs font-mono text-neutral-400">
          {delivery.event_id.slice(0, 8)}...
        </td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={8} className="px-6 py-4 bg-neutral-50/50 dark:bg-neutral-900/30">
            <PayloadViewer
              requestBody={delivery.request_body}
              responseBody={delivery.response_body}
              errorMessage={delivery.error_message}
            />
          </td>
        </tr>
      )}
    </>
  );
}
