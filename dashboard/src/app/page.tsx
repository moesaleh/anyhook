"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Radio,
  Webhook,
  Activity,
  AlertCircle,
  Plus,
  Zap,
  ZapOff,
} from "lucide-react";
import { StatCard } from "@/components/stat-card";
import { SubscriptionTable } from "@/components/subscription-table";
import { DeleteDialog } from "@/components/delete-dialog";
import { EmptyState } from "@/components/empty-state";
import { LiveIndicator } from "@/components/live-indicator";
import { ServiceHealth } from "@/components/service-health";
import {
  fetchSubscriptions,
  fetchAllStatuses,
  deleteSubscription,
} from "@/lib/api";
import type { Subscription } from "@/lib/api";

const POLL_INTERVAL = 10000;

export default function DashboardPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [connectedIds, setConnectedIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadData = useCallback(async () => {
    try {
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
      setError(
        "Unable to connect to the API. Make sure the backend is running on port 3001."
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [loadData]);

  async function handleDelete(id: string) {
    setDeleteTarget(id);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(deleteTarget);
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
    } catch {
      setError("Failed to delete subscription.");
    } finally {
      setDeleting(null);
      setDeleteTarget(null);
    }
  }

  const totalActive = subscriptions.filter(
    (s) => s.status === "active"
  ).length;
  const connectedCount = connectedIds.size;
  const graphqlCount = subscriptions.filter(
    (s) => s.connection_type === "graphql"
  ).length;
  const wsCount = subscriptions.filter(
    (s) => s.connection_type === "websocket"
  ).length;

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-sm text-neutral-500 mt-1">
            Overview of your subscription proxy
          </p>
        </div>
        <div className="flex items-center gap-3">
          <ServiceHealth />
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
          isPolling={true}
          intervalMs={POLL_INTERVAL}
        />
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
          <button
            onClick={loadData}
            className="ml-auto text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 underline text-xs"
          >
            Retry
          </button>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          title="Total Subscriptions"
          value={loading ? "—" : subscriptions.length}
          icon={Radio}
          description="All registered subscriptions"
        />
        <StatCard
          title="Connected"
          value={loading ? "—" : connectedCount}
          icon={Zap}
          description={`${totalActive} active, ${connectedCount} connected`}
        />
        <StatCard
          title="GraphQL Sources"
          value={loading ? "—" : graphqlCount}
          icon={Radio}
          description="GraphQL subscription connections"
        />
        <StatCard
          title="WebSocket Sources"
          value={loading ? "—" : wsCount}
          icon={Webhook}
          description="WebSocket connections"
        />
      </div>

      {/* Table or Empty State */}
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
        />
      )}

      {/* Delete Confirmation */}
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
