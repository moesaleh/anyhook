"use client";

import { AlertCircle, Webhook, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepWebhookProps {
  webhookUrl: string;
  onWebhookUrlChange: (val: string) => void;
  errors: Record<string, string>;
}

export function StepWebhook({
  webhookUrl,
  onWebhookUrlChange,
  errors,
}: StepWebhookProps) {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Set Webhook Destination</h2>
      <p className="text-sm text-neutral-500 mb-6">
        Where should AnyHook deliver the data it receives from your source?
      </p>

      <div className="space-y-5">
        {/* Webhook URL */}
        <div>
          <label
            htmlFor="webhook_url"
            className="block text-sm font-medium mb-1.5"
          >
            Webhook URL <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <Webhook className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
            <input
              id="webhook_url"
              type="text"
              value={webhookUrl}
              onChange={(e) => onWebhookUrlChange(e.target.value)}
              placeholder="https://your-app.com/webhooks/anyhook"
              className={cn(
                "w-full rounded-lg border bg-white dark:bg-neutral-950 pl-10 pr-4 py-2.5 text-sm placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent",
                errors.webhookUrl
                  ? "border-red-300 dark:border-red-800"
                  : "border-neutral-200 dark:border-neutral-800"
              )}
            />
          </div>
          {errors.webhookUrl ? (
            <p className="mt-1.5 text-xs text-red-600 dark:text-red-400 flex items-center gap-1">
              <AlertCircle className="h-3 w-3" />
              {errors.webhookUrl}
            </p>
          ) : (
            <p className="mt-1 text-xs text-neutral-500">
              AnyHook will POST data payloads to this URL in real-time
            </p>
          )}
        </div>

        {/* How it works */}
        <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-5">
          <div className="flex items-start gap-3">
            <Info className="h-4 w-4 text-indigo-600 dark:text-indigo-400 mt-0.5 flex-shrink-0" />
            <div>
              <h3 className="text-sm font-medium mb-2">
                How webhook delivery works
              </h3>
              <ul className="space-y-2 text-xs text-neutral-500 leading-relaxed">
                <li className="flex items-start gap-2">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold">
                    1
                  </span>
                  Data arrives from your source (GraphQL subscription or
                  WebSocket)
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold">
                    2
                  </span>
                  AnyHook sends an HTTP POST to your webhook URL with the
                  payload as the request body
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold">
                    3
                  </span>
                  If delivery fails, AnyHook retries with exponential backoff
                  (15min, 1h, 2h, 6h, 12h, 24h)
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 text-[10px] font-bold">
                    4
                  </span>
                  After all retries are exhausted, the message is sent to a Dead
                  Letter Queue
                </li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
