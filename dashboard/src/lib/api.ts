const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001";

// Default per-request timeout. Mutating endpoints (POST/PUT/DELETE)
// can run a bit longer than reads — webhook delivery + sub-create
// path involves Kafka writes. Read endpoints get the shorter timeout.
const DEFAULT_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 30_000;

// Default fetch options. credentials: "include" sends the session cookie
// cross-origin (dashboard:3000 -> api:3001). Backend CORS sets
// Access-Control-Allow-Credentials: true to allow this.
const DEFAULT_FETCH_INIT: RequestInit = {
  credentials: "include",
  cache: "no-store",
};

/**
 * Error thrown when the backend returns 429. Carries the parsed
 * Retry-After (seconds) so callers can render a friendlier UI than
 * "Failed".
 */
export class RateLimitError extends Error {
  retryAfterSec: number;
  constructor(message: string, retryAfterSec: number) {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSec = retryAfterSec;
  }
}

/** Error thrown when the request exceeded its timeout. */
export class TimeoutError extends Error {
  constructor(message = "Request timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** Error thrown when the browser is offline (navigator.onLine === false). */
export class OfflineError extends Error {
  constructor() {
    super("You appear to be offline");
    this.name = "OfflineError";
  }
}

function isMutating(method: string | undefined): boolean {
  if (!method) return false;
  const m = method.toUpperCase();
  return m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE";
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  // Cheap online check: don't even attempt the request when the
  // browser is offline — we'd hit a network error after a timeout
  // and the resulting message would be the same. This way the
  // caller can render an "offline" UI without waiting.
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    throw new OfflineError();
  }
  const timeoutMs = isMutating(init?.method) ? MUTATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      ...DEFAULT_FETCH_INIT,
      ...init,
      headers: { ...(init?.headers || {}) },
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      const ra = parseInt(res.headers.get("Retry-After") || "60", 10);
      let serverMsg = "Rate limit exceeded";
      try {
        const body = await res.clone().json();
        if (body?.error) serverMsg = body.error;
      } catch {
        // ignore JSON parse failures
      }
      throw new RateLimitError(serverMsg, Number.isFinite(ra) ? ra : 60);
    }
    return res;
  } catch (err) {
    if (err instanceof RateLimitError || err instanceof OfflineError) throw err;
    if ((err as { name?: string })?.name === "AbortError") {
      throw new TimeoutError();
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- Auth + tenancy types ---

export interface User {
  id: string;
  email: string;
  name: string | null;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  role?: "owner" | "admin" | "member";
}

export interface SessionResponse {
  user: User | null;
  organization: Organization | null;
  organizations: Organization[];
  via?: "cookie" | "api_key";
}

export interface OrganizationMember {
  id: string;
  email: string;
  name: string | null;
  role: "owner" | "admin" | "member";
  created_at: string;
}

export interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreatedApiKey extends ApiKey {
  // Raw key value, returned ONCE on creation only
  key: string;
  message: string;
}

export interface QuotaUsage {
  used: number;
  limit: number;
}

export interface QuotasResponse {
  subscriptions: QuotaUsage;
  api_keys: QuotaUsage;
}

export interface Subscription {
  subscription_id: string;
  organization_id: string;
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

// --- Auth API ---

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.status = status;
  }
}

function checkAuth(res: Response): void {
  if (res.status === 401 || res.status === 403) {
    throw new AuthError("Not authenticated", res.status);
  }
}

export async function fetchMe(): Promise<SessionResponse> {
  const res = await apiFetch("/auth/me");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to load session");
  return res.json();
}

/**
 * Result of POST /auth/login. The endpoint behaves in two modes:
 *
 *   - 2FA disabled: returns the full SessionResponse and sets the
 *     anyhook_session cookie. `needs_2fa` is absent / false.
 *
 *   - 2FA enabled: returns { needs_2fa: true, pending_token } with NO
 *     cookie set. The caller must POST /auth/2fa/verify-login with
 *     the pending_token + a 6-digit TOTP (or backup code) to complete
 *     the login.
 *
 * The discriminated-union shape lets the login page branch on
 * `needs_2fa` without a runtime guess. Receivers should `if
 * ("needs_2fa" in result)` style or use the helper below.
 */
export type LoginResult =
  | { needs_2fa: true; pending_token: string }
  | (SessionResponse & { needs_2fa?: false });

export function loginNeeds2fa(
  r: LoginResult
): r is { needs_2fa: true; pending_token: string } {
  return r && (r as { needs_2fa?: boolean }).needs_2fa === true;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await apiFetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Login failed");
  }
  return res.json();
}

/**
 * Second-step login when 2FA is enabled. Submits the pending_token
 * obtained from `login()` together with a 6-digit TOTP or
 * `xxxxxxxx-xxxxxxxx` (or legacy `xxxx-xxxx`) backup code. On success
 * the anyhook_session cookie is set and the SessionResponse is
 * returned.
 */
export async function verifyLogin2fa(
  pendingToken: string,
  code: string
): Promise<SessionResponse> {
  const res = await apiFetch("/auth/2fa/verify-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pending_token: pendingToken, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "2FA verification failed");
  }
  return res.json();
}

/* --- 2FA management (settings page) --- */

export interface TwoFactorStatus {
  enabled: boolean;
  enrollment_pending: boolean;
  unused_backup_codes: number;
}

export async function fetch2faStatus(): Promise<TwoFactorStatus> {
  const res = await apiFetch("/auth/2fa/status");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to load 2FA status");
  return res.json();
}

export interface TwoFactorSetup {
  secret: string;
  otpauth_url: string;
}

export async function start2faSetup(): Promise<TwoFactorSetup> {
  const res = await apiFetch("/auth/2fa/setup", { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to start 2FA setup");
  }
  return res.json();
}

export interface TwoFactorVerifySetup {
  enabled: true;
  backup_codes: string[];
  message: string;
}

export async function verify2faSetup(code: string): Promise<TwoFactorVerifySetup> {
  const res = await apiFetch("/auth/2fa/verify-setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to verify 2FA setup");
  }
  return res.json();
}

/* --- Password change + reset --- */

export interface PasswordResetRequest {
  message: string;
  email_sent: boolean;
  // Dev / no-SMTP convenience: when the backend has no SMTP transport
  // configured it returns the raw token in the response so the flow
  // works end-to-end without an inbox. With SMTP working this field
  // is absent (the user gets the token in their email).
  token?: string;
  expires_at?: string;
}

export async function requestPasswordReset(email: string): Promise<PasswordResetRequest> {
  const res = await apiFetch("/auth/password/reset-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Reset request failed");
  }
  return res.json();
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const res = await apiFetch("/auth/password/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, new_password: newPassword }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Reset failed");
  }
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const res = await apiFetch("/auth/password/change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Password change failed");
  }
}

export async function disable2fa(currentPassword: string, code: string): Promise<void> {
  const res = await apiFetch("/auth/2fa/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: currentPassword, code }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to disable 2FA");
  }
}

export async function registerUser(data: {
  email: string;
  password: string;
  name?: string;
  organization_name?: string;
}): Promise<SessionResponse> {
  const res = await apiFetch("/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Registration failed");
  }
  return res.json();
}

export async function logout(): Promise<void> {
  await apiFetch("/auth/logout", { method: "POST" });
}

export async function switchOrganization(
  organizationId: string
): Promise<{ organization_id: string }> {
  const res = await apiFetch("/auth/switch-org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organization_id: organizationId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to switch organization");
  }
  return res.json();
}

export async function createOrganization(name: string): Promise<Organization> {
  const res = await apiFetch("/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create organization");
  }
  return res.json();
}

export async function fetchOrgMembers(): Promise<OrganizationMember[]> {
  const res = await apiFetch("/organizations/current/members");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to load members");
  return res.json();
}

export async function addOrgMember(
  email: string,
  role: "owner" | "admin" | "member" = "member"
): Promise<{ user_id: string; role: string }> {
  const res = await apiFetch("/organizations/current/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to add member");
  }
  return res.json();
}

export async function removeOrgMember(userId: string): Promise<void> {
  const res = await apiFetch(
    `/organizations/current/members/${userId}`,
    { method: "DELETE" }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to remove member");
  }
}

/* --- Invitations --- */

export interface Invitation {
  id: string;
  organization_id?: string;
  email: string;
  role: "owner" | "admin" | "member";
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface CreatedInvitation extends Invitation {
  // Returned ONCE on creation when SMTP is unconfigured (dev mode).
  // Absent when the backend successfully emailed the invitee.
  token?: string;
  email_sent: boolean;
  message: string;
}

export async function fetchInvitations(): Promise<Invitation[]> {
  const res = await apiFetch("/organizations/current/invitations");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to load invitations");
  return res.json();
}

export async function createInvitation(data: {
  email: string;
  role?: "owner" | "admin" | "member";
  expires_in_days?: number;
}): Promise<CreatedInvitation> {
  const res = await apiFetch("/organizations/current/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create invitation");
  }
  return res.json();
}

export async function revokeInvitation(id: string): Promise<void> {
  const res = await apiFetch(`/organizations/current/invitations/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to revoke invitation");
  }
}

export interface InvitationLookup {
  email: string;
  role: "owner" | "admin" | "member";
  organization_name: string;
  expires_at: string;
}

/** Anonymous: read-only lookup for the registration page. */
export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  const res = await apiFetch(`/invitations/${encodeURIComponent(token)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Invitation not found");
  }
  return res.json();
}

/** Anonymous: redeem an invitation token + create a user. */
export async function acceptInvite(data: {
  token: string;
  password: string;
  name?: string;
}): Promise<SessionResponse> {
  const res = await apiFetch("/auth/accept-invite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to accept invitation");
  }
  return res.json();
}

export async function fetchQuotas(): Promise<QuotasResponse> {
  const res = await apiFetch("/organizations/current/quotas");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to load quotas");
  return res.json();
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  const res = await apiFetch("/organizations/current/api-keys");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to load API keys");
  return res.json();
}

export async function createApiKey(data: {
  name: string;
  expires_in_days?: number;
}): Promise<CreatedApiKey> {
  const res = await apiFetch("/organizations/current/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create API key");
  }
  return res.json();
}

export async function revokeApiKey(id: string): Promise<void> {
  const res = await apiFetch(`/organizations/current/api-keys/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to revoke API key");
}

// --- Existing endpoints (now scoped to caller's org via cookie/api key) ---

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await apiFetch("/health");
  if (!res.ok) throw new Error("Health check failed");
  return res.json();
}

export async function fetchSubscriptions(): Promise<Subscription[]> {
  const res = await apiFetch("/subscriptions");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to fetch subscriptions");
  return res.json();
}

export async function fetchSubscription(id: string): Promise<Subscription> {
  const res = await apiFetch(`/subscriptions/${id}`);
  checkAuth(res);
  if (!res.ok) throw new Error("Subscription not found");
  return res.json();
}

export async function fetchSubscriptionStatus(
  id: string
): Promise<SubscriptionStatus> {
  const res = await apiFetch(`/subscriptions/${id}/status`);
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to fetch status");
  return res.json();
}

export async function fetchAllStatuses(): Promise<BulkStatusResponse> {
  const res = await apiFetch("/subscriptions/status/all");
  checkAuth(res);
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
  const res = await apiFetch(`/subscriptions/${id}/deliveries?${params}`);
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to fetch deliveries");
  return res.json();
}

export async function fetchDeliveryStats(id: string): Promise<DeliveryStats> {
  const res = await apiFetch(`/subscriptions/${id}/deliveries/stats`);
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to fetch delivery stats");
  return res.json();
}

export interface DeliveryTimeseriesBucket {
  bucket_start: string;
  successful: number;
  failed: number;
  total: number;
}

export interface DeliveryTimeseries {
  range: "24 hours" | "7 days";
  buckets: DeliveryTimeseriesBucket[];
}

export async function fetchDeliveryTimeseries(
  range: "24h" | "7d" = "24h",
  buckets = 24
): Promise<DeliveryTimeseries> {
  const params = new URLSearchParams({ range, buckets: String(buckets) });
  const res = await apiFetch(`/deliveries/timeseries?${params}`);
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to fetch delivery timeseries");
  return res.json();
}

export async function fetchGlobalDeliveryStats(): Promise<GlobalDeliveryStats> {
  const res = await apiFetch("/deliveries/stats");
  checkAuth(res);
  if (!res.ok) throw new Error("Failed to fetch global delivery stats");
  return res.json();
}

export interface CreateSubscriptionResponse {
  subscriptionId: string;
  // Returned ONCE on creation. Receivers store this and use it to verify
  // X-AnyHook-Signature on every delivery. Never returned by GET endpoints.
  webhook_secret: string;
  message: string;
}

export async function createSubscription(data: {
  connection_type: string;
  args: Record<string, unknown>;
  webhook_url: string;
}): Promise<CreateSubscriptionResponse> {
  const res = await apiFetch("/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to create subscription");
  }
  return res.json();
}

export interface BulkSubscriptionEntry {
  connection_type: string;
  args: Record<string, unknown>;
  webhook_url: string;
}

export interface BulkSubscriptionResult {
  index: number;
  subscriptionId?: string;
  webhook_secret?: string;
  error?: string;
}

export interface BulkSubscriptionResponse {
  results: BulkSubscriptionResult[];
  summary: { total: number; successful: number; failed: number };
}

export async function createSubscriptionsBulk(
  subscriptions: BulkSubscriptionEntry[]
): Promise<BulkSubscriptionResponse> {
  const res = await apiFetch("/subscribe/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscriptions }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Bulk import failed");
  }
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
  const res = await apiFetch(`/subscriptions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to update subscription");
  }
  return res.json();
}

export async function deleteSubscription(id: string): Promise<void> {
  const res = await apiFetch("/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription_id: id }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || "Failed to delete subscription");
  }
}
