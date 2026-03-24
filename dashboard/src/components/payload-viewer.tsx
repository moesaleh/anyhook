"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

interface PayloadViewerProps {
  requestBody: string | null;
  responseBody: string | null;
  errorMessage: string | null;
}

export function PayloadViewer({
  requestBody,
  responseBody,
  errorMessage,
}: PayloadViewerProps) {
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  function toggle(section: string) {
    setExpandedSection((prev) => (prev === section ? null : section));
  }

  async function handleCopy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  }

  function formatJson(raw: string | null): string {
    if (!raw) return "";
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  const sections = [
    { key: "request", label: "Request Body", content: requestBody },
    { key: "response", label: "Response Body", content: responseBody },
    ...(errorMessage
      ? [{ key: "error", label: "Error", content: errorMessage }]
      : []),
  ].filter((s) => s.content);

  if (sections.length === 0) {
    return (
      <p className="text-xs text-neutral-400 italic py-2">
        No payload data recorded.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {sections.map((section) => {
        const isOpen = expandedSection === section.key;
        const formatted = formatJson(section.content);

        return (
          <div key={section.key}>
            <button
              onClick={() => toggle(section.key)}
              className="flex items-center gap-1.5 text-xs font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200 py-1"
            >
              {isOpen ? (
                <ChevronDown className="h-3 w-3" />
              ) : (
                <ChevronRight className="h-3 w-3" />
              )}
              {section.label}
              {section.content && (
                <span className="text-neutral-400 font-normal">
                  ({Math.round((section.content.length / 1024) * 10) / 10}KB)
                </span>
              )}
            </button>
            {isOpen && (
              <div className="relative">
                <button
                  onClick={() => handleCopy(formatted, section.key)}
                  className="absolute top-2 right-2 text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
                  title="Copy"
                >
                  {copied === section.key ? (
                    <Check className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
                <pre
                  className={cn(
                    "text-xs font-mono rounded-lg p-3 overflow-x-auto max-h-64 overflow-y-auto leading-relaxed",
                    section.key === "error"
                      ? "bg-red-50 dark:bg-red-950/50 text-red-700 dark:text-red-400"
                      : "bg-neutral-50 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300"
                  )}
                >
                  {formatted}
                </pre>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
