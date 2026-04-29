"use client";

import { useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  Check,
  Copy,
  Key,
  Loader2,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import {
  fetch2faStatus,
  start2faSetup,
  verify2faSetup,
  disable2fa,
  type TwoFactorStatus,
  type TwoFactorSetup,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type SetupPhase =
  | { kind: "idle" }
  | { kind: "loading-secret" }
  | { kind: "verifying"; secret: string; otpauth_url: string }
  | { kind: "done"; backup_codes: string[] };

type DisablePhase = { kind: "idle" } | { kind: "form" };

/**
 * Settings → Security panel. Drives the three /auth/2fa/* endpoints.
 *
 * - "Disabled" state: shows enable button → POST /setup → renders the
 *   secret + otpauth URL (so the user adds it to their authenticator
 *   app), takes a 6-digit code, POSTs /verify-setup, displays the 10
 *   one-time backup codes.
 * - "Enabled" state: shows disable button → form takes current
 *   password + a 6-digit code or backup code, POSTs /disable.
 *
 * The QR code itself is rendered lazily — we render the otpauth URL as
 * text plus a fallback that the user copies into their authenticator
 * app. Avoids pulling in a QR-code library for now; can add later.
 */
export function TwoFactorPanel() {
  const [status, setStatus] = useState<TwoFactorStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [setupPhase, setSetupPhase] = useState<SetupPhase>({ kind: "idle" });
  const [disablePhase, setDisablePhase] = useState<DisablePhase>({ kind: "idle" });

  async function load() {
    try {
      const s = await fetch2faStatus();
      setStatus(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load 2FA status");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  if (loading) {
    return (
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-8 flex items-center justify-center text-sm text-neutral-500">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading...
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-3 py-2 text-xs text-red-700 dark:text-red-400">
          <AlertCircle className="h-3.5 w-3.5" /> {error}
        </div>
      )}

      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {status?.enabled ? (
              <ShieldCheck className="h-5 w-5 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
            ) : (
              <ShieldOff className="h-5 w-5 text-neutral-400 flex-shrink-0 mt-0.5" />
            )}
            <div>
              <h3 className="text-sm font-medium">Two-factor authentication</h3>
              <p className="text-xs text-neutral-500 mt-0.5">
                {status?.enabled
                  ? `Enabled. ${status.unused_backup_codes} backup code${
                      status.unused_backup_codes === 1 ? "" : "s"
                    } remaining.`
                  : status?.enrollment_pending
                    ? "Enrollment pending — finish verification below."
                    : "Add a second factor with an authenticator app (Google Authenticator, 1Password, Authy)."}
              </p>
            </div>
          </div>
          {status?.enabled ? (
            <button
              type="button"
              onClick={() => setDisablePhase({ kind: "form" })}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 dark:border-red-900 text-red-600 dark:text-red-400 px-3 py-1.5 text-xs font-medium hover:bg-red-50 dark:hover:bg-red-950"
            >
              <ShieldOff className="h-3.5 w-3.5" /> Disable
            </button>
          ) : (
            <button
              type="button"
              disabled={setupPhase.kind !== "idle"}
              onClick={async () => {
                setError(null);
                setSetupPhase({ kind: "loading-secret" });
                try {
                  const s: TwoFactorSetup = await start2faSetup();
                  setSetupPhase({
                    kind: "verifying",
                    secret: s.secret,
                    otpauth_url: s.otpauth_url,
                  });
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Setup failed");
                  setSetupPhase({ kind: "idle" });
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-1.5 text-xs font-medium hover:bg-indigo-700 disabled:opacity-60"
            >
              {setupPhase.kind === "loading-secret" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ShieldCheck className="h-3.5 w-3.5" />
              )}{" "}
              Enable
            </button>
          )}
        </div>
      </div>

      {setupPhase.kind === "verifying" && (
        <SetupVerify
          secret={setupPhase.secret}
          otpauthUrl={setupPhase.otpauth_url}
          onCancel={() => setSetupPhase({ kind: "idle" })}
          onVerified={(codes) => {
            setSetupPhase({ kind: "done", backup_codes: codes });
            // Refresh status so the upper card shows enabled state.
            load();
          }}
          onError={setError}
        />
      )}

      {setupPhase.kind === "done" && (
        <BackupCodes
          codes={setupPhase.backup_codes}
          onDismiss={() => setSetupPhase({ kind: "idle" })}
        />
      )}

      {disablePhase.kind === "form" && (
        <DisableForm
          onCancel={() => setDisablePhase({ kind: "idle" })}
          onDone={() => {
            setDisablePhase({ kind: "idle" });
            load();
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function SetupVerify({
  secret,
  otpauthUrl,
  onCancel,
  onVerified,
  onError,
}: {
  secret: string;
  otpauthUrl: string;
  onCancel: () => void;
  onVerified: (backupCodes: string[]) => void;
  onError: (e: string) => void;
}) {
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copySecret() {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  async function handleVerify(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const r = await verify2faSetup(code.trim());
      onVerified(r.backup_codes);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4">
      <div className="flex items-start gap-2 mb-3">
        <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
        <div>
          <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
            Add to your authenticator app
          </p>
          <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
            Scan the otpauth:// URL below with your authenticator, or enter
            the secret manually. Then enter the 6-digit code it shows to
            confirm.
          </p>
        </div>
      </div>

      <div className="space-y-2 mb-4">
        <div>
          <label className="block text-xs font-medium text-amber-900 dark:text-amber-200 mb-1">
            Secret
          </label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-white dark:bg-neutral-950 rounded-lg border border-amber-200 dark:border-amber-900 px-3 py-2 break-all">
              {secret}
            </code>
            <button
              type="button"
              onClick={copySecret}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium",
                copied
                  ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
                  : "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-800"
              )}
            >
              {copied ? (
                <>
                  <Check className="h-3.5 w-3.5" /> Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" /> Copy
                </>
              )}
            </button>
          </div>
        </div>
        <details className="text-xs text-amber-700 dark:text-amber-300">
          <summary className="cursor-pointer hover:underline">
            otpauth:// URL (paste into apps that don&apos;t scan QR)
          </summary>
          <code className="mt-2 block text-[10px] font-mono break-all bg-white dark:bg-neutral-950 rounded p-2 border border-amber-200 dark:border-amber-900">
            {otpauthUrl}
          </code>
        </details>
      </div>

      <form onSubmit={handleVerify} className="flex items-end gap-2">
        <div className="flex-1">
          <label className="block text-xs font-medium text-amber-900 dark:text-amber-200 mb-1">
            6-digit code
          </label>
          <input
            type="text"
            required
            autoFocus
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="123456"
            className="w-full rounded-lg border border-amber-200 dark:border-amber-900 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
        </div>
        <button
          type="submit"
          disabled={submitting || code.trim().length !== 6}
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 text-white px-3 py-2 text-sm font-medium disabled:opacity-60"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          Verify
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="rounded-lg px-3 py-2 text-xs text-amber-700 dark:text-amber-300 hover:underline"
        >
          Cancel
        </button>
      </form>
    </div>
  );
}

function BackupCodes({ codes, onDismiss }: { codes: string[]; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore
    }
  }

  return (
    <div className="rounded-xl border border-emerald-300 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-950/40 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-2">
          <Key className="h-4 w-4 text-emerald-600 dark:text-emerald-400 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-emerald-900 dark:text-emerald-200">
              Save your backup codes
            </p>
            <p className="text-xs text-emerald-700 dark:text-emerald-300 mt-1">
              Each is single-use. Keep them somewhere you can find without
              your authenticator. We won&apos;t show them again.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-emerald-700 dark:text-emerald-300 hover:underline"
        >
          I&apos;ve saved them
        </button>
      </div>
      <pre className="text-xs font-mono bg-white dark:bg-neutral-950 rounded-lg p-3 mb-2 border border-emerald-200 dark:border-emerald-900 grid grid-cols-2 gap-x-6 gap-y-1">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </pre>
      <button
        type="button"
        onClick={copyAll}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium",
          copied
            ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
            : "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-200 dark:hover:bg-emerald-800"
        )}
      >
        {copied ? (
          <>
            <Check className="h-3.5 w-3.5" /> Copied
          </>
        ) : (
          <>
            <Copy className="h-3.5 w-3.5" /> Copy all
          </>
        )}
      </button>
    </div>
  );
}

function DisableForm({
  onCancel,
  onDone,
  onError,
}: {
  onCancel: () => void;
  onDone: () => void;
  onError: (e: string) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await disable2fa(currentPassword, code.trim());
      onDone();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Disable failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 p-4 space-y-3"
    >
      <div className="flex items-start gap-2">
        <ShieldOff className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5" />
        <div>
          <p className="text-sm font-medium text-red-900 dark:text-red-200">
            Disable two-factor authentication
          </p>
          <p className="text-xs text-red-700 dark:text-red-300 mt-1">
            Removes your authenticator binding and invalidates every backup
            code. You&apos;ll be signed out and asked to log in again.
          </p>
        </div>
      </div>
      <div>
        <label className="block text-xs font-medium text-red-900 dark:text-red-200 mb-1">
          Current password
        </label>
        <input
          type="password"
          required
          autoComplete="current-password"
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full rounded-lg border border-red-200 dark:border-red-900 bg-white dark:bg-neutral-950 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-500"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-red-900 dark:text-red-200 mb-1">
          6-digit code or backup code
        </label>
        <input
          type="text"
          required
          autoComplete="one-time-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="123456 or aaaa-bbbb"
          className="w-full rounded-lg border border-red-200 dark:border-red-900 bg-white dark:bg-neutral-950 px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={submitting || !currentPassword || !code.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 text-white px-3 py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-60"
        >
          {submitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldOff className="h-3.5 w-3.5" />
          )}
          Disable 2FA
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="text-xs text-red-700 dark:text-red-300 hover:underline"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
