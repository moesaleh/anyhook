"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AlertTriangle, X } from "lucide-react";
import { fetchGlobalDeliveryStats } from "@/lib/api";
import { useToast } from "@/lib/toast";

const POLL_INTERVAL_MS = 30_000;
const STORAGE_KEY = "anyhook.dlq.acked";

/**
 * Polls /deliveries/stats for the org's failed-delivery counter
 * (failed + dlq combined). When the count goes UP between polls,
 * surfaces a one-shot toast pointing at /subscriptions and increments
 * an ack threshold so the same delta isn't announced repeatedly.
 *
 * Persisted in localStorage so the banner doesn't re-fire on every
 * page navigation. The first poll establishes a baseline silently —
 * we only alert on net-new failures observed during this session
 * (or since the last user-acked baseline).
 *
 * No new backend endpoint required; the existing /deliveries/stats
 * already returns `failed`. A future enhancement could differentiate
 * dlq specifically from transient `failed` (sub-deleted-during-retry)
 * by querying delivery_events directly.
 */
export function DlqAlert() {
  const [bannerCount, setBannerCount] = useState(0);
  const baseline = useRef<number | null>(null);
  const lastSeen = useRef<number>(0);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    let ackedFromStorage = 0;
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (raw) ackedFromStorage = parseInt(raw, 10) || 0;
    } catch {
      // localStorage may be blocked
    }
    lastSeen.current = ackedFromStorage;

    async function poll() {
      try {
        const stats = await fetchGlobalDeliveryStats();
        if (!alive) return;
        const failed = stats.failed || 0;
        if (baseline.current === null) {
          // First poll — set the baseline. If a previous session left
          // an ack count behind, prefer the higher value so we don't
          // re-warn about already-acked failures.
          baseline.current = Math.max(failed, ackedFromStorage);
          lastSeen.current = baseline.current;
          return;
        }
        if (failed > lastSeen.current) {
          const delta = failed - lastSeen.current;
          lastSeen.current = failed;
          setBannerCount(c => c + delta);
          toast.error(
            `${delta} new failed deliver${delta === 1 ? "y" : "ies"}`,
            "Open the Subscriptions list and filter by status to investigate."
          );
        }
      } catch {
        // Silent — we don't want a stats failure to spam the user
      }
    }

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [toast]);

  function ack() {
    setBannerCount(0);
    try {
      window.localStorage.setItem(STORAGE_KEY, String(lastSeen.current));
    } catch {
      // ignore
    }
  }

  if (bannerCount === 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mx-6 mt-4 lg:mx-8 flex items-center justify-between gap-3 rounded-lg border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 px-4 py-2 text-sm text-red-800 dark:text-red-200"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 flex-shrink-0" />
        <span>
          <span className="font-medium">
            {bannerCount} new failed deliver{bannerCount === 1 ? "y" : "ies"}
          </span>{" "}
          since you last acknowledged.
        </span>
      </div>
      <div className="flex items-center gap-3">
        <Link
          href="/subscriptions"
          className="text-xs font-medium underline hover:no-underline"
        >
          Investigate
        </Link>
        <button
          type="button"
          onClick={ack}
          aria-label="Dismiss alert"
          className="text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
