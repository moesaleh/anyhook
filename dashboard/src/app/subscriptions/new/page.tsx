"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Key,
  Copy,
  Check,
  ShieldAlert,
} from "lucide-react";
import { createSubscription } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  WizardStepper,
  type WizardStep,
} from "@/components/wizard/wizard-stepper";
import { StepConnectionType } from "@/components/wizard/step-connection-type";
import { StepSourceConfig } from "@/components/wizard/step-source-config";
import { StepWebhook } from "@/components/wizard/step-webhook";
import { StepReview } from "@/components/wizard/step-review";

type ConnectionType = "graphql" | "websocket";

interface HeaderEntry {
  key: string;
  value: string;
}

const WIZARD_STEPS: WizardStep[] = [
  { id: 1, label: "Connection", description: "Choose source type" },
  { id: 2, label: "Source", description: "Configure endpoint" },
  { id: 3, label: "Webhook", description: "Set destination" },
  { id: 4, label: "Review", description: "Confirm & create" },
];

export default function NewSubscriptionWizard() {
  const router = useRouter();
  const [step, setStep] = useState(1);

  // Form state
  const [connectionType, setConnectionType] =
    useState<ConnectionType>("graphql");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [eventType, setEventType] = useState("");
  const [headers, setHeaders] = useState<HeaderEntry[]>([]);

  // UI state
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [success, setSuccess] = useState<{ id: string; secret: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [secretCopied, setSecretCopied] = useState(false);

  function validateStep(s: number): boolean {
    const errs: Record<string, string> = {};

    if (s === 2) {
      if (!endpointUrl.trim()) {
        errs.endpointUrl = "Source endpoint URL is required.";
      } else {
        try {
          const url = new URL(endpointUrl);
          if (!["ws:", "wss:", "http:", "https:"].includes(url.protocol)) {
            errs.endpointUrl =
              "URL must use ws://, wss://, http://, or https:// protocol.";
          }
        } catch {
          errs.endpointUrl = "Please enter a valid URL.";
        }
      }

      if (connectionType === "graphql" && !query.trim()) {
        errs.query = "A GraphQL subscription query is required.";
      }
    }

    if (s === 3) {
      if (!webhookUrl.trim()) {
        errs.webhookUrl = "Webhook URL is required.";
      } else {
        try {
          const url = new URL(webhookUrl);
          if (!["http:", "https:"].includes(url.protocol)) {
            errs.webhookUrl = "Webhook URL must use http:// or https://.";
          }
        } catch {
          errs.webhookUrl = "Please enter a valid URL.";
        }
      }
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function goNext() {
    if (!validateStep(step)) return;
    setStep((s) => Math.min(s + 1, 4));
  }

  function goBack() {
    setErrors({});
    setStep((s) => Math.max(s - 1, 1));
  }

  async function handleCreate() {
    setSubmitError(null);
    setLoading(true);

    const headersObj: Record<string, string> = {};
    headers.forEach((h) => {
      if (h.key.trim()) headersObj[h.key.trim()] = h.value;
    });

    const args: Record<string, unknown> = {
      endpoint_url: endpointUrl,
    };

    if (Object.keys(headersObj).length > 0) {
      args.headers = headersObj;
    }

    if (connectionType === "graphql") {
      args.query = query;
    } else {
      if (message) args.message = message;
      if (eventType) args.event_type = eventType;
    }

    try {
      const result = await createSubscription({
        connection_type: connectionType,
        args,
        webhook_url: webhookUrl,
      });
      setSuccess({ id: result.subscriptionId, secret: result.webhook_secret });
    } catch {
      setSubmitError(
        "Failed to create subscription. Make sure the API is running."
      );
    } finally {
      setLoading(false);
    }
  }

  async function copySecret() {
    if (!success) return;
    try {
      await navigator.clipboard.writeText(success.secret);
      setSecretCopied(true);
      setTimeout(() => setSecretCopied(false), 2000);
    } catch {
      // clipboard API can fail in non-secure contexts; keep silent
    }
  }

  // Success state — full-page confirmation with one-time secret display
  if (success) {
    return (
      <div className="p-6 lg:p-8 max-w-2xl mx-auto">
        <div className="mt-12 flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-50 dark:bg-emerald-950 flex items-center justify-center mb-5">
            <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">
            Subscription Created
          </h1>
          <p className="text-sm text-neutral-500 mb-4 max-w-md">
            Your subscription is now active. AnyHook will connect to your source
            and start delivering data to your webhook endpoint.
          </p>
          <div className="text-xs text-neutral-400 mb-1">Subscription ID</div>
          <code className="text-xs bg-neutral-100 dark:bg-neutral-900 px-3 py-1.5 rounded-lg font-mono text-neutral-600 dark:text-neutral-400 mb-6">
            {success.id}
          </code>

          {/* One-time webhook signing secret */}
          <div className="w-full max-w-xl rounded-xl border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 p-4 mb-6 text-left">
            <div className="flex items-start gap-2 mb-2">
              <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  Save your webhook signing secret — shown only once
                </p>
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                  Use this to verify the <code className="font-mono">X-AnyHook-Signature</code>{" "}
                  header on each delivery (HMAC-SHA256 of{" "}
                  <code className="font-mono">{`<timestamp>.<body>`}</code>).
                  We don&apos;t store this anywhere you can retrieve it later.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 mt-3">
              <div className="flex-1 flex items-center gap-2 rounded-lg border border-amber-200 dark:border-amber-900 bg-white dark:bg-neutral-950 px-3 py-2">
                <Key className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
                <code className="text-xs font-mono text-neutral-700 dark:text-neutral-300 break-all flex-1">
                  {success.secret}
                </code>
              </div>
              <button
                type="button"
                onClick={copySecret}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
                  secretCopied
                    ? "bg-emerald-100 dark:bg-emerald-900 text-emerald-700 dark:text-emerald-300"
                    : "bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 hover:bg-amber-200 dark:hover:bg-amber-800"
                )}
                aria-label="Copy webhook secret"
              >
                {secretCopied ? (
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

          <div className="flex gap-3">
            <Link
              href={`/subscriptions/${success.id}`}
              className="rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm"
            >
              View Subscription
            </Link>
            <Link
              href="/"
              className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-5 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
            >
              Back to Dashboard
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      {/* Back link */}
      <Link
        href="/"
        className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 mb-6"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Dashboard
      </Link>

      <h1 className="text-2xl font-bold tracking-tight mb-1">
        New Subscription
      </h1>
      <p className="text-sm text-neutral-500 mb-6">
        Connect a real-time data source to a webhook endpoint in 4 easy steps.
      </p>

      {/* Stepper */}
      <WizardStepper steps={WIZARD_STEPS} currentStep={step} />

      {/* Error banner */}
      {submitError && (
        <div className="mb-6 flex items-center gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950 px-4 py-3 text-sm text-red-700 dark:text-red-400">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {submitError}
        </div>
      )}

      {/* Step Content */}
      <div className="rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 p-6 shadow-sm">
        {step === 1 && (
          <StepConnectionType
            value={connectionType}
            onChange={setConnectionType}
          />
        )}

        {step === 2 && (
          <StepSourceConfig
            connectionType={connectionType}
            endpointUrl={endpointUrl}
            onEndpointUrlChange={setEndpointUrl}
            query={query}
            onQueryChange={setQuery}
            message={message}
            onMessageChange={setMessage}
            eventType={eventType}
            onEventTypeChange={setEventType}
            headers={headers}
            onHeadersChange={setHeaders}
            errors={errors}
          />
        )}

        {step === 3 && (
          <StepWebhook
            webhookUrl={webhookUrl}
            onWebhookUrlChange={setWebhookUrl}
            errors={errors}
          />
        )}

        {step === 4 && (
          <StepReview
            connectionType={connectionType}
            endpointUrl={endpointUrl}
            webhookUrl={webhookUrl}
            query={query}
            message={message}
            eventType={eventType}
            headers={headers}
          />
        )}
      </div>

      {/* Navigation Buttons */}
      <div className="flex items-center justify-between mt-6">
        <div>
          {step > 1 && (
            <button
              type="button"
              onClick={goBack}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2.5 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors disabled:opacity-50"
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/"
            className={cn(
              "rounded-lg px-4 py-2.5 text-sm font-medium text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 transition-colors",
              loading && "pointer-events-none opacity-50"
            )}
          >
            Cancel
          </Link>

          {step < 4 ? (
            <button
              type="button"
              onClick={goNext}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm"
            >
              Continue
              <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={loading}
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 text-white px-5 py-2.5 text-sm font-medium hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-60"
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                "Create Subscription"
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
