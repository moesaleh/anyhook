"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Theme provider with three modes: 'light', 'dark', 'system'.
 *
 * - 'system' tracks `(prefers-color-scheme: dark)` live; the
 *   media-query listener is attached only while the mode is 'system'
 *   so unrelated system theme changes don't fire updates.
 * - The active mode is persisted to localStorage under `anyhook.theme`.
 * - We set `class="dark"` on <html> via documentElement so the variant
 *   in globals.css applies. Toggling happens client-only; the server
 *   always renders in light mode and React hydrates the persisted mode
 *   on mount. We attach a tiny inline script in the layout to apply
 *   the persisted class BEFORE React paints — avoids the 1-frame
 *   light flash on initial dark mode load.
 */

export type ThemeMode = "light" | "dark" | "system";
const STORAGE_KEY = "anyhook.theme";
const SYSTEM_MQ = "(prefers-color-scheme: dark)";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  /** The actually-applied theme: 'light' | 'dark'. Resolved from mode. */
  resolved: "light" | "dark";
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function applyClass(resolved: "light" | "dark") {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolved === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

function readInitialMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "light" || saved === "dark" || saved === "system") return saved;
  } catch {
    // localStorage may be blocked (incognito w/ strict settings).
  }
  return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [systemDark, setSystemDark] = useState(false);

  // Read persisted mode + initial system preference once on mount.
  useEffect(() => {
    setModeState(readInitialMode());
    if (typeof window !== "undefined" && window.matchMedia) {
      setSystemDark(window.matchMedia(SYSTEM_MQ).matches);
    }
  }, []);

  // Subscribe to system-pref changes only when needed.
  useEffect(() => {
    if (mode !== "system") return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(SYSTEM_MQ);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const resolved: "light" | "dark" =
    mode === "system" ? (systemDark ? "dark" : "light") : mode;

  // Apply on every change.
  useEffect(() => {
    applyClass(resolved);
  }, [resolved]);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    try {
      window.localStorage.setItem(STORAGE_KEY, m);
    } catch {
      // ignore
    }
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, setMode, resolved }),
    [mode, setMode, resolved]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

/**
 * Inline-script source for the document <head> to apply the persisted
 * theme class BEFORE the body paints. Must be a self-contained string
 * (no React refs) since it runs as raw HTML in the document.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');var d=t==='dark'||(t!=='light'&&window.matchMedia('${SYSTEM_MQ}').matches);if(d){document.documentElement.classList.add('dark');}}catch(_){}})();`;
