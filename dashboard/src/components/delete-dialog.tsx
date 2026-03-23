"use client";

import { AlertTriangle, X } from "lucide-react";

interface DeleteDialogProps {
  open: boolean;
  subscriptionId: string;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}

export function DeleteDialog({
  open,
  subscriptionId,
  onConfirm,
  onCancel,
  loading,
}: DeleteDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-white dark:bg-neutral-950 rounded-xl border border-neutral-200 dark:border-neutral-800 shadow-xl max-w-md w-full mx-4 p-6">
        <button
          onClick={onCancel}
          className="absolute top-4 right-4 text-neutral-400 hover:text-neutral-600"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-start gap-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-full bg-red-50 dark:bg-red-950 flex items-center justify-center">
            <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
          </div>
          <div className="flex-1">
            <h3 className="text-base font-semibold">Delete Subscription</h3>
            <p className="mt-2 text-sm text-neutral-500">
              Are you sure you want to delete subscription{" "}
              <code className="text-xs bg-neutral-100 dark:bg-neutral-900 px-1.5 py-0.5 rounded font-mono">
                {subscriptionId.slice(0, 12)}...
              </code>
              ? This will disconnect the source and stop all webhook deliveries.
              This action cannot be undone.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-3 mt-6">
          <button
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg border border-neutral-200 dark:border-neutral-800 px-4 py-2 text-sm font-medium hover:bg-neutral-50 dark:hover:bg-neutral-900 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={loading}
            className="rounded-lg bg-red-600 text-white px-4 py-2 text-sm font-medium hover:bg-red-700 disabled:opacity-60 transition-colors"
          >
            {loading ? "Deleting..." : "Delete Subscription"}
          </button>
        </div>
      </div>
    </div>
  );
}
