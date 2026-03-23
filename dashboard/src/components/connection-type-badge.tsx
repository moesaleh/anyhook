import { cn } from "@/lib/utils";

interface ConnectionTypeBadgeProps {
  type: string;
}

const typeStyles: Record<string, string> = {
  graphql:
    "bg-pink-50 text-pink-700 dark:bg-pink-950 dark:text-pink-400",
  websocket:
    "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-400",
};

const typeLabels: Record<string, string> = {
  graphql: "GraphQL",
  websocket: "WebSocket",
};

export function ConnectionTypeBadge({ type }: ConnectionTypeBadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        typeStyles[type] || "bg-neutral-100 text-neutral-700"
      )}
    >
      {typeLabels[type] || type}
    </span>
  );
}
