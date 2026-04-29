"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  AlertCircle,
  Building2,
  Loader2,
  ShieldCheck,
  Webhook,
} from "lucide-react";
import { acceptInvite, lookupInvitation, type InvitationLookup } from "@/lib/api";

/**
 * Anonymous invitation-accept landing page.
 *
 * Path: /invitations/[token]. The middleware whitelists this prefix
 * so an unauthenticated invitee can land here. We do a read-only
 * lookup (GET /invitations/:token) to render the org name + role,
 * then take a password to redeem the token via POST /auth/accept-invite.
 *
 * Existing-user case: the backend rejects with 409 when the email is
 * already registered. We surface that with a hint to log in instead.
 */
export default function AcceptInvitePage() {
  const params = useParams();
  const token = (params.token as string) || "";

  const [info, setInfo] = useState<InvitationLookup | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await lookupInvitation(token);
        if (alive) setInfo(r);
      } catch (err) {
        if (alive)
          setLoadError(err instanceof Error ? err.message : "Invitation not found");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    if (password.length < 8) {
      setSubmitError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setSubmitError("Passwords do not match");
      return;
    }
    setSubmitting(true);
    try {
      await acceptInvite({ token, password, name: name.trim() || undefined });
      window.location.href = "/";
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to accept invitation");
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10 bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-6 gap-2">
          <Webhook className="h-7 w-7 text-indigo-600" />
          <span className="text-xl font-bold tracking-tight">AnyHook</span>
        </div>

        <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-sm text-neutral-500">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
            </div>
          ) : loadError || !info ? (
            <>
              <div className="flex items-center gap-2 mb-1">
                <AlertCircle className="h-4 w-4 text-red-600" />
                <h1 className="text-lg font-semibold tracking-tight">
                  Invitation unavailable
                </h1>
              </div>
              <p className="text-xs text-neutral-500 mb-4">
                {loadError || "This invitation is invalid, expired, or revoked."}
              </p>
              <Link
                href="/login"
                className="text-xs text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-medium"
              >
                Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight mb-1">
                Accept invitation
              </h1>
              <div className="text-xs text-neutral-500 mb-4 space-y-1">
                <p className="flex items-center gap-1.5">
                  <Building2 className="h-3.5 w-3.5" />
                  Joining{" "}
                  <span className="font-medium text-neutral-700 dark:text-neutral-300">
                    {info.organization_name}
                  </span>{" "}
                  as{" "}
                  <span className="capitalize font-medium text-neutral-700 dark:text-neutral-300">
                    {info.role}
                  </span>
                  .
                </p>
                <p className="flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  Account email:{" "}
                  <span className="font-mono">{info.email}</span>
                </p>
              </div>

              {submitError && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>{submitError}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium mb-1.5">
                    Your name{" "}
                    <span className="text-neutral-400 font-normal">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    autoComplete="name"
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5">Password</label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5">
                    Confirm password
                  </label>
                  <input
                    type="password"
                    required
                    minLength={8}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-indigo-700 disabled:opacity-60"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Accepting...
                    </>
                  ) : (
                    "Accept and create account"
                  )}
                </button>
              </form>

              <p className="mt-6 text-center text-xs text-neutral-500">
                Already registered?{" "}
                <Link
                  href="/login"
                  className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-medium"
                >
                  Sign in
                </Link>{" "}
                instead — an admin can add you to the organization.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
