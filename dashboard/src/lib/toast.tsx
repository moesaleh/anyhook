"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { cn } from "./utils";

/**
 * Lightweight toast system. No external dependency — a small
 * provider-and-portal that lets any component call useToast() and
 * fire a temporary banner. Replaces the hand-rolled inline error
 * blocks across the app for transient feedback.
 *
 * Stacking semantics:
 *   - Newest at the top of the stack.
 *   - Up to MAX_TOASTS at once (older ones get dropped if exceeded).
 *   - 'error' kind sticks longer than 'success' / 'info' to give the
 *     reader more time to act.
 *
 * Accessibility:
 *   - The container is role=region with aria-label so screen readers
 *     announce it as a landmark.
 *   - Each toast is role=status with aria-live=polite (errors switch
 *     to assertive).
 */

export type ToastKind = "success" | "error" | "info";

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** Optional secondary line — useful for "what happens next?" hints */
  description?: string;
  durationMs: number;
}

interface ToastContextValue {
  push: (
    message: string,
    opts?: { kind?: ToastKind; description?: string; durationMs?: number }
  ) => number;
  dismiss: (id: number) => void;
  success: (message: string, description?: string) => number;
  error: (message: string, description?: string) => number;
  info: (message: string, description?: string) => number;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_TOASTS = 4;
const DEFAULT_DURATION: Record<ToastKind, number> = {
  success: 3500,
  info: 4000,
  error: 6500,
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback<ToastContextValue["push"]>(
    (message, { kind = "info", description, durationMs } = {}) => {
      const id = nextId.current++;
      const ttl = durationMs ?? DEFAULT_DURATION[kind];
      setToasts((prev) => {
        const next = [{ id, kind, message, description, durationMs: ttl }, ...prev];
        if (next.length > MAX_TOASTS) {
          // Drop oldest; cancel its timer.
          const dropped = next.slice(MAX_TOASTS);
          for (const d of dropped) {
            const t = timers.current.get(d.id);
            if (t) {
              clearTimeout(t);
              timers.current.delete(d.id);
            }
          }
          return next.slice(0, MAX_TOASTS);
        }
        return next;
      });
      const timer = setTimeout(() => dismiss(id), ttl);
      timers.current.set(id, timer);
      return id;
    },
    [dismiss]
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      push,
      dismiss,
      success: (m, d) => push(m, { kind: "success", description: d }),
      error: (m, d) => push(m, { kind: "error", description: d }),
      info: (m, d) => push(m, { kind: "info", description: d }),
    }),
    [push, dismiss]
  );

  // Snapshot the timers Map ref synchronously for the cleanup closure
  // so React's exhaustive-deps lint stays clean and we don't read a
  // stale ref.current on unmount.
  useEffect(() => {
    const cur = timers.current;
    return () => {
      for (const t of cur.values()) clearTimeout(t);
      cur.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}

function Toaster({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  return (
    <div
      role="region"
      aria-label="Notifications"
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-full max-w-sm flex-col gap-2"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.kind === "error" ? "alert" : "status"}
          aria-live={t.kind === "error" ? "assertive" : "polite"}
          className={cn(
            "pointer-events-auto rounded-xl border shadow-sm p-3 flex items-start gap-2 animate-in fade-in slide-in-from-right-4",
            t.kind === "success" &&
              "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/60 dark:border-emerald-800 text-emerald-900 dark:text-emerald-100",
            t.kind === "error" &&
              "bg-red-50 border-red-200 dark:bg-red-950/60 dark:border-red-800 text-red-900 dark:text-red-100",
            t.kind === "info" &&
              "bg-white border-neutral-200 dark:bg-neutral-900 dark:border-neutral-800 text-neutral-900 dark:text-neutral-100"
          )}
        >
          {t.kind === "success" && (
            <CheckCircle2 className="h-4 w-4 mt-0.5 flex-shrink-0 text-emerald-600 dark:text-emerald-400" />
          )}
          {t.kind === "error" && (
            <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0 text-red-600 dark:text-red-400" />
          )}
          {t.kind === "info" && (
            <Info className="h-4 w-4 mt-0.5 flex-shrink-0 text-neutral-500" />
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium leading-snug">{t.message}</p>
            {t.description && (
              <p className="text-xs mt-0.5 opacity-80 leading-snug">{t.description}</p>
            )}
          </div>
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300 flex-shrink-0"
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
