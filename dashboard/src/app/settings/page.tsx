"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Plus,
  Trash2,
  Key,
  Copy,
  Check,
  ShieldAlert,
  Loader2,
  UserPlus,
  Building2,
} from "lucide-react";
import {
  fetchOrgMembers,
  addOrgMember,
  removeOrgMember,
  fetchApiKeys,
  createApiKey,
  revokeApiKey,
  createOrganization,
  type OrganizationMember,
  type ApiKey,
  type CreatedApiKey,
} from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/lib/toast";
import { cn, formatDate } from "@/lib/utils";
import { TwoFactorPanel } from "@/components/two-factor-panel";
import { ChangePasswordForm } from "@/components/change-password-form";
import { InvitationsPanel } from "@/components/invitations-panel";

export default function SettingsPage() {
  const { user, organization, organizations, refresh } = useAuth();
  const [tab, setTab] = useState<
    "members" | "api-keys" | "organizations" | "security"
  >("members");

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-neutral-500 mt-1">
          {organization
            ? `Manage members and API keys for ${organization.name}.`
            : "Manage your account."}
        </p>
      </div>

      <div className="border-b border-neutral-200 dark:border-neutral-800 mb-6">
        <nav className="-mb-px flex gap-6">
          {(["members", "api-keys", "organizations", "security"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={cn(
                "border-b-2 px-1 py-2.5 text-sm font-medium transition-colors capitalize",
                tab === t
                  ? "border-indigo-600 text-indigo-700 dark:text-indigo-300"
                  : "border-transparent text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              )}
            >
              {t.replace("-", " ")}
            </button>
          ))}
        </nav>
      </div>

      {tab === "members" && (
        <div className="space-y-8">
          <MembersPanel currentUserId={user?.id || null} />
          <InvitationsPanel />
        </div>
      )}
      {tab === "api-keys" && <ApiKeysPanel />}
      {tab === "organizations" && (
        <OrganizationsPanel
          organizations={organizations}
          currentOrgId={organization?.id || null}
          onCreated={refresh}
        />
      )}
      {tab === "security" && (
        <div className="space-y-6">
          <ChangePasswordForm />
          <TwoFactorPanel />
        </div>
      )}
    </div>
  );
}

/* ── Members tab ─────────────────────────────────────────────── */

function MembersPanel({ currentUserId }: { currentUserId: string | null }) {
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addEmail, setAddEmail] = useState("");
  const [addRole, setAddRole] = useState<"member" | "admin" | "owner">("member");
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  async function load() {
    try {
      const data = await fetchOrgMembers();
      setMembers(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await addOrgMember(addEmail.trim(), addRole);
      toast.success(`Added ${addEmail.trim()} as ${addRole}`);
      setAddEmail("");
      setShowAdd(false);
      await load();
    } catch (err) {
      toast.error(
        "Failed to add member",
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setAdding(false);
    }
  }

  async function handleRemove(userId: string) {
    if (!confirm("Remove this member from the organization?")) return;
    try {
      await removeOrgMember(userId);
      toast.success("Member removed");
      await load();
    } catch (err) {
      toast.error(
        "Failed to remove member",
        err instanceof Error ? err.message : undefined
      );
    }
  }

  async function handleRoleChange(
    member: OrganizationMember,
    role: "owner" | "admin" | "member"
  ) {
    if (role === member.role) return;
    setError(null);
    try {
      // POST /organizations/current/members is `INSERT ... ON CONFLICT
      // DO UPDATE SET role`, so the same endpoint serves "add" and
      // "change role" — backend RBAC enforces the owner-protection
      // rules (commit 51d290f).
      await addOrgMember(member.email, role);
      toast.success(`${member.email} is now ${role}`);
      await load();
    } catch (err) {
      toast.error(
        "Failed to change role",
        err instanceof Error ? err.message : undefined
      );
      // Refresh anyway in case the backend rolled back partway
      await load();
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Members</h2>
        <button
          type="button"
          onClick={() => setShowAdd((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-indigo-700 transition-colors"
        >
          <UserPlus className="h-3.5 w-3.5" /> Add member
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {showAdd && (
        <form
          onSubmit={handleAdd}
          className="mb-4 flex flex-wrap items-end gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-3"
        >
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium mb-1">Email</label>
            <input
              type="email"
              required
              value={addEmail}
              onChange={(e) => setAddEmail(e.target.value)}
              placeholder="someone@example.com"
              className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium mb-1">Role</label>
            <select
              value={addRole}
              onChange={(e) =>
                setAddRole(e.target.value as "member" | "admin" | "owner")
              }
              className="rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm"
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
              <option value="owner">Owner</option>
            </select>
          </div>
          <button
            type="submit"
            disabled={adding}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Add
          </button>
          <p className="w-full text-xs text-neutral-500 mt-1">
            User must have already registered. To invite by email, use the
            Invitations panel below.
          </p>
        </form>
      )}

      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-hidden">
        {loading ? (
          <div className="px-4 py-12 flex items-center justify-center text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
          </div>
        ) : (
          <table className="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800">
            <thead className="bg-neutral-50 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">User</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Role</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Joined</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
              {members.map((m) => (
                <tr key={m.id}>
                  <td className="px-4 py-3 text-sm">
                    <div className="font-medium">{m.name || m.email.split("@")[0]}</div>
                    <div className="text-xs text-neutral-500">{m.email}</div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {m.id === currentUserId ? (
                      <span className="inline-flex items-center rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 capitalize">
                        {m.role}
                      </span>
                    ) : (
                      <select
                        value={m.role}
                        onChange={(e) =>
                          handleRoleChange(
                            m,
                            e.target.value as "owner" | "admin" | "member"
                          )
                        }
                        className="rounded-md border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-2 py-0.5 text-xs capitalize"
                        aria-label={`Role for ${m.email}`}
                      >
                        <option value="member">member</option>
                        <option value="admin">admin</option>
                        <option value="owner">owner</option>
                      </select>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-neutral-500">
                    {formatDate(m.created_at)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {m.id !== currentUserId && (
                      <button
                        type="button"
                        onClick={() => handleRemove(m.id)}
                        className="p-1.5 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                        title="Remove member"
                        aria-label="Remove member"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ── API Keys tab ─────────────────────────────────────────────── */

function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);

  async function load() {
    try {
      const data = await fetchApiKeys();
      setKeys(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const result = await createApiKey({ name: keyName.trim() });
      setCreated(result);
      setKeyName("");
      setShowCreate(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string) {
    if (!confirm("Revoke this API key? Any clients using it will stop working immediately.")) return;
    try {
      await revokeApiKey(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to revoke API key");
    }
  }

  async function copyKey() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">API Keys</h2>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-indigo-700"
        >
          <Plus className="h-3.5 w-3.5" /> New API key
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      {created && (
        <div className="mb-4 rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
          <div className="flex items-start gap-2 mb-3">
            <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
            <div className="flex-1">
              <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                Save your API key — shown only once
              </p>
              <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                Use as <code className="font-mono">Authorization: Bearer {"<key>"}</code>.
                Closing this banner will hide the value forever.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setCreated(null)}
              className="text-xs text-amber-600 hover:text-amber-800 dark:text-amber-400 underline"
            >
              Dismiss
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-white dark:bg-neutral-950 px-3 py-2">
              <Key className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
              <code className="text-xs font-mono break-all flex-1">{created.key}</code>
            </div>
            <button
              type="button"
              onClick={copyKey}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
                copied
                  ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-800"
              )}
            >
              {copied ? <><Check className="h-3.5 w-3.5" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
            </button>
          </div>
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-4 flex items-end gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-3"
        >
          <div className="flex-1">
            <label className="block text-xs font-medium mb-1">Key name</label>
            <input
              type="text"
              required
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="e.g. Production Server"
              className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Create
          </button>
        </form>
      )}

      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-hidden">
        {loading ? (
          <div className="px-4 py-12 flex items-center justify-center text-sm text-neutral-500">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
          </div>
        ) : keys.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-neutral-500">
            No API keys yet. Create one to authenticate API clients.
          </div>
        ) : (
          <table className="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800">
            <thead className="bg-neutral-50 dark:bg-neutral-900">
              <tr>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Name</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Prefix</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Created</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Last used</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-neutral-500 uppercase tracking-wider">Status</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-100 dark:divide-neutral-800/50">
              {keys.map((k) => (
                <tr key={k.id}>
                  <td className="px-4 py-3 text-sm font-medium">{k.name}</td>
                  <td className="px-4 py-3 text-xs font-mono text-neutral-500">{k.key_prefix}…</td>
                  <td className="px-4 py-3 text-xs text-neutral-500">{formatDate(k.created_at)}</td>
                  <td className="px-4 py-3 text-xs text-neutral-500">
                    {k.last_used_at ? formatDate(k.last_used_at) : "—"}
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {k.revoked_at ? (
                      <span className="inline-flex items-center rounded-full bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-300 px-2 py-0.5">Revoked</span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 px-2 py-0.5">Active</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!k.revoked_at && (
                      <button
                        type="button"
                        onClick={() => handleRevoke(k.id)}
                        className="p-1.5 rounded-md text-neutral-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
                        title="Revoke key"
                        aria-label="Revoke key"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/* ── Organizations tab ─────────────────────────────────────────────── */

function OrganizationsPanel({
  organizations,
  currentOrgId,
  onCreated,
}: {
  organizations: { id: string; name: string; slug: string; role?: string }[];
  currentOrgId: string | null;
  onCreated: () => Promise<void>;
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await createOrganization(name.trim());
      setName("");
      setShowCreate(false);
      await onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-base font-semibold">Your Organizations</h2>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-indigo-700"
        >
          <Plus className="h-3.5 w-3.5" /> New organization
        </button>
      </div>

      {error && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="mb-4 flex items-end gap-2 rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-3"
        >
          <div className="flex-1">
            <label className="block text-xs font-medium mb-1">Organization name</label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Inc."
              className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
          >
            {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            Create
          </button>
        </form>
      )}

      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 overflow-hidden divide-y divide-neutral-100 dark:divide-neutral-800/50">
        {organizations.map((org) => (
          <div key={org.id} className="flex items-center gap-3 px-4 py-3">
            <Building2 className="h-4 w-4 text-neutral-400 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{org.name}</div>
              <div className="text-xs text-neutral-500 font-mono">{org.slug}</div>
            </div>
            {org.role && (
              <span className="text-xs rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 capitalize">
                {org.role}
              </span>
            )}
            {org.id === currentOrgId && (
              <span className="text-xs rounded-full bg-indigo-100 dark:bg-indigo-950 text-indigo-700 dark:text-indigo-300 px-2 py-0.5">
                Active
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
