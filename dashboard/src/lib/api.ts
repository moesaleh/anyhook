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
  status: string;
  created_at: string;
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
