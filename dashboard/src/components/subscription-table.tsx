"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import {
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Trash2,
  Copy,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
} from "lucide-react";
import { cn, formatDate, truncate } from "@/lib/utils";
import { StatusBadge } from "./status-badge";
import { ConnectionTypeBadge } from "./connection-type-badge";
import type { Subscription } from "@/lib/api";

interface SubscriptionTableProps {
  subscriptions: Subscription[];
  connectedIds?: Set<string>;
  onDelete: (id: string) => void;
  deleting: string | null;
}

type SortField = "created_at" | "connection_type" | "status" | "webhook_url";
type SortDir = "asc" | "desc";

const PAGE_SIZE = 10;

export function SubscriptionTable({
  subscriptions,
  connectedIds,
  onDelete,
  deleting,
}: SubscriptionTableProps) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortField, setSortField] = useState<SortField>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(1);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    let result = subscriptions;

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (s) =>
          s.subscription_id.toLowerCase().includes(q) ||
          s.webhook_url.toLowerCase().includes(q) ||
          s.args.endpoint_url?.toLowerCase().includes(q)
      );
    }

    if (typeFilter !== "all") {
      result = result.filter((s) => s.connection_type === typeFilter);
    }

    if (statusFilter !== "all") {
      if (statusFilter === "connected") {
        result = result.filter((s) => connectedIds?.has(s.subscription_id));
      } else if (statusFilter === "disconnected") {
        result = result.filter(
          (s) =>
            s.status === "active" && !connectedIds?.has(s.subscription_id)
        );
      } else {
        result = result.filter((s) => s.status === statusFilter);
      }
    }

    result = [...result].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      if (aVal < bVal) return sortDir === "asc" ? -1 : 1;
      if (aVal > bVal) return sortDir === "asc" ? 1 : -1;
      return 0;
    });

    return result;
  }, [subscriptions, connectedIds, search, typeFilter, statusFilter, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir("asc");
    }
  }

  function SortIcon({ field }: { field: SortField }) {
    if (sortField !== field)
      return <ArrowUpDown className="h-3.5 w-3.5 text-neutral-400" />;
    return sortDir === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5 text-indigo-600" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5 text-indigo-600" />
    );
  }

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      console.error("Clipboard write failed");
    }
  }

  return (
    <div>
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
          <input
            type="text"
            placeholder="Search by ID, webhook URL, or endpoint..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 pl-9 pr-4 py-2 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
        </div>
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All Types</option>
          <option value="graphql">GraphQL</option>
          <option value="websocket">WebSocket</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setPage(1);
          }}
          className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        >
          <option value="all">All Statuses</option>
          <option value="connected">Connected</option>
          <option value="disconnected">Disconnected</option>
          <option value="active">Active</option>
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-sm">
        <table className="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800">
          <thead className="bg-neutral-50 dark:bg-neutral-900">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Subscription ID
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider cursor-pointer select-none"
                onClick={() => toggleSort("connection_type")}
              >
                <span className="inline-flex items-center gap-1">
                  Type <SortIcon field="connection_type" />
                </span>
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Source Endpoint
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider cursor-pointer select-none"
                onClick={() => toggleSort("webhook_url")}
              >
                <span className="inline-flex items-center gap-1">
                  Webhook URL <SortIcon field="webhook_url" />
                </span>
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider cursor-pointer select-none"
                onClick={() => toggleSort("status")}
              >
                <span className="inline-flex items-center gap-1">
                  Status <SortIcon field="status" />
                </span>
              </th>
              <th
                className="px-4 py-3 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider cursor-pointer select-none"
                onClick={() => toggleSort("created_at")}
              >
                <span className="inline-flex items-center gap-1">
                  Created <SortIcon field="created_at" />
                </span>
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-neutral-500 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
            {paginated.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-12 text-center text-sm text-neutral-500"
                >
                  {subscriptions.length === 0
                    ? "No subscriptions yet. Create your first subscription to get started."
                    : "No subscriptions match your filters."}
                </td>
              </tr>
            ) : (
              paginated.map((sub) => {
                const isConnected = connectedIds?.has(sub.subscription_id);
                return (
                  <tr
                    key={sub.subscription_id}
                    className="hover:bg-neutral-50 dark:hover:bg-neutral-900/50 transition-colors group"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <Link
                          href={`/subscriptions/${sub.subscription_id}`}
                          className="text-sm font-mono text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
                        >
                          {sub.subscription_id.slice(0, 8)}...
                        </Link>
                        <button
                          onClick={() => copyId(sub.subscription_id)}
                          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
                          title="Copy full ID"
                          aria-label="Copy subscription ID"
                        >
                          {copiedId === sub.subscription_id ? (
                            <Check className="h-3.5 w-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <ConnectionTypeBadge type={sub.connection_type} />
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="text-sm text-neutral-600 dark:text-neutral-400"
                        title={sub.args.endpoint_url}
                      >
                        {truncate(sub.args.endpoint_url || "—", 35)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className="text-sm text-neutral-600 dark:text-neutral-400"
                        title={sub.webhook_url}
                      >
                        {truncate(sub.webhook_url, 30)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge
                        status={sub.status}
                        connected={isConnected}
                      />
                    </td>
                    <td className="px-4 py-3 text-sm text-neutral-500">
                      {formatDate(sub.created_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/subscriptions/${sub.subscription_id}`}
                          className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-900 dark:hover:text-neutral-300 transition-colors opacity-0 group-hover:opacity-100"
                        >
                          <Eye className="h-3.5 w-3.5" />
                          View
                        </Link>
                        <button
                          onClick={() => onDelete(sub.subscription_id)}
                          disabled={deleting === sub.subscription_id}
                          className={cn(
                            "inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors",
                            deleting === sub.subscription_id
                              ? "text-neutral-400 cursor-not-allowed"
                              : "text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950 dark:hover:text-red-300"
                          )}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {deleting === sub.subscription_id
                            ? "Deleting..."
                            : "Delete"}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4 text-sm text-neutral-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–
            {Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page === 1}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="h-4 w-4" /> Prev
            </button>
            <span>
              Page {page} of {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page === totalPages}
              className="inline-flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-900 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next <ChevronRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
