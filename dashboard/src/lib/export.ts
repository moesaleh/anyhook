import type { Subscription } from "./api";

/**
 * Client-side CSV / JSON export for subscription rows.
 *
 * The export omits server-only fields (organization_id, created_at)
 * and stringifies args so the file is safe to round-trip through
 * import. webhook_secret is never present (the API strips it on read).
 *
 * For round-trip-safe import: the JSON shape matches what
 * POST /subscribe accepts, so an operator can pipe the export
 * straight back through `for sub in $(jq ...) curl -X POST ...`.
 */

export interface ExportRow {
  subscription_id: string;
  connection_type: "graphql" | "websocket";
  webhook_url: string;
  args: Record<string, unknown>;
  status: string;
}

export function toExportRow(sub: Subscription): ExportRow {
  return {
    subscription_id: sub.subscription_id,
    connection_type: sub.connection_type,
    webhook_url: sub.webhook_url,
    args: sub.args as Record<string, unknown>,
    status: sub.status,
  };
}

/** Serialize as a pretty-printed JSON array. */
export function exportAsJson(subs: Subscription[]): string {
  return JSON.stringify(subs.map(toExportRow), null, 2);
}

/**
 * Serialize as CSV. RFC 4180 quoting: any field containing a quote,
 * comma, or newline is wrapped in double quotes; embedded quotes are
 * doubled. The args column is JSON-encoded since CSV can't represent
 * nested objects directly.
 */
export function exportAsCsv(subs: Subscription[]): string {
  const headers = ["subscription_id", "connection_type", "webhook_url", "args", "status"];
  const lines = [headers.join(",")];
  for (const sub of subs) {
    const row = toExportRow(sub);
    lines.push(
      [
        csvField(row.subscription_id),
        csvField(row.connection_type),
        csvField(row.webhook_url),
        csvField(JSON.stringify(row.args)),
        csvField(row.status),
      ].join(",")
    );
  }
  return lines.join("\n");
}

export function csvField(value: string | number | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/**
 * Trigger a browser download of `content` with the given filename +
 * MIME type. Uses Blob + URL.createObjectURL — no external lib.
 * Caller is responsible for choosing the extension that matches the
 * content type.
 */
export function downloadFile(content: string, filename: string, mime: string) {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Defer revoke so Safari has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
