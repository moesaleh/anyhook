"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Bell,
  BellOff,
  Loader2,
  Mail,
  MessageSquare,
  Plus,
  Trash2,
} from "lucide-react";
import {
  fetchNotifications,
  createNotification,
  updateNotification,
  deleteNotification,
  type NotificationPreference,
  type NotificationChannel,
} from "@/lib/api";
import { useToast } from "@/lib/toast";
import { cn, formatDate } from "@/lib/utils";

/**
 * Settings → Security → Notifications panel.
 *
 * Lets owner/admin register email + Slack-webhook destinations for
 * DLQ alerts. The webhook-dispatcher already fans out via
 * lib/notifications.js when a delivery moves to the DLQ.
 *
 * Each row is independently toggleable + deletable. We don't expose
 * the per-event subscription matrix yet — only 'dlq' is wired
 * server-side, so a single checkbox per row would just always be on.
 */
export function NotificationsPanel() {
  const [prefs, setPrefs] = useState<NotificationPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const toast = useToast();

  async function load() {
    try {
      const r = await fetchNotifications();
      setPrefs(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notifications");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleToggle(p: NotificationPreference) {
    try {
      await updateNotification(p.id, { enabled: !p.enabled });
      await load();
    } catch (err) {
      toast.error(
        "Failed to toggle notification",
        err instanceof Error ? err.message : undefined
      );
    }
  }

  async function handleDelete(p: NotificationPreference) {
    if (!confirm(`Delete this ${p.channel} notification (${p.destination})?`))
      return;
    try {
      await deleteNotification(p.id);
      toast.success("Notification deleted");
      await load();
    } catch (err) {
      toast.error(
        "Failed to delete notification",
        err instanceof Error ? err.message : undefined
      );
    }
  }

  return (
    <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5">
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-start gap-3">
          <Bell className="h-5 w-5 text-neutral-500 mt-0.5" />
          <div>
            <h3 className="text-sm font-medium">Failure notifications</h3>
            <p className="text-xs text-neutral-500 mt-0.5">
              Send email or Slack alerts when a webhook delivery moves to the
              DLQ after retry-policy exhaustion.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-indigo-700"
        >
          <Plus className="h-3.5 w-3.5" /> Add destination
        </button>
      </div>

      {error && (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      {showCreate && (
        <CreateForm
          onCancel={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            load();
            toast.success("Notification destination added");
          }}
          onError={(msg) => toast.error(msg)}
        />
      )}

      {loading ? (
        <div className="px-2 py-4 flex items-center gap-2 text-sm text-neutral-500">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading...
        </div>
      ) : prefs.length === 0 ? (
        <p className="text-xs text-neutral-500 italic">
          No destinations yet. Failed deliveries still surface in the dashboard
          banner; add a destination here for out-of-band alerts.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
          {prefs.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              {p.channel === "email" ? (
                <Mail className="h-4 w-4 text-neutral-500 flex-shrink-0" />
              ) : (
                <MessageSquare className="h-4 w-4 text-neutral-500 flex-shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-sm font-mono break-all">{p.destination}</div>
                <div className="text-[10px] text-neutral-500 capitalize">
                  {p.channel} · added {formatDate(p.created_at)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleToggle(p)}
                aria-label={p.enabled ? "Pause notifications" : "Resume notifications"}
                title={p.enabled ? "Enabled — click to pause" : "Paused — click to enable"}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs",
                  p.enabled
                    ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
                    : "bg-neutral-100 dark:bg-neutral-800 text-neutral-500"
                )}
              >
                {p.enabled ? (
                  <>
                    <Bell className="h-3 w-3" /> Active
                  </>
                ) : (
                  <>
                    <BellOff className="h-3 w-3" /> Paused
                  </>
                )}
              </button>
              <button
                type="button"
                onClick={() => handleDelete(p)}
                aria-label="Delete notification destination"
                className="p-1.5 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function CreateForm({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: () => void;
  onError: (msg: string) => void;
}) {
  const [channel, setChannel] = useState<NotificationChannel>("email");
  const [destination, setDestination] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await createNotification({ channel, destination: destination.trim() });
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to add destination");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-3 flex flex-wrap items-end gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3"
    >
      <div>
        <label className="block text-xs font-medium mb-1">Channel</label>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as NotificationChannel)}
          className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm"
        >
          <option value="email">Email</option>
          <option value="slack">Slack webhook</option>
        </select>
      </div>
      <div className="flex-1 min-w-[240px]">
        <label className="block text-xs font-medium mb-1">
          {channel === "email" ? "Email address" : "Slack incoming-webhook URL"}
        </label>
        <input
          type={channel === "email" ? "email" : "url"}
          required
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
          placeholder={
            channel === "email"
              ? "alerts@example.com"
              : "https://hooks.slack.com/services/..."
          }
          className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <button
        type="submit"
        disabled={submitting || !destination.trim()}
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {submitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        Add
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={submitting}
        className="rounded-lg px-3 py-2 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
      >
        Cancel
      </button>
    </form>
  );
}
