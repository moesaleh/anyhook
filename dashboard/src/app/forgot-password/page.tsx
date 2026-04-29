"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { AlertCircle, ArrowLeft, Loader2, MailCheck, Webhook } from "lucide-react";
import { requestPasswordReset } from "@/lib/api";

/**
 * Anonymous reset-request page.
 *
 * The backend always returns 200 (regardless of whether the email is
 * registered) so we don't leak the user list. We surface the SAME
 * "check your inbox" success state in both cases.
 *
 * In dev (no SMTP configured), the backend returns the raw token in
 * the response body. We render a copy-to-clipboard hint + a direct
 * link to /reset-password?token=... so the flow is testable without
 * an inbox.
 */
export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ token?: string; expires_at?: string } | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const r = await requestPasswordReset(email);
      setDone({ token: r.token, expires_at: r.expires_at });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Reset request failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-6 gap-2">
          <Webhook className="h-7 w-7 text-indigo-600" />
          <span className="text-xl font-bold tracking-tight">AnyHook</span>
        </div>

        <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
          {done ? (
            <>
              <div className="flex items-center gap-2 mb-1">
                <MailCheck className="h-4 w-4 text-emerald-600" />
                <h1 className="text-lg font-semibold tracking-tight">Check your inbox</h1>
              </div>
              <p className="text-xs text-neutral-500 mb-4">
                If <span className="font-mono">{email}</span> is registered, a password
                reset link is on its way. The link expires in about 2 hours.
              </p>

              {done.token && (
                <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-3 mb-4 text-xs text-amber-800 dark:text-amber-200">
                  <p className="font-medium mb-1">Dev mode (no SMTP configured)</p>
                  <p className="mb-2">
                    The backend returned the token directly. Use it below or click the
                    link.
                  </p>
                  <code className="block bg-white dark:bg-neutral-950 rounded px-2 py-1 break-all font-mono mb-2">
                    {done.token}
                  </code>
                  <Link
                    href={`/reset-password?token=${encodeURIComponent(done.token)}`}
                    className="text-indigo-600 dark:text-indigo-400 hover:underline font-medium"
                  >
                    Continue to reset →
                  </Link>
                </div>
              )}

              <Link
                href="/login"
                className="inline-flex items-center gap-1 text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
              >
                <ArrowLeft className="h-3 w-3" /> Back to sign in
              </Link>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight mb-1">
                Reset your password
              </h1>
              <p className="text-xs text-neutral-500 mb-6">
                Enter your email address and we&apos;ll send you a reset link.
              </p>

              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label htmlFor="email" className="block text-xs font-medium mb-1.5">
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
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
                      <Loader2 className="h-4 w-4 animate-spin" /> Sending...
                    </>
                  ) : (
                    "Send reset link"
                  )}
                </button>
              </form>

              <p className="mt-6 text-center text-xs text-neutral-500">
                Remembered it?{" "}
                <Link
                  href="/login"
                  className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-medium"
                >
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
