"use client";

import { useState } from "react";
import { AlertCircle, Plus, Trash2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface HeaderEntry {
  key: string;
  value: string;
}

interface StepSourceConfigProps {
  connectionType: "graphql" | "websocket";
  endpointUrl: string;
  onEndpointUrlChange: (val: string) => void;
  query: string;
  onQueryChange: (val: string) => void;
  message: string;
  onMessageChange: (val: string) => void;
  eventType: string;
  onEventTypeChange: (val: string) => void;
  headers: HeaderEntry[];
  onHeadersChange: (val: HeaderEntry[]) => void;
  errors: Record<string, string>;
}

const GRAPHQL_TEMPLATE = `subscription {
  onNewEvent {
    id
    type
    payload
    timestamp
  }
}`;

export function StepSourceConfig({
  connectionType,
  endpointUrl,
  onEndpointUrlChange,
  query,
  onQueryChange,
  message,
  onMessageChange,
  eventType,
  onEventTypeChange,
  headers,
  onHeadersChange,
  errors,
}: StepSourceConfigProps) {
  const [showHeaderForm, setShowHeaderForm] = useState(headers.length > 0);

  function addHeader() {
    onHeadersChange([...headers, { key: "", value: "" }]);
  }

  function updateHeader(index: number, field: "key" | "value", val: string) {
    const updated = [...headers];
    updated[index] = { ...updated[index], [field]: val };
    onHeadersChange(updated);
  }

  function removeHeader(index: number) {
    const updated = headers.filter((_, i) => i !== index);
    onHeadersChange(updated);
    if (updated.length === 0) setShowHeaderForm(false);
  }

  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Configure Data Source</h2>
      <p className="text-sm text-neutral-500 mb-6">
        {connectionType === "graphql"
          ? "Provide the GraphQL endpoint and subscription query."
          : "Provide the WebSocket server URL and connection details."}
      </p>

      <div className="space-y-5">
        {/* Endpoint URL */}
        <div>
          <label
            htmlFor="endpoint_url"
            className="block text-sm font-medium mb-1.5"
          >
            Source Endpoint URL <span className="text-red-500">*</span>
          </label>
          <input
            id="endpoint_url"
            type="text"
            value={endpointUrl}
            onChange={(e) => onEndpointUrlChange(e.target.value)}
            placeholder={
              connectionType === "graphql"
                ? "wss://api.example.com/graphql"
                : "wss://stream.example.com/ws"
            }
            className={cn(
              "w-full rounded-lg border bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
              errors.endpointUrl
                ? "border-red-300 dark:border-red-800"
                : "border-neutral-200 dark:border-neutral-800"
            )}
          />
          {errors.endpointUrl ? (
            <p className="mt-1.5 text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {errors.endpointUrl}
            </p>
          ) : (
            <p className="mt-1 text-xs text-neutral-500">
              {connectionType === "graphql"
                ? "WebSocket-capable GraphQL endpoint (usually wss:// or ws://)"
                : "WebSocket server address (wss:// or ws://)"}
            </p>
          )}
        </div>

        {/* GraphQL Query */}
        {connectionType === "graphql" && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="query" className="block text-sm font-medium">
                Subscription Query <span className="text-red-500">*</span>
              </label>
              <button
                type="button"
                onClick={() => {
                  if (!query.trim()) onQueryChange(GRAPHQL_TEMPLATE);
                }}
                className="text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300"
              >
                Insert template
              </button>
            </div>
            <textarea
              id="query"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              rows={7}
              placeholder={GRAPHQL_TEMPLATE}
              className={cn(
                "w-full rounded-lg border bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm font-mono placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent leading-relaxed",
                errors.query
                  ? "border-red-300 dark:border-red-800"
                  : "border-neutral-200 dark:border-neutral-800"
              )}
            />
            {errors.query ? (
              <p className="mt-1.5 text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {errors.query}
              </p>
            ) : (
              <p className="mt-1 text-xs text-neutral-500">
                The GraphQL subscription query to execute on the endpoint
              </p>
            )}
          </div>
        )}

        {/* WebSocket: Initial Message */}
        {connectionType === "websocket" && (
          <>
            <div>
              <label
                htmlFor="ws_message"
                className="block text-sm font-medium mb-1.5"
              >
                Initial Message{" "}
                <span className="text-neutral-400 font-normal">(optional)</span>
              </label>
              <textarea
                id="ws_message"
                value={message}
                onChange={(e) => onMessageChange(e.target.value)}
                rows={3}
                placeholder='{"action": "subscribe", "channel": "updates"}'
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm font-mono placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <p className="mt-1 text-xs text-neutral-500">
                Sent immediately after the WebSocket connection opens
              </p>
            </div>

            <div>
              <label
                htmlFor="event_type"
                className="block text-sm font-medium mb-1.5"
              >
                Event Type Filter{" "}
                <span className="text-neutral-400 font-normal">(optional)</span>
              </label>
              <input
                id="event_type"
                type="text"
                value={eventType}
                onChange={(e) => onEventTypeChange(e.target.value)}
                placeholder="message"
                className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-4 py-2.5 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              />
              <p className="mt-1 text-xs text-neutral-500">
                Only forward messages matching this event type (leave blank for
                all)
              </p>
            </div>
          </>
        )}

        {/* Headers */}
        <div className="border-t border-neutral-200 dark:border-neutral-800 pt-5">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <label className="block text-sm font-medium">
                Connection Headers
              </label>
              <span className="text-xs text-neutral-400 font-normal">
                (optional)
              </span>
            </div>
            {!showHeaderForm && (
              <button
                type="button"
                onClick={() => {
                  setShowHeaderForm(true);
                  if (headers.length === 0) addHeader();
                }}
                className="text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 flex items-center gap-1"
              >
                <Plus className="h-3 w-3" />
                Add headers
              </button>
            )}
          </div>

          {!showHeaderForm && (
            <div className="flex items-center gap-2 rounded-lg bg-neutral-50 dark:bg-neutral-900 px-3 py-2.5 text-xs text-neutral-500">
              <Info className="h-3.5 w-3.5 flex-shrink-0" />
              Add custom headers like Authorization tokens to authenticate with
              the source endpoint.
            </div>
          )}

          {showHeaderForm && (
            <div className="space-y-2">
              {headers.map((header, index) => (
                <div key={index} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={header.key}
                    onChange={(e) => updateHeader(index, "key", e.target.value)}
                    placeholder="Header name"
                    className="flex-1 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  <input
                    type="text"
                    value={header.value}
                    onChange={(e) =>
                      updateHeader(index, "value", e.target.value)
                    }
                    placeholder="Value"
                    className="flex-[2] rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  />
                  <button
                    type="button"
                    onClick={() => removeHeader(index)}
                    className="p-2 text-neutral-400 hover:text-red-500 transition-colors"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={addHeader}
                className="inline-flex items-center gap-1.5 text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 mt-1"
              >
                <Plus className="h-3 w-3" />
                Add another header
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
