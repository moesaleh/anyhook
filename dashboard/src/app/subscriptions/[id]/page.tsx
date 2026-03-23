"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Copy,
  Check,
  Trash2,
  ExternalLink,
  AlertCircle,
} from "lucide-react";
import { fetchSubscription, deleteSubscription } from "@/lib/api";
import { StatusBadge } from "@/components/status-badge";
import { ConnectionTypeBadge } from "@/components/connection-type-badge";
import { DeleteDialog } from "@/components/delete-dialog";
import { formatDate } from "@/lib/utils";
import type { Subscription } from "@/lib/api";

export default function SubscriptionDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchSubscription(id);
        setSubscription(data);
      } catch {
        setError("Subscription not found or API unavailable.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [id]);

  async function handleCopyId() {
    await navigator.clipboard.writeText(id);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await deleteSubscription(id);
      router.push("/subscriptions");
    } catch {
      setError("Failed to delete subscription.");
      setDeleting(false);
      setShowDelete(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl mx-auto">
        <div className="flex items-center gap-3 text-sm text-neutral-500 mt-20 justify-center">
          <div className="h-4 w-4 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin" />
          Loading subscription...
        </div>
      </div>
    );
  }

  if (error || !subscription) {
    return (
      <div className="p-6 lg:p-8 max-w-4xl mx-auto">
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

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      {/* Back link */}
      <Link
        href="/subscriptions"
        className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mb-6"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Subscriptions
      </Link>

      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <h1 className="text-2xl font-bold tracking-tight">
              Subscription Detail
            </h1>
            <StatusBadge status={subscription.status} />
          </div>
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <code className="font-mono bg-neutral-100 dark:bg-neutral-900 px-2 py-0.5 rounded text-xs">
              {subscription.subscription_id}
            </code>
            <button
              onClick={handleCopyId}
              className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
              title="Copy ID"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>
        <button
          onClick={() => setShowDelete(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 px-4 py-2 text-sm font-medium hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
        >
          <Trash2 className="h-4 w-4" />
          Delete
        </button>
      </div>

      {/* Info Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Connection Info */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
          <h2 className="text-sm font-medium text-neutral-500 mb-4 uppercase tracking-wider">
            Connection
          </h2>
          <dl className="space-y-4">
            <div>
              <dt className="text-xs text-neutral-500">Type</dt>
              <dd className="mt-1">
                <ConnectionTypeBadge type={subscription.connection_type} />
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Source Endpoint</dt>
              <dd className="mt-1 text-sm font-mono break-all">
                {subscription.args.endpoint_url || "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Created</dt>
              <dd className="mt-1 text-sm">
                {formatDate(subscription.created_at)}
              </dd>
            </div>
          </dl>
        </div>

        {/* Webhook Info */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
          <h2 className="text-sm font-medium text-neutral-500 mb-4 uppercase tracking-wider">
            Webhook Delivery
          </h2>
          <dl className="space-y-4">
            <div>
              <dt className="text-xs text-neutral-500">Webhook URL</dt>
              <dd className="mt-1 flex items-center gap-2">
                <span className="text-sm font-mono break-all">
                  {subscription.webhook_url}
                </span>
                <a
                  href={subscription.webhook_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-neutral-400 hover:text-neutral-600 flex-shrink-0"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </dd>
            </div>
            <div>
              <dt className="text-xs text-neutral-500">Status</dt>
              <dd className="mt-1">
                <StatusBadge status={subscription.status} />
              </dd>
            </div>
          </dl>
        </div>

        {/* Subscription Args */}
        <div className="md:col-span-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5 shadow-sm">
          <h2 className="text-sm font-medium text-neutral-500 mb-4 uppercase tracking-wider">
            Configuration
          </h2>
          <pre className="text-sm font-mono bg-neutral-50 dark:bg-neutral-900 rounded-lg p-4 overflow-x-auto">
            {JSON.stringify(subscription.args, null, 2)}
          </pre>
        </div>
      </div>

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
