"use client";

import { cn } from "@/lib/utils";
import { Radio, Wifi } from "lucide-react";

type ConnectionType = "graphql" | "websocket";

interface StepConnectionTypeProps {
  value: ConnectionType;
  onChange: (type: ConnectionType) => void;
}

const connectionOptions: {
  type: ConnectionType;
  label: string;
  description: string;
  icon: typeof Radio;
  examples: string[];
}[] = [
  {
    type: "graphql",
    label: "GraphQL Subscription",
    description:
      "Subscribe to a GraphQL endpoint using the graphql-ws protocol. Best for structured, typed real-time data.",
    icon: Radio,
    examples: [
      "Live price feeds from a trading API",
      "Real-time notifications from a SaaS platform",
      "Database change streams via Hasura/PostGraphile",
    ],
  },
  {
    type: "websocket",
    label: "WebSocket",
    description:
      "Connect to a raw WebSocket server and forward messages. Best for custom protocols and binary streams.",
    icon: Wifi,
    examples: [
      "IoT sensor data streams",
      "Chat message relays",
      "Custom event bus connections",
    ],
  },
];

export function StepConnectionType({
  value,
  onChange,
}: StepConnectionTypeProps) {
  return (
    <div>
      <h2 className="text-lg font-semibold mb-1">Choose Connection Type</h2>
      <p className="text-sm text-neutral-500 mb-6">
        Select how AnyHook should connect to your data source.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {connectionOptions.map((option) => {
          const isSelected = value === option.type;
          const Icon = option.icon;

          return (
            <button
              key={option.type}
              type="button"
              onClick={() => onChange(option.type)}
              className={cn(
                "relative rounded-xl border-2 p-5 text-left transition-all duration-150",
                isSelected
                  ? "border-indigo-600 bg-indigo-50/50 ring-1 ring-indigo-600 dark:bg-indigo-950/30 dark:border-indigo-500 dark:ring-indigo-500"
                  : "border-neutral-200 dark:border-neutral-800 hover:border-neutral-300 dark:hover:border-neutral-700 bg-white dark:bg-neutral-950"
              )}
            >
              {/* Selected indicator */}
              <div
                className={cn(
                  "absolute top-4 right-4 h-5 w-5 rounded-full border-2 flex items-center justify-center transition-colors",
                  isSelected
                    ? "border-indigo-600 bg-indigo-600 dark:border-indigo-500 dark:bg-indigo-500"
                    : "border-neutral-300 dark:border-neutral-700"
                )}
              >
                {isSelected && (
                  <div className="h-2 w-2 rounded-full bg-white" />
                )}
              </div>

              <div className="flex items-center gap-3 mb-3">
                <div
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-lg",
                    isSelected
                      ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                      : "bg-neutral-100 text-neutral-500 dark:bg-neutral-900 dark:text-neutral-400"
                  )}
                >
                  <Icon className="h-5 w-5" />
                </div>
                <h3
                  className={cn(
                    "text-base font-semibold",
                    isSelected
                      ? "text-indigo-700 dark:text-indigo-300"
                      : "text-neutral-900 dark:text-neutral-100"
                  )}
                >
                  {option.label}
                </h3>
              </div>

              <p className="text-sm text-neutral-500 mb-4 leading-relaxed pr-6">
                {option.description}
              </p>

              <div className="space-y-1.5">
                <p className="text-xs font-medium text-neutral-400 uppercase tracking-wider">
                  Example use cases
                </p>
                {option.examples.map((example) => (
                  <p
                    key={example}
                    className="text-xs text-neutral-500 flex items-start gap-1.5"
                  >
                    <span className="text-neutral-300 dark:text-neutral-600 mt-0.5">
                      &bull;
                    </span>
                    {example}
                  </p>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
