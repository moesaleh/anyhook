"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { AlertCircle, Loader2, ShieldCheck, Webhook } from "lucide-react";
import { login, loginNeeds2fa, verifyLogin2fa } from "@/lib/api";
import { sanitiseNextPath } from "@/lib/utils";

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell />}>
      <LoginForm />
    </Suspense>
  );
}

function LoginShell() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-neutral-50 dark:bg-neutral-950">
      <Loader2 className="h-5 w-5 animate-spin text-neutral-400" />
    </div>
  );
}

function LoginForm() {
  const searchParams = useSearchParams();
  const next = sanitiseNextPath(searchParams.get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 2FA second-step state. When pendingToken is non-null the form
  // switches from email/password to a code input. The pending JWT is
  // valid for 5 minutes — re-login on expiry rather than refreshing.
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await login(email, password);
      if (loginNeeds2fa(result)) {
        // 2FA required — switch the form into code-entry mode. No
        // session cookie has been set yet.
        setPendingToken(result.pending_token);
        setSubmitting(false);
        return;
      }
      // Use a hard navigation so middleware re-runs with the new cookie
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      setSubmitting(false);
    }
  }

  async function handleVerify2fa(e: FormEvent) {
    e.preventDefault();
    if (!pendingToken) return;
    setError(null);
    setSubmitting(true);
    try {
      await verifyLogin2fa(pendingToken, code.trim());
      window.location.href = next;
    } catch (err) {
      setError(err instanceof Error ? err.message : "2FA verification failed");
      setSubmitting(false);
    }
  }

  function cancel2fa() {
    setPendingToken(null);
    setCode("");
    setError(null);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-neutral-50 dark:bg-neutral-950">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center mb-6 gap-2">
          <Webhook className="h-7 w-7 text-indigo-600" />
          <span className="text-xl font-bold tracking-tight">AnyHook</span>
        </div>

        <div className="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
          {pendingToken ? (
            <>
              <div className="flex items-center gap-2 mb-1">
                <ShieldCheck className="h-4 w-4 text-indigo-600" />
                <h1 className="text-lg font-semibold tracking-tight">
                  Two-factor verification
                </h1>
              </div>
              <p className="text-xs text-neutral-500 mb-6">
                Enter the 6-digit code from your authenticator app, or one of
                your backup codes.
              </p>

              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleVerify2fa} className="space-y-4">
                <div>
                  <label htmlFor="code" className="block text-xs font-medium mb-1.5">
                    Code
                  </label>
                  <input
                    id="code"
                    type="text"
                    required
                    autoFocus
                    autoComplete="one-time-code"
                    inputMode="text"
                    placeholder="123456 or aaaa-bbbb"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting || !code.trim()}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-60"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Verifying...
                    </>
                  ) : (
                    "Verify"
                  )}
                </button>
                <button
                  type="button"
                  onClick={cancel2fa}
                  disabled={submitting}
                  className="w-full text-xs text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 disabled:opacity-50"
                >
                  Use a different account
                </button>
              </form>
            </>
          ) : (
            <>
              <h1 className="text-lg font-semibold tracking-tight mb-1">Sign in</h1>
              <p className="text-xs text-neutral-500 mb-6">
                Sign in to manage your webhook subscriptions.
              </p>

              {error && (
                <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
                  <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <label
                    htmlFor="email"
                    className="block text-xs font-medium mb-1.5"
                  >
                    Email
                  </label>
                  <input
                    id="email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="password"
                    className="block text-xs font-medium mb-1.5"
                  >
                    Password
                  </label>
                  <input
                    id="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 text-white px-4 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-60"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Signing in...
                    </>
                  ) : (
                    "Sign in"
                  )}
                </button>
              </form>

              <p className="mt-6 text-center text-xs text-neutral-500 space-x-3">
                <Link
                  href="/forgot-password"
                  className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-medium"
                >
                  Forgot password?
                </Link>
                <span>·</span>
                <Link
                  href="/register"
                  className="text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 font-medium"
                >
                  Create an account
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
