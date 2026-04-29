import { clsx, type ClassValue } from "clsx";
import { useEffect, useState } from "react";

export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/**
 * Debounce a value so it only "settles" after the input has been
 * stable for `delayMs`. Used by the subscription table search input
 * to avoid filtering 500-row arrays on every keystroke.
 *
 * The current value updates immediately (so the input stays
 * controlled and responsive); the deferred value catches up after
 * the timer.
 */
export function useDebounced<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str;
  return str.slice(0, length) + "\u2026";
}

export function timeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Sanitise a `next`-style redirect-target query param so an attacker
 * can't craft `?next=https://evil.com/` to redirect users post-auth.
 *
 * Only same-origin paths are allowed: must start with a single `/` and
 * not with `//` (protocol-relative), `/\` (some browsers normalise
 * backslash → forward slash), or `/?` chains that confuse middleware.
 * Anything else falls back to the dashboard root.
 */
export function sanitiseNextPath(next: string | null | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/")) return "/";
  // Protocol-relative — `//evil.com` navigates to evil.com.
  if (next.startsWith("//")) return "/";
  // Browsers normalise `\` to `/`, so `/\evil.com` becomes `//evil.com`.
  if (next.startsWith("/\\")) return "/";
  return next;
}

export function formatUptime(createdAt: string): string {
  const ms = Date.now() - new Date(createdAt).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
