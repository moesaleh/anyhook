"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  FileUp,
  Loader2,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";
import {
  createSubscriptionsBulk,
  type BulkSubscriptionEntry,
  type BulkSubscriptionResponse,
} from "@/lib/api";
import { downloadFile } from "@/lib/export";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
}

const MAX_BULK_SIZE = 100;

function isEntry(value: unknown): value is BulkSubscriptionEntry {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.connection_type === "string" &&
    typeof v.webhook_url === "string" &&
    typeof v.args === "object" &&
    v.args !== null
  );
}

/**
 * Parses an upload into a list of entries we can pass to /subscribe/bulk.
 *
 * Accepts:
 *   - An array of `{connection_type, args, webhook_url}` (the export
 *     format produced by lib/export.ts).
 *   - A single object that looks like one entry — wrapped in an array.
 *
 * Rejects malformed JSON, files larger than 1 MB (the express body
 * limit), and non-conforming entries.
 */
function parseImport(text: string): {
  entries: BulkSubscriptionEntry[];
  errors: string[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { entries: [], errors: [`JSON parse failed: ${(e as Error).message}`] };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const entries: BulkSubscriptionEntry[] = [];
  const errors: string[] = [];
  arr.forEach((row, i) => {
    if (!isEntry(row)) {
      errors.push(`Entry ${i}: missing connection_type / args / webhook_url`);
      return;
    }
    // Strip server-only / read-only fields so the body matches the
    // /subscribe/bulk schema exactly.
    entries.push({
      connection_type: row.connection_type,
      args: row.args,
      webhook_url: row.webhook_url,
    });
  });
  return { entries, errors };
}

export function ImportDialog({ open, onClose, onImported }: ImportDialogProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [filename, setFilename] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    entries: BulkSubscriptionEntry[];
    errors: string[];
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [response, setResponse] = useState<BulkSubscriptionResponse | null>(null);
  const toast = useToast();

  if (!open) return null;

  function reset() {
    setFilename(null);
    setPreview(null);
    setResponse(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  async function handleFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFilename(file.name);
    if (file.size > 1024 * 1024) {
      setPreview({
        entries: [],
        errors: [
          `File too large (${(file.size / 1024).toFixed(0)} KB). Max 1 MB.`,
        ],
      });
      return;
    }
    const text = await file.text();
    setPreview(parseImport(text));
    setResponse(null);
  }

  async function handleSubmit() {
    if (!preview || preview.entries.length === 0) return;
    if (preview.entries.length > MAX_BULK_SIZE) {
      toast.error(
        `Too many entries`,
        `Max ${MAX_BULK_SIZE} per request — split your file and import in batches.`
      );
      return;
    }
    setSubmitting(true);
    try {
      const r = await createSubscriptionsBulk(preview.entries);
      setResponse(r);
      const successCount = r.summary.successful;
      const failCount = r.summary.failed;
      if (failCount === 0) {
        toast.success(`Imported ${successCount} subscriptions`);
      } else if (successCount === 0) {
        toast.error(`Import failed`, `All ${failCount} entries rejected.`);
      } else {
        toast.error(
          `Imported ${successCount} of ${r.summary.total}`,
          `${failCount} failed — see details below.`
        );
      }
      onImported();
    } catch (err) {
      toast.error(
        "Import failed",
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setSubmitting(false);
    }
  }

  function downloadSecrets() {
    if (!response) return;
    const successful = response.results.filter(
      r => r.subscriptionId && r.webhook_secret
    );
    const json = JSON.stringify(
      successful.map(r => ({
        subscriptionId: r.subscriptionId,
        webhook_secret: r.webhook_secret,
      })),
      null,
      2
    );
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    downloadFile(json, `anyhook-import-secrets-${ts}.json`, "application/json");
  }

  function close() {
    reset();
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
      onClick={close}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-neutral-200 dark:border-neutral-800">
          <h2
            id="import-dialog-title"
            className="text-base font-semibold flex items-center gap-2"
          >
            <Upload className="h-4 w-4" /> Import subscriptions
          </h2>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            className="p-1 rounded text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-4">
          {!response && (
            <>
              <p className="text-xs text-neutral-500">
                Upload a JSON file produced by Export (or a hand-rolled list).
                Up to {MAX_BULK_SIZE} subscriptions per import.
              </p>

              {/* File picker */}
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className={cn(
                  "w-full rounded-lg border-2 border-dashed border-neutral-300 dark:border-neutral-700 px-4 py-6 text-sm flex flex-col items-center gap-2",
                  "hover:border-indigo-300 dark:hover:border-indigo-700 hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
                )}
              >
                <FileUp className="h-5 w-5 text-neutral-400" />
                <span className="font-medium">
                  {filename || "Choose a JSON file..."}
                </span>
                <span className="text-xs text-neutral-500">JSON, max 1 MB</span>
              </button>
              <input
                ref={fileInput}
                type="file"
                accept="application/json,.json"
                onChange={handleFile}
                className="hidden"
              />

              {/* Preview / errors */}
              {preview && (
                <div className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3 text-xs">
                  <div className="font-medium mb-1">
                    {preview.entries.length} subscription
                    {preview.entries.length === 1 ? "" : "s"} ready to import
                  </div>
                  {preview.entries.length > MAX_BULK_SIZE && (
                    <div className="text-amber-700 dark:text-amber-300 mt-1 flex items-start gap-1.5">
                      <ShieldAlert className="h-3.5 w-3.5 mt-0.5" />
                      Exceeds {MAX_BULK_SIZE}-entry cap. Split into multiple files.
                    </div>
                  )}
                  {preview.errors.length > 0 && (
                    <ul className="mt-2 space-y-0.5 text-red-700 dark:text-red-400">
                      {preview.errors.slice(0, 5).map((e, i) => (
                        <li key={i} className="flex items-start gap-1.5">
                          <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                          {e}
                        </li>
                      ))}
                      {preview.errors.length > 5 && (
                        <li className="text-neutral-500">
                          …and {preview.errors.length - 5} more
                        </li>
                      )}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}

          {response && (
            <ResponseView response={response} onDownloadSecrets={downloadSecrets} />
          )}
        </div>

        <div className="flex items-center justify-end gap-2 p-4 border-t border-neutral-200 dark:border-neutral-800">
          {response ? (
            <button
              type="button"
              onClick={close}
              className="rounded-lg bg-indigo-600 text-white px-4 py-2 text-sm font-medium hover:bg-indigo-700"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={close}
                className="rounded-lg px-3 py-2 text-sm font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={
                  submitting ||
                  !preview ||
                  preview.entries.length === 0 ||
                  preview.entries.length > MAX_BULK_SIZE
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
              >
                {submitting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Upload className="h-3.5 w-3.5" />
                )}
                Import
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ResponseView({
  response,
  onDownloadSecrets,
}: {
  response: BulkSubscriptionResponse;
  onDownloadSecrets: () => void;
}) {
  const successful = response.results.filter(r => r.subscriptionId);
  const failed = response.results.filter(r => r.error);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/40 px-3 py-2 text-sm">
        <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        <span>
          <span className="font-medium">{response.summary.successful}</span>{" "}
          imported, <span className="font-medium">{response.summary.failed}</span>{" "}
          failed (of {response.summary.total}).
        </span>
      </div>

      {successful.length > 0 && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3">
          <div className="flex items-start gap-2 mb-2">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Save webhook secrets
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                Each created subscription got its own secret. The receivers
                need them to verify <code>X-AnyHook-Signature</code>. Shown
                only once.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDownloadSecrets}
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 px-3 py-1.5 text-xs font-medium hover:bg-amber-200 dark:hover:bg-amber-800"
          >
            <Download className="h-3.5 w-3.5" />
            Download secrets ({successful.length})
          </button>
        </div>
      )}

      {failed.length > 0 && (
        <details className="rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-3 text-xs">
          <summary className="cursor-pointer font-medium text-red-900 dark:text-red-200">
            {failed.length} failed entr{failed.length === 1 ? "y" : "ies"}
          </summary>
          <ul className="mt-2 space-y-1 text-red-700 dark:text-red-300">
            {failed.slice(0, 10).map(f => (
              <li key={f.index}>
                <span className="font-mono">#{f.index}:</span> {f.error}
              </li>
            ))}
            {failed.length > 10 && (
              <li className="text-neutral-500">
                …and {failed.length - 10} more
              </li>
            )}
          </ul>
        </details>
      )}
    </div>
  );
}
