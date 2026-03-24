"use client";

import { cn } from "@/lib/utils";
import {
  Radio,
  Wifi,
  ArrowRight,
  Server,
  Webhook,
} from "lucide-react";

interface ConnectionFlowProps {
  connectionType: "graphql" | "websocket";
  endpointUrl: string;
  webhookUrl: string;
  connected: boolean;
}

export function ConnectionFlow({
  connectionType,
  endpointUrl,
  webhookUrl,
  connected,
}: ConnectionFlowProps) {
  const SourceIcon = connectionType === "graphql" ? Radio : Wifi;
  const sourceLabel = connectionType === "graphql" ? "GraphQL" : "WebSocket";

  function extractHost(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  return (
    <div className="flex items-center gap-0 overflow-x-auto py-2">
      {/* Source */}
      <div className="flex flex-col items-center gap-1.5 min-w-[120px]">
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-xl border-2",
            connected
              ? "border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
              : "border-neutral-200 bg-neutral-50 text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-600"
          )}
        >
          <SourceIcon className="h-5 w-5" />
        </div>
        <p className="text-xs font-medium text-center">{sourceLabel} Source</p>
        <p
          className="text-[10px] text-neutral-500 text-center max-w-[120px] truncate"
          title={endpointUrl}
        >
          {extractHost(endpointUrl)}
        </p>
      </div>

      {/* Arrow 1 */}
      <div className="flex flex-col items-center gap-1 mx-2 flex-shrink-0">
        <div
          className={cn(
            "flex items-center gap-0.5",
            connected ? "text-emerald-500" : "text-neutral-300 dark:text-neutral-700"
          )}
        >
          <div
            className={cn(
              "h-0.5 w-8 rounded",
              connected
                ? "bg-emerald-400 dark:bg-emerald-600"
                : "bg-neutral-200 dark:bg-neutral-800"
            )}
          />
          <ArrowRight className="h-3.5 w-3.5 -ml-1" />
        </div>
        <p className="text-[10px] text-neutral-400">stream</p>
      </div>

      {/* AnyHook */}
      <div className="flex flex-col items-center gap-1.5 min-w-[100px]">
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-xl border-2",
            connected
              ? "border-indigo-300 bg-indigo-50 text-indigo-600 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-400"
              : "border-neutral-200 bg-neutral-50 text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-600"
          )}
        >
          <Server className="h-5 w-5" />
        </div>
        <p className="text-xs font-medium text-center">AnyHook</p>
        <p className="text-[10px] text-neutral-500">proxy</p>
      </div>

      {/* Arrow 2 */}
      <div className="flex flex-col items-center gap-1 mx-2 flex-shrink-0">
        <div
          className={cn(
            "flex items-center gap-0.5",
            connected ? "text-emerald-500" : "text-neutral-300 dark:text-neutral-700"
          )}
        >
          <div
            className={cn(
              "h-0.5 w-8 rounded",
              connected
                ? "bg-emerald-400 dark:bg-emerald-600"
                : "bg-neutral-200 dark:bg-neutral-800"
            )}
          />
          <ArrowRight className="h-3.5 w-3.5 -ml-1" />
        </div>
        <p className="text-[10px] text-neutral-400">POST</p>
      </div>

      {/* Webhook */}
      <div className="flex flex-col items-center gap-1.5 min-w-[120px]">
        <div
          className={cn(
            "flex h-12 w-12 items-center justify-center rounded-xl border-2",
            connected
              ? "border-emerald-300 bg-emerald-50 text-emerald-600 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
              : "border-neutral-200 bg-neutral-50 text-neutral-400 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-600"
          )}
        >
          <Webhook className="h-5 w-5" />
        </div>
        <p className="text-xs font-medium text-center">Webhook</p>
        <p
          className="text-[10px] text-neutral-500 text-center max-w-[120px] truncate"
          title={webhookUrl}
        >
          {extractHost(webhookUrl)}
        </p>
      </div>
    </div>
  );
}
