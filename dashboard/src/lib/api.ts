const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

export interface Subscription {
  subscription_id: string;
  connection_type: "graphql" | "websocket";
  args: {
    query?: string;
    message?: string;
    event_type?: string;
    endpoint_url: string;
    headers?: Record<string, string>;
  };
  webhook_url: string;
  status: "active" | "inactive" | "error";
  created_at: string;
}

export interface SubscriptionStatus {
  subscription_id: string;
  db_status: string;
  connected: boolean;
  cached_at: string | null;
  checked_at: string;
}

export interface BulkStatusResponse {
  statuses: {
    subscription_id: string;
    db_status: string;
    connected: boolean;
  }[];
  checked_at: string;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  services: {
    postgres: "connected" | "disconnected";
    redis: "connected" | "disconnected";
  };
}

export interface DeliveryEvent {
  delivery_id: string;
  subscription_id: string;
  event_id: string;
  status: "success" | "failed" | "retrying" | "dlq";
  http_status_code: number | null;
  response_time_ms: number | null;
  payload_size_bytes: number | null;
  request_body: string | null;
  response_body: string | null;
  retry_count: number;
  error_message: string | null;
  created_at: string;
}

export interface DeliveryPage {
  deliveries: DeliveryEvent[];
  total: number;
  page: number;
  pages: number;
}

export interface DeliveryStats {
  total_deliveries: number;
  successful: number;
  failed: number;
  retrying: number;
  dlq: number;
  success_rate: number;
  avg_response_time_ms: number | null;
  last_delivery_at: string | null;
  deliveries_24h: number;
  deliveries_7d: number;
}

export interface GlobalDeliveryStats {
  total_deliveries: number;
  successful: number;
  failed: number;
  success_rate: number;
  avg_response_time_ms: number | null;
  deliveries_24h: number;
  deliveries_7d: number;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`, { cache: "no-store" });
  if (!res.ok) throw new Error("Health check failed");
  return res.json();
}

export async function fetchSubscriptions(): Promise<Subscription[]> {
  const res = await fetch(`${API_BASE}/subscriptions`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to fetch subscriptions");
  return res.json();
}

export async function fetchSubscription(id: string): Promise<Subscription> {
  const res = await fetch(`${API_BASE}/subscriptions/${id}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Subscription not found");
  return res.json();
}

export async function fetchSubscriptionStatus(
  id: string
): Promise<SubscriptionStatus> {
  const res = await fetch(`${API_BASE}/subscriptions/${id}/status`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch status");
  return res.json();
}

export async function fetchAllStatuses(): Promise<BulkStatusResponse> {
  const res = await fetch(`${API_BASE}/subscriptions/status/all`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch statuses");
  return res.json();
}

export async function fetchDeliveries(
  id: string,
  page = 1,
  limit = 20,
  status = "all"
): Promise<DeliveryPage> {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(limit),
    status,
  });
  const res = await fetch(
    `${API_BASE}/subscriptions/${id}/deliveries?${params}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error("Failed to fetch deliveries");
  return res.json();
}

export async function fetchDeliveryStats(
  id: string
): Promise<DeliveryStats> {
  const res = await fetch(
    `${API_BASE}/subscriptions/${id}/deliveries/stats`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error("Failed to fetch delivery stats");
  return res.json();
}

export async function fetchGlobalDeliveryStats(): Promise<GlobalDeliveryStats> {
  const res = await fetch(`${API_BASE}/deliveries/stats`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error("Failed to fetch global delivery stats");
  return res.json();
}

export async function createSubscription(data: {
  connection_type: string;
  args: Record<string, unknown>;
  webhook_url: string;
}): Promise<{ subscriptionId: string; message: string }> {
  const res = await fetch(`${API_BASE}/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to create subscription");
  return res.json();
}

export async function updateSubscription(
  id: string,
  data: {
    connection_type: string;
    args: Record<string, unknown>;
    webhook_url: string;
  }
): Promise<Subscription> {
  const res = await fetch(`${API_BASE}/subscriptions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update subscription");
  return res.json();
}

export async function deleteSubscription(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription_id: id }),
  });
  if (!res.ok) throw new Error("Failed to delete subscription");
}
