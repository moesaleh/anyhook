"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, Save } from "lucide-react";
import {
  fetchSubscription,
  updateSubscription,
  type Subscription,
} from "@/lib/api";
import { StepSourceConfig } from "@/components/wizard/step-source-config";
import { StepWebhook } from "@/components/wizard/step-webhook";

interface HeaderEntry {
  key: string;
  value: string;
}

/**
 * Edit-subscription form. Backend has supported PUT /subscriptions/:id
 * for a while; this is the missing UI. Reuses the wizard step
 * components so the field layout matches the create flow.
 *
 * Connection type is shown but not editable -- changing it would
 * require swapping the per-type fields and the connector treats it as
 * the partition key for handler dispatch. Users can delete + recreate
 * if they really need to change it.
 */
export default function EditSubscriptionPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Form state — initialised from the loaded subscription.
  const [endpointUrl, setEndpointUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [eventType, setEventType] = useState("");
  const [headers, setHeaders] = useState<HeaderEntry[]>([]);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const sub = await fetchSubscription(id);
        if (!alive) return;
        setSubscription(sub);
        setEndpointUrl(sub.args.endpoint_url || "");
        setWebhookUrl(sub.webhook_url);
        setQuery(sub.args.query || "");
        setMessage(typeof sub.args.message === "string" ? sub.args.message : "");
        setEventType(sub.args.event_type || "");
        setHeaders(
          sub.args.headers
            ? Object.entries(sub.args.headers).map(([key, value]) => ({
                key,
                value: String(value),
              }))
            : []
        );
      } catch (err) {
        if (!alive) return;
        setLoadError(
          err instanceof Error ? err.message : "Failed to load subscription"
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  function validate(): boolean {
    const errs: Record<string, string> = {};

    if (!endpointUrl.trim()) {
      errs.endpointUrl = "Source endpoint URL is required.";
    } else {
      try {
        const url = new URL(endpointUrl);
        if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
          errs.endpointUrl =
            "URL must use ws://, wss://, http://, or https:// protocol.";
        }
      } catch {
        errs.endpointUrl = "Please enter a valid URL.";
      }
    }
    if (subscription?.connection_type === "graphql" && !query.trim()) {
      errs.query = "A GraphQL subscription query is required.";
    }
    if (!webhookUrl.trim()) {
      errs.webhookUrl = "Webhook URL is required.";
    } else {
      try {
        const url = new URL(webhookUrl);
        if (!["http:", "https:"].includes(url.protocol)) {
          errs.webhookUrl = "Webhook URL must use http:// or https://.";
        }
      } catch {
        errs.webhookUrl = "Please enter a valid URL.";
      }
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (!subscription) return;
    if (!validate()) return;

    const headersObj: Record<string, string> = {};
    headers.forEach((h) => {
      if (h.key.trim()) headersObj[h.key.trim()] = h.value;
    });

    const args: Record<string, unknown> = { endpoint_url: endpointUrl };
    if (Object.keys(headersObj).length > 0) args.headers = headersObj;
    if (subscription.connection_type === "graphql") {
      args.query = query;
    } else {
      if (message) args.message = message;
      if (eventType) args.event_type = eventType;
    }

    setSubmitting(true);
    try {
      await updateSubscription(id, {
        connection_type: subscription.connection_type,
        args,
        webhook_url: webhookUrl,
      });
      router.push(`/subscriptions/${id}`);
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to update subscription"
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="flex items-center gap-3 mt-20 justify-center text-sm text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading subscription...
        </div>
      </div>
    );
  }

  if (loadError || !subscription) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <Link
          href="/subscriptions"
          className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 mb-6"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Subscriptions
        </Link>
        <div className="flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4" />
          {loadError || "Subscription not found"}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      <Link
        href={`/subscriptions/${id}`}
        className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mb-6"
      >
        <ArrowLeft className="h-4 w-4" /> Back to subscription
      </Link>

      <h1 className="text-2xl font-bold tracking-tight mb-1">Edit subscription</h1>
      <p className="text-sm text-neutral-500 mb-6">
        Connection type is{" "}
        <span className="font-mono font-medium">{subscription.connection_type}</span>
        . Delete and recreate if you need to change it.
      </p>

      {submitError && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {submitError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
          <StepSourceConfig
            connectionType={subscription.connection_type}
            endpointUrl={endpointUrl}
            onEndpointUrlChange={setEndpointUrl}
            query={query}
            onQueryChange={setQuery}
            message={message}
            onMessageChange={setMessage}
            eventType={eventType}
            onEventTypeChange={setEventType}
            headers={headers}
            onHeadersChange={setHeaders}
            errors={errors}
          />
        </div>

        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
          <StepWebhook
            webhookUrl={webhookUrl}
            onWebhookUrlChange={setWebhookUrl}
            errors={errors}
          />
        </div>

        <div className="flex items-center justify-end gap-3">
          <Link
            href={`/subscriptions/${id}`}
            className="rounded-lg px-4 py-2.5 text-sm font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save changes
          </button>
        </div>
      </form>
    </div>
  );
}
