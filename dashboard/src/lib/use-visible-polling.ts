"use client";

import { useEffect, useRef, useState } from "react";

interface UseVisiblePollingOptions {
  /**
   * When false, polling is suspended regardless of tab visibility.
   * Lets pages with a manual Live/Paused toggle gate the hook without
   * fighting its internal state. Defaults to true.
   */
  enabled?: boolean;
  /**
   * When true, fire the callback once on mount (and whenever it
   * re-enables) in addition to the recurring interval. Lets callers
   * drop their own "first load" effect and centralize fetching here.
   * Defaults to false (caller owns the initial fetch).
   */
  immediate?: boolean;
}

/**
 * Runs `callback` on a fixed interval, but pauses while the tab is
 * hidden (`document.hidden`) and resumes on `visibilitychange`. This
 * centralizes the setInterval/clearInterval boilerplate every dashboard
 * polling loop used to repeat, and — crucially — stops the "real-time"
 * polling from hammering the API in background tabs.
 *
 * Returns `isPolling`: true only when the interval is actively
 * scheduled (i.e. `enabled` AND the tab is visible). Drive the
 * `LiveIndicator` from this so the UI reflects reality instead of a
 * hard-coded `true`.
 *
 * The callback is held in a ref so a changing callback identity does NOT
 * tear down and recreate the interval (which would reset the timer on
 * every render). Pass a stable `intervalMs`; change `enabled` to toggle.
 */
export function useVisiblePolling(
  callback: () => void | Promise<void>,
  intervalMs: number,
  options: UseVisiblePollingOptions = {}
): { isPolling: boolean } {
  const { enabled = true, immediate = false } = options;

  // Keep the latest callback without re-arming the interval on each render.
  const savedCallback = useRef(callback);
  useEffect(() => {
    savedCallback.current = callback;
  }, [callback]);

  const [isPolling, setIsPolling] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIsPolling(false);
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const tick = () => {
      void savedCallback.current();
    };

    const start = () => {
      if (intervalId !== null) return;
      intervalId = setInterval(tick, intervalMs);
      setIsPolling(true);
    };

    const stop = () => {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
      setIsPolling(false);
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        // Refresh immediately on return so a long-hidden tab isn't stale
        // until the next interval boundary, then resume the cadence.
        tick();
        start();
      }
    };

    // Initialize based on current visibility. When `immediate`, also run
    // the callback right away so callers can drop their own first-load
    // effect; otherwise the page already did its own initial fetch and we
    // only own the recurring interval.
    if (!document.hidden) {
      if (immediate) tick();
      start();
    } else {
      setIsPolling(false);
    }

    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      stop();
    };
  }, [enabled, intervalMs, immediate]);

  return { isPolling };
}
