"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Copy,
  Check,
  Trash2,
  Pencil,
  AlertCircle,
  Clock,
  Radio,
  Wifi,
  Settings2,
  Activity,
  Eye,
  RefreshCw,
} from "lucide-react";
import {
  fetchSubscription,
  fetchSubscriptionStatus,
  fetchDeliveryStats,
  deleteSubscription,
} from "@/lib/api";
import { useToast } from "@/lib/toast";
import { StatusBadge } from "@/components/status-badge";
import { ConnectionTypeBadge } from "@/components/connection-type-badge";
import { ConnectionFlow } from "@/components/connection-flow";
import { LiveIndicator } from "@/components/live-indicator";
import { DeliveryStatsCard } from "@/components/delivery-stats";
import { DeliveryTable } from "@/components/delivery-table";
import { DeleteDialog } from "@/components/delete-dialog";
import { cn, formatDate, formatUptime } from "@/lib/utils";
import type { Subscription, SubscriptionStatus, DeliveryStats } from "@/lib/api";

type Tab = "overview" | "configuration" | "activity";

const POLL_INTERVAL = 10000;

export default function SubscriptionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [deliveryStats, setDeliveryStats] = useState<DeliveryStats | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPolling, setIsPolling] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [subData, statusData, dStats] = await Promise.all([
        fetchSubscription(id),
        fetchSubscriptionStatus(id).catch(() => null),
        fetchDeliveryStats(id).catch(() => null),
      ]);
      setSubscription(subData);
      setStatus(statusData);
      setDeliveryStats(dStats);
      setLastUpdated(new Date());
      setError(null);
    } catch {
      setError("Subscription not found or API unavailable.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!isPolling) return;
    const interval = setInterval(loadData, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [isPolling, loadData]);

  async function handleCopy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      console.error("Clipboard write failed");
    }
  }

  const toast = useToast();

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteSubscription(id);
      toast.success("Subscription deleted");
      router.push("/subscriptions");
    } catch (err) {
      toast.error(
        "Failed to delete subscription",
        err instanceof Error ? err.message : undefined
      );
      setDeleting(false);
      setShowDelete(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <div className="flex items-center gap-3 text-sm text-neutral-500 mt-20 justify-center">
          <div className="h-4 w-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          Loading subscription...
        </div>
      </div>
    );
  }

  if (error || !subscription) {
    return (
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <Link
          href="/subscriptions"
          className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Subscriptions
        </Link>
        <div className="flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4" />
          {error || "Subscription not found."}
        </div>
      </div>
    );
  }

  const connected = status?.connected ?? false;
  const uptime = formatUptime(subscription.created_at);

  const tabs: { id: Tab; label: string; icon: typeof Eye }[] = [
    { id: "overview", label: "Overview", icon: Eye },
    { id: "configuration", label: "Configuration", icon: Settings2 },
    { id: "activity", label: "Activity", icon: Activity },
  ];

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      {/* Back link */}
      <Link
        href="/subscriptions"
        className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mb-6"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Subscriptions
      </Link>

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold tracking-tight">
              Subscription Detail
            </h1>
            <StatusBadge
              status={subscription.status}
              connected={connected}
              size="md"
            />
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex items-center gap-1.5 text-sm text-neutral-500">
              <code className="font-mono bg-neutral-100 dark:bg-neutral-900 px-2 py-0.5 rounded text-xs">
                {subscription.subscription_id}
              </code>
              <button
                onClick={() =>
                  handleCopy(subscription.subscription_id, "id")
                }
                className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                title="Copy ID"
                aria-label="Copy subscription ID"
              >
                {copied === "id" ? (
                  <Check className="h-3.5 w-3.5 text-emerald-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
            <span className="text-neutral-300 dark:text-neutral-700">|</span>
            <ConnectionTypeBadge type={subscription.connection_type} />
            <span className="text-neutral-300 dark:text-neutral-700">|</span>
            <span className="flex items-center gap-1 text-xs text-neutral-500">
              <Clock className="h-3 w-3" />
              Created {formatDate(subscription.created_at)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setIsPolling((p) => !p)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
              isPolling
                ? "border-indigo-200 dark:border-indigo-900 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950"
                : "border-neutral-200 dark:border-neutral-800 text-neutral-500 hover:bg-neutral-50 dark:hover:bg-neutral-900"
            )}
          >
            <RefreshCw
              className={cn("h-3.5 w-3.5", isPolling && "animate-spin")}
              style={isPolling ? { animationDuration: "3s" } : undefined}
            />
            {isPolling ? "Live" : "Paused"}
          </button>
          <Link
            href={`/subscriptions/${id}/edit`}
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 text-neutral-700 dark:text-neutral-300 px-3 py-2 text-xs font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
          >
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </Link>
          <button
            onClick={() => setShowDelete(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 px-3 py-2 text-xs font-medium hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete
          </button>
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

      {/* Data Flow Visualization */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm mb-6">
        <h2 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
          Data Flow
        </h2>
        <div className="flex justify-center">
          <ConnectionFlow
            connectionType={subscription.connection_type}
            endpointUrl={subscription.args.endpoint_url}
            webhookUrl={subscription.webhook_url}
            connected={connected}
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b border-neutral-200 dark:border-neutral-800 mb-6">
        <nav className="flex gap-0" aria-label="Tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
                activeTab === tab.id
                  ? "border-indigo-600 text-indigo-600 dark:border-indigo-400 dark:text-indigo-400"
                  : "border-transparent text-neutral-500 hover:text-neutral-700 hover:border-neutral-300 dark:hover:text-neutral-300 dark:hover:border-neutral-700"
              )}
            >
              <tab.icon className="h-4 w-4" />
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === "overview" && (
        <OverviewTab
          subscription={subscription}
          connected={connected}
          uptime={uptime}
          status={status}
          deliveryStats={deliveryStats}
          onCopy={handleCopy}
          copied={copied}
        />
      )}
      {activeTab === "configuration" && (
        <ConfigurationTab
          subscription={subscription}
          onCopy={handleCopy}
          copied={copied}
        />
      )}
      {activeTab === "activity" && (
        <ActivityTab
          subscriptionId={id}
          connected={connected}
          status={status}
          isPolling={isPolling}
        />
      )}

      {/* Delete Dialog */}
      <DeleteDialog
        open={showDelete}
        subscriptionId={id}
        onConfirm={handleDelete}
        onCancel={() => setShowDelete(false)}
        loading={deleting}
      />
    </div>
  );
}

/* ── Overview Tab ────────────────────────────────────────────────── */

function OverviewTab({
  subscription,
  connected,
  uptime,
  status,
  deliveryStats,
  onCopy,
  copied,
}: {
  subscription: Subscription;
  connected: boolean;
  uptime: string;
  status: SubscriptionStatus | null;
  deliveryStats: DeliveryStats | null;
  onCopy: (text: string, key: string) => void;
  copied: string | null;
}) {
  const SourceIcon =
    subscription.connection_type === "graphql" ? Radio : Wifi;

  return (
    <div className="space-y-5">
      {/* Top row: 3 columns */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Status card */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
          <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
            Connection Status
          </h3>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-neutral-500">State</span>
              <StatusBadge
                status={subscription.status}
                connected={connected}
              />
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-neutral-500">Redis Cache</span>
              <span
                className={cn(
                  "text-sm font-medium",
                  connected
                    ? "text-emerald-600 dark:text-emerald-400"
                    : "text-neutral-400"
                )}
              >
                {connected ? "Cached" : "Not cached"}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-neutral-500">Uptime</span>
              <span className="text-sm font-medium">{uptime}</span>
            </div>
            {status?.checked_at && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-neutral-500">Last Check</span>
                <span className="text-xs text-neutral-400 font-mono">
                  {new Date(status.checked_at).toLocaleTimeString()}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Source card */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
          <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
            Source
          </h3>
          <div className="space-y-4">
            <div>
              <span className="text-xs text-neutral-500">Type</span>
              <div className="mt-1 flex items-center gap-2">
                <SourceIcon className="h-4 w-4 text-neutral-400" />
                <ConnectionTypeBadge type={subscription.connection_type} />
              </div>
            </div>
            <div>
              <span className="text-xs text-neutral-500">Endpoint</span>
              <div className="mt-1 flex items-center gap-1.5">
                <p className="text-sm font-mono break-all leading-relaxed">
                  {subscription.args.endpoint_url}
                </p>
                <button
                  onClick={() =>
                    onCopy(subscription.args.endpoint_url, "endpoint")
                  }
                  className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 flex-shrink-0"
                  aria-label="Copy endpoint URL"
                >
                  {copied === "endpoint" ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
            </div>
            {subscription.connection_type === "websocket" &&
              subscription.args.event_type && (
                <div>
                  <span className="text-xs text-neutral-500">
                    Event Filter
                  </span>
                  <p className="mt-1 text-sm font-mono">
                    {subscription.args.event_type}
                  </p>
                </div>
              )}
          </div>
        </div>

        {/* Destination card */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
          <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
            Destination
          </h3>
          <div className="space-y-4">
            <div>
              <span className="text-xs text-neutral-500">Webhook URL</span>
              <div className="mt-1 flex items-center gap-1.5">
                <p className="text-sm font-mono break-all leading-relaxed">
                  {subscription.webhook_url}
                </p>
                <button
                  onClick={() => onCopy(subscription.webhook_url, "webhook")}
                  className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 flex-shrink-0"
                  title="Copy webhook URL"
                  aria-label="Copy webhook URL"
                >
                  {copied === "webhook" ? (
                    <Check className="h-3 w-3 text-emerald-500" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                </button>
              </div>
            </div>
            <div>
              <span className="text-xs text-neutral-500">Method</span>
              <p className="mt-1 text-sm font-medium">HTTP POST</p>
            </div>
            <div>
              <span className="text-xs text-neutral-500">Retry Policy</span>
              <p className="mt-1 text-sm">
                6 retries &middot; up to 24h backoff
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Delivery Metrics (full-width below the 3 cards) */}
      <DeliveryStatsCard stats={deliveryStats} />
    </div>
  );
}

/* ── Configuration Tab ───────────────────────────────────────────── */

function ConfigurationTab({
  subscription,
  onCopy,
  copied,
}: {
  subscription: Subscription;
  onCopy: (text: string, key: string) => void;
  copied: string | null;
}) {
  const argsJson = JSON.stringify(subscription.args, null, 2);
  const headers = subscription.args.headers;
  const hasHeaders = headers && Object.keys(headers).length > 0;

  return (
    <div className="space-y-6">
      {/* Query / Message */}
      {subscription.connection_type === "graphql" &&
        subscription.args.query && (
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
                GraphQL Subscription Query
              </h3>
              <button
                onClick={() =>
                  onCopy(subscription.args.query || "", "query")
                }
                className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                {copied === "query" ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-500" /> Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" /> Copy
                  </>
                )}
              </button>
            </div>
            <pre className="text-sm font-mono bg-neutral-50 dark:bg-neutral-900 rounded-lg p-4 overflow-x-auto leading-relaxed">
              {subscription.args.query}
            </pre>
          </div>
        )}

      {subscription.connection_type === "websocket" &&
        subscription.args.message && (
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
            <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-3">
              WebSocket Initial Message
            </h3>
            <pre className="text-sm font-mono bg-neutral-50 dark:bg-neutral-900 rounded-lg p-4 overflow-x-auto leading-relaxed">
              {typeof subscription.args.message === "string"
                ? subscription.args.message
                : JSON.stringify(subscription.args.message, null, 2)}
            </pre>
          </div>
        )}

      {/* Headers */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-3">
          Connection Headers
        </h3>
        {hasHeaders ? (
          <div className="space-y-2">
            {Object.entries(headers!).map(([key, value]) => (
              <div
                key={key}
                className="flex items-center gap-3 bg-neutral-50 dark:bg-neutral-900 rounded-lg px-3 py-2"
              >
                <span className="text-sm font-mono font-medium text-neutral-700 dark:text-neutral-300 min-w-[140px]">
                  {key}
                </span>
                <span className="text-sm font-mono text-neutral-500 break-all">
                  {value}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-neutral-400">
            No custom headers configured.
          </p>
        )}
      </div>

      {/* Full Args JSON */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
            Full Configuration (JSON)
          </h3>
          <button
            onClick={() => onCopy(argsJson, "json")}
            className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            {copied === "json" ? (
              <>
                <Check className="h-3 w-3 text-emerald-500" /> Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" /> Copy JSON
              </>
            )}
          </button>
        </div>
        <pre className="text-sm font-mono bg-neutral-50 dark:bg-neutral-900 rounded-lg p-4 overflow-x-auto leading-relaxed">
          {argsJson}
        </pre>
      </div>
    </div>
  );
}

/* ── Activity Tab ────────────────────────────────────────────────── */

function ActivityTab({
  subscriptionId,
  connected,
  status,
  isPolling,
}: {
  subscriptionId: string;
  connected: boolean;
  status: SubscriptionStatus | null;
  isPolling: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Connection timeline */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
          Connection Timeline
        </h3>
        <div className="relative pl-6 space-y-5">
          {/* Line */}
          <div className="absolute left-[7px] top-1 bottom-1 w-px bg-neutral-200 dark:bg-neutral-800" />

          {/* Current state */}
          <TimelineEvent
            dotColor={connected ? "bg-emerald-500" : "bg-amber-500"}
            pulse={connected}
            title={connected ? "Connection active" : "Connection inactive"}
            description={
              connected
                ? "Source is connected and streaming data through AnyHook to the webhook destination."
                : "The subscription is registered but no active connection is detected in the Redis cache."
            }
            timestamp={
              status?.checked_at
                ? `Checked at ${new Date(status.checked_at).toLocaleTimeString()}`
                : undefined
            }
          />

          {/* Redis cache */}
          <TimelineEvent
            dotColor={connected ? "bg-indigo-500" : "bg-neutral-400"}
            title={connected ? "Cached in Redis" : "Not cached in Redis"}
            description={
              connected
                ? "The subscription data is loaded in the connector service and cached in Redis for fast lookup."
                : "The subscription is not present in the Redis cache. The connector may not have loaded it yet."
            }
          />

          {/* Created */}
          <TimelineEvent
            dotColor="bg-neutral-400"
            title="Subscription created"
            description="Subscription was registered in PostgreSQL and an event was published to Kafka."
            timestamp={
              status?.cached_at ? formatDate(status.cached_at) : undefined
            }
          />
        </div>
      </div>

      {/* Delivery History Table */}
      <div>
        <h3 className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-4">
          Webhook Delivery History
        </h3>
        <DeliveryTable
          subscriptionId={subscriptionId}
          isPolling={isPolling}
          pollIntervalMs={10000}
        />
      </div>
    </div>
  );
}

/* ── Timeline Event ──────────────────────────────────────────────── */

function TimelineEvent({
  dotColor,
  pulse,
  title,
  description,
  timestamp,
}: {
  dotColor: string;
  pulse?: boolean;
  title: string;
  description: string;
  timestamp?: string;
}) {
  return (
    <div className="relative flex gap-3">
      <span className="absolute -left-6 top-0.5 flex h-3.5 w-3.5 items-center justify-center">
        <span className="relative flex h-3 w-3">
          {pulse && (
            <span
              className={cn(
                "absolute inline-flex h-full w-full animate-ping rounded-full opacity-75",
                dotColor
              )}
            />
          )}
          <span
            className={cn(
              "relative inline-flex h-3 w-3 rounded-full",
              dotColor
            )}
          />
        </span>
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-neutral-500 mt-0.5 leading-relaxed">
          {description}
        </p>
        {timestamp && (
          <p className="text-[10px] text-neutral-400 mt-1 font-mono">
            {timestamp}
          </p>
        )}
      </div>
    </div>
  );
}

