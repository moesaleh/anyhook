"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, AlertCircle, CheckCircle2 } from "lucide-react";
import { createSubscription } from "@/lib/api";
import { cn } from "@/lib/utils";

type ConnectionType = "graphql" | "websocket";

export default function NewSubscriptionPage() {
  const router = useRouter();
  const [connectionType, setConnectionType] =
    useState<ConnectionType>("graphql");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [eventType, setEventType] = useState("");
  const [headers, setHeaders] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!endpointUrl.trim()) {
      setError("Source endpoint URL is required.");
      return;
    }
    if (!webhookUrl.trim()) {
      setError("Webhook URL is required.");
      return;
    }
    if (connectionType === "graphql" && !query.trim()) {
      setError("GraphQL subscription query is required.");
      return;
    }

    let parsedHeaders: Record<string, string> = {};
    if (headers.trim()) {
      try {
        parsedHeaders = JSON.parse(headers);
      } catch {
        setError("Headers must be valid JSON (e.g., {\"Authorization\": \"Bearer token\"}).");
        return;
      }
    }

    const args: Record<string, unknown> = {
      endpoint_url: endpointUrl,
      headers: parsedHeaders,
    };

    if (connectionType === "graphql") {
      args.query = query;
    } else {
      args.message = message || undefined;
      args.event_type = eventType || undefined;
    }

    setLoading(true);
    try {
      const result = await createSubscription({
        connection_type: connectionType,
        args,
        webhook_url: webhookUrl,
      });
      setSuccess(`Subscription created: ${result.subscriptionId}`);
      setTimeout(() => router.push("/"), 1500);
    } catch {
      setError("Failed to create subscription. Check that the API is running.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto">
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mb-6"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold tracking-tight mb-1">
        New Subscription
      </h1>
      <p className="text-sm text-neutral-500 mb-8">
        Connect a real-time data source to a webhook endpoint.
      </p>

      {error && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {success && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
          {success}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Connection Type */}
        <div>
          <label className="block text-sm font-medium mb-2">
            Connection Type
          </label>
          <div className="flex gap-3">
            {(["graphql", "websocket"] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setConnectionType(type)}
                className={cn(
                  "flex-1 rounded-lg border-2 px-4 py-3 text-sm font-medium transition-colors text-center",
                  connectionType === type
                    ? "border-indigo-600 bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300 dark:border-indigo-500"
                    : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 text-neutral-600 dark:text-neutral-400"
                )}
              >
                {type === "graphql" ? "GraphQL" : "WebSocket"}
              </button>
            ))}
          </div>
        </div>

        {/* Source Endpoint */}
        <div>
          <label
            htmlFor="endpoint_url"
            className="block text-sm font-medium mb-1.5"
          >
            Source Endpoint URL <span className="text-red-500">*</span>
          </label>
          <input
            id="endpoint_url"
            type="url"
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            placeholder={
              connectionType === "graphql"
                ? "wss://api.example.com/graphql"
                : "wss://stream.example.com/ws"
            }
            className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-neutral-500">
            The URL of the{" "}
            {connectionType === "graphql"
              ? "GraphQL endpoint to subscribe to"
              : "WebSocket server to connect to"}
          </p>
        </div>

        {/* GraphQL Query */}
        {connectionType === "graphql" && (
          <div>
            <label htmlFor="query" className="block text-sm font-medium mb-1.5">
              Subscription Query <span className="text-red-500">*</span>
            </label>
            <textarea
              id="query"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              rows={5}
              placeholder={`subscription {\n  onNewMessage {\n    id\n    content\n  }\n}`}
              className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm font-mono placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>
        )}

        {/* WebSocket fields */}
        {connectionType === "websocket" && (
          <>
            <div>
              <label
                htmlFor="message"
                className="block text-sm font-medium mb-1.5"
              >
                Initial Message (optional)
              </label>
              <textarea
                id="message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                placeholder='{"action": "subscribe", "channel": "updates"}'
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm font-mono placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <p className="mt-1 text-xs text-neutral-500">
                Message to send upon connection (JSON or text)
              </p>
            </div>
            <div>
              <label
                htmlFor="event_type"
                className="block text-sm font-medium mb-1.5"
              >
                Event Type Filter (optional)
              </label>
              <input
                id="event_type"
                type="text"
                value={eventType}
                onChange={(e) => setEventType(e.target.value)}
                placeholder="message"
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <p className="mt-1 text-xs text-neutral-500">
                Only forward messages matching this event type
              </p>
            </div>
          </>
        )}

        {/* Webhook URL */}
        <div>
          <label
            htmlFor="webhook_url"
            className="block text-sm font-medium mb-1.5"
          >
            Webhook URL <span className="text-red-500">*</span>
          </label>
          <input
            id="webhook_url"
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://your-app.com/webhooks/anyhook"
            className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Where received data will be forwarded via POST requests
          </p>
        </div>

        {/* Headers */}
        <div>
          <label
            htmlFor="headers"
            className="block text-sm font-medium mb-1.5"
          >
            Headers (optional)
          </label>
          <textarea
            id="headers"
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
            rows={3}
            placeholder='{"Authorization": "Bearer your-token"}'
            className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm font-mono placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          />
          <p className="mt-1 text-xs text-neutral-500">
            Custom headers sent with the source connection (JSON format)
          </p>
        </div>

        {/* Submit */}
        <div className="flex items-center gap-3 pt-2">
          <button
            type="submit"
            disabled={loading}
            className="rounded-lg bg-indigo-600 text-white px-6 py-2.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60 transition-colors shadow-sm"
          >
            {loading ? "Creating..." : "Create Subscription"}
          </button>
          <Link
            href="/"
            className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
          >
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
