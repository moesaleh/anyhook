"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Loader2,
  MailPlus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import {
  fetchInvitations,
  createInvitation,
  revokeInvitation,
  type Invitation,
  type CreatedInvitation,
} from "@/lib/api";
import { cn, formatDate } from "@/lib/utils";

/**
 * Settings → Members: invitation create + list + revoke.
 *
 * The backend has had POST/GET/DELETE on /organizations/current/
 * invitations + GET /invitations/:token + POST /auth/accept-invite for
 * a while; this is the matching UI. Lives next to the existing members
 * list — the wider Settings page slots it in.
 */
export function InvitationsPanel() {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);

  async function load() {
    try {
      const r = await fetchInvitations();
      setInvitations(r);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load invitations");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this invitation? The link will stop working.")) return;
    try {
      await revokeInvitation(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Revoke failed");
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Invitations</h2>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-indigo-700"
        >
          <MailPlus className="h-3.5 w-3.5" /> Invite by email
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {created && (
        <CreatedInvitationCard
          invitation={created}
          onDismiss={() => setCreated(null)}
        />
      )}

      {showCreate && (
        <CreateInvitationForm
          onCancel={() => setShowCreate(false)}
          onCreated={(c) => {
            setCreated(c);
            setShowCreate(false);
            load();
          }}
          onError={setError}
        />
      )}

      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-hidden">
        {loading ? (
          <div className="px-4 py-12 flex items-center justify-center text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
          </div>
        ) : invitations.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-neutral-500">
            No invitations yet. Invite someone above.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800">
            <thead className="bg-neutral-50 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Email
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Role
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Status
                </th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">
                  Expires
                </th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
              {invitations.map((inv) => {
                const isPending =
                  !inv.accepted_at &&
                  !inv.revoked_at &&
                  new Date(inv.expires_at) > new Date();
                return (
                  <tr key={inv.id}>
                    <td className="px-4 py-3 text-sm font-mono">{inv.email}</td>
                    <td className="px-4 py-3 text-xs">
                      <span className="inline-flex items-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 capitalize">
                        {inv.role}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {inv.accepted_at ? (
                        <span className="inline-flex rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 px-2 py-0.5">
                          Accepted
                        </span>
                      ) : inv.revoked_at ? (
                        <span className="inline-flex rounded-full bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 px-2 py-0.5">
                          Revoked
                        </span>
                      ) : new Date(inv.expires_at) <= new Date() ? (
                        <span className="inline-flex rounded-full bg-neutral-200 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 px-2 py-0.5">
                          Expired
                        </span>
                      ) : (
                        <span className="inline-flex rounded-full bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 px-2 py-0.5">
                          Pending
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-neutral-500">
                      {formatDate(inv.expires_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isPending && (
                        <button
                          type="button"
                          onClick={() => handleRevoke(inv.id)}
                          className="p-1.5 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                          title="Revoke"
                          aria-label="Revoke invitation"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function CreateInvitationForm({
  onCancel,
  onCreated,
  onError,
}: {
  onCancel: () => void;
  onCreated: (c: CreatedInvitation) => void;
  onError: (e: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin" | "owner">("member");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const r = await createInvitation({ email: email.trim(), role });
      onCreated(r);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create invitation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-3"
    >
      <div className="flex-1 min-w-[200px]">
        <label className="block text-xs font-medium mb-1">Invitee email</label>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="someone@example.com"
          className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">Role</label>
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as "member" | "admin" | "owner")}
          className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
          <option value="owner">Owner</option>
        </select>
      </div>
      <button
        type="submit"
        disabled={submitting}
        className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
      >
        {submitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <MailPlus className="h-3.5 w-3.5" />
        )}
        Send invitation
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

function CreatedInvitationCard({
  invitation,
  onDismiss,
}: {
  invitation: CreatedInvitation;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState<"token" | "url" | null>(null);
  // Construct the accept URL the same way the backend does so the
  // operator can hand it over even when SMTP isn't configured.
  const url =
    typeof window !== "undefined" && invitation.token
      ? `${window.location.origin}/invitations/${invitation.token}`
      : "";

  async function copy(value: string, key: "token" | "url") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // ignore
    }
  }

  // Backend emailed it successfully — nothing to display, just confirm.
  if (invitation.email_sent) {
    return (
      <div className="mb-4 rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <Check className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
                Invitation emailed
              </p>
              <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">
                {invitation.email} should receive the link shortly.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-emerald-700 dark:text-emerald-300 hover:underline"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-2">
          <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
              Invitation created — share the link
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
              SMTP isn&apos;t configured, so we couldn&apos;t email it. Copy the
              link and send it to <span className="font-mono">{invitation.email}</span>{" "}
              yourself. The token is shown only once.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-amber-700 dark:text-amber-300 hover:underline"
        >
          Dismiss
        </button>
      </div>
      {invitation.token && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-white dark:bg-neutral-950 rounded-lg border border-amber-200 dark:border-amber-900 px-3 py-2 break-all">
              {url}
            </code>
            <button
              type="button"
              onClick={() => copy(url, "url")}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium",
                copied === "url"
                  ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-800"
              )}
            >
              {copied === "url" ? (
                <>
                  <Check className="h-3.5 w-3.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" /> Copy link
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
