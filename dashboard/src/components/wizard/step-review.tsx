"use client";

import { Copy, Check } from "lucide-react";
import { useState } from "react";
import { ConnectionTypeBadge } from "@/components/connection-type-badge";

interface HeaderEntry {
  key: string;
  value: string;
}

interface StepReviewProps {
  connectionType: "graphql" | "websocket";
  endpointUrl: string;
  webhookUrl: string;
  query: string;
  message: string;
  eventType: string;
  headers: HeaderEntry[];
}

export function StepReview({
  connectionType,
  endpointUrl,
  webhookUrl,
  query,
  message,
  eventType,
  headers,
}: StepReviewProps) {
  const [copied, setCopied] = useState(false);

  const activeHeaders = headers.filter((h) => h.key.trim());

  function buildPayloadPreview() {
    const args: Record<string, unknown> = {
      endpoint_url: endpointUrl,
    };

    if (activeHeaders.length > 0) {
      const headersObj: Record<string, string> = {};
      activeHeaders.forEach((h) => {
        headersObj[h.key] = h.value;
      });
      args.headers = headersObj;
    }

    if (connectionType === "graphql") {
      args.query = query;
    } else {
      if (message) args.message = message;
      if (eventType) args.event_type = eventType;
    }

    return JSON.stringify(
      {
        connection_type: connectionType,
        args,
        webhook_url: webhookUrl,
      },
      null,
      2
    );
  }

  const payload = buildPayloadPreview();

  async function copyPayload() {
    await navigator.clipboard.writeText(payload);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Review & Create</h2>
      <p className="text-sm text-neutral-500 mb-6">
        Confirm your subscription configuration before creating.
      </p>

      <div className="space-y-5">
        {/* Summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Source */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
            <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-3">
              Source
            </p>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-neutral-500">Type</p>
                <div className="mt-0.5">
                  <ConnectionTypeBadge type={connectionType} />
                </div>
              </div>
              <div>
                <p className="text-xs text-neutral-500">Endpoint</p>
                <p className="text-sm font-mono break-all mt-0.5">
                  {endpointUrl}
                </p>
              </div>
              {connectionType === "graphql" && query && (
                <div>
                  <p className="text-xs text-neutral-500">Query</p>
                  <pre className="text-xs font-mono bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2.5 mt-1 overflow-x-auto max-h-32 overflow-y-auto">
                    {query}
                  </pre>
                </div>
              )}
              {connectionType === "websocket" && message && (
                <div>
                  <p className="text-xs text-neutral-500">Initial Message</p>
                  <pre className="text-xs font-mono bg-neutral-50 dark:bg-neutral-900 rounded-lg p-2.5 mt-1 overflow-x-auto">
                    {message}
                  </pre>
                </div>
              )}
              {connectionType === "websocket" && eventType && (
                <div>
                  <p className="text-xs text-neutral-500">Event Filter</p>
                  <p className="text-sm font-mono mt-0.5">{eventType}</p>
                </div>
              )}
            </div>
          </div>

          {/* Destination */}
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
            <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-3">
              Destination
            </p>
            <div className="space-y-3">
              <div>
                <p className="text-xs text-neutral-500">Webhook URL</p>
                <p className="text-sm font-mono break-all mt-0.5">
                  {webhookUrl}
                </p>
              </div>
              <div>
                <p className="text-xs text-neutral-500">Delivery Method</p>
                <p className="text-sm mt-0.5">HTTP POST</p>
              </div>
              <div>
                <p className="text-xs text-neutral-500">Retry Policy</p>
                <p className="text-sm mt-0.5">
                  6 attempts with exponential backoff (up to 24h)
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Headers */}
        {activeHeaders.length > 0 && (
          <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
            <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider mb-3">
              Connection Headers
            </p>
            <div className="space-y-1.5">
              {activeHeaders.map((h, i) => (
                <div key={i} className="flex gap-2 text-sm">
                  <span className="font-mono font-medium text-neutral-700 dark:text-neutral-300">
                    {h.key}:
                  </span>
                  <span className="font-mono text-neutral-500 break-all">
                    {h.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* API Payload Preview */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
              API Request Preview
            </p>
            <button
              type="button"
              onClick={copyPayload}
              className="inline-flex items-center gap-1.5 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 text-emerald-500" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy JSON
                </>
              )}
            </button>
          </div>
          <pre className="text-xs font-mono bg-neutral-50 dark:bg-neutral-900 rounded-lg p-3 overflow-x-auto leading-relaxed max-h-64 overflow-y-auto">
            {payload}
          </pre>
        </div>
      </div>
    </div>
  );
}
