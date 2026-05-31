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

/**
 * Generic non-OK API response (any 4xx/5xx that isn't already mapped to a
 * more specific class). Carries the HTTP status so callers can tell a 400
 * from a 500 — previously every endpoint threw a plain `Error` and lost
 * that. 401/403 still surface as the more specific `AuthError`, and 429 as
 * `RateLimitError`, both of which extend `Error` like this one.
 */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
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

interface RequestOptions {
  // When true (default) a 401/403 surfaces as AuthError so the auth
  // context can redirect to /login. Endpoints that are reachable while
  // logged-OUT (login / register / accept-invite / password reset /
  // 2FA setup-and-verify-login / public invitation lookup) pass
  // `auth: false` so a 401 from them reads as a normal failure (e.g.
  // "Invalid credentials") rather than triggering a redirect.
  auth?: boolean;
  // Message used when the response body carries no `error` field.
  fallbackMsg?: string;
}

/**
 * The single fetch funnel every exported endpoint routes through.
 *
 * Runs `apiFetch` (which owns the offline short-circuit, read-vs-mutation
 * timeout, and 429 -> RateLimitError mapping), optionally maps 401/403 to
 * AuthError, then for any other non-OK status parses the JSON body and
 * throws `ApiError(status, body.error || fallbackMsg)`. On success it
 * returns the parsed JSON, tolerating an empty/204 body by resolving to
 * `{}` — callers typed as `Promise<void>` simply ignore the value.
 */
async function request<T>(
  path: string,
  init?: RequestInit,
  opts: RequestOptions = {}
): Promise<T> {
  const { auth = true, fallbackMsg = "Request failed" } = opts;
  const res = await apiFetch(path, init);
  if (auth) checkAuth(res);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body?.error || fallbackMsg, res.status);
  }
  // Tolerate empty bodies (e.g. 204 No Content) so void endpoints don't
  // blow up on `res.json()` parsing nothing.
  return res.json().catch(() => ({})) as Promise<T>;
}

export async function fetchMe(): Promise<SessionResponse> {
  return request<SessionResponse>("/auth/me", undefined, {
    fallbackMsg: "Failed to load session",
  });
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
  return request<LoginResult>(
    "/auth/login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    { auth: false, fallbackMsg: "Login failed" }
  );
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
  return request<SessionResponse>(
    "/auth/2fa/verify-login",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pending_token: pendingToken, code }),
    },
    { auth: false, fallbackMsg: "2FA verification failed" }
  );
}

/* --- 2FA management (settings page) --- */

export interface TwoFactorStatus {
  enabled: boolean;
  enrollment_pending: boolean;
  unused_backup_codes: number;
}

export async function fetch2faStatus(): Promise<TwoFactorStatus> {
  return request<TwoFactorStatus>("/auth/2fa/status", undefined, {
    fallbackMsg: "Failed to load 2FA status",
  });
}

export interface TwoFactorSetup {
  secret: string;
  otpauth_url: string;
}

export async function start2faSetup(): Promise<TwoFactorSetup> {
  // checkAuth deliberately skipped (the setup flow surfaces its own
  // errors); preserved as `auth: false`.
  return request<TwoFactorSetup>(
    "/auth/2fa/setup",
    { method: "POST" },
    { auth: false, fallbackMsg: "Failed to start 2FA setup" }
  );
}

export interface TwoFactorVerifySetup {
  enabled: true;
  backup_codes: string[];
  message: string;
}

export async function verify2faSetup(code: string): Promise<TwoFactorVerifySetup> {
  // checkAuth deliberately skipped (see start2faSetup).
  return request<TwoFactorVerifySetup>(
    "/auth/2fa/verify-setup",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    },
    { auth: false, fallbackMsg: "Failed to verify 2FA setup" }
  );
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
  // Public flow (user is logged out) — skip the auth redirect mapping.
  return request<PasswordResetRequest>(
    "/auth/password/reset-request",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    },
    { auth: false, fallbackMsg: "Reset request failed" }
  );
}

export async function resetPassword(token: string, newPassword: string): Promise<void> {
  // Public flow (user is logged out) — skip the auth redirect mapping.
  await request<void>(
    "/auth/password/reset",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, new_password: newPassword }),
    },
    { auth: false, fallbackMsg: "Reset failed" }
  );
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<void> {
  // Authenticated settings action — a 401 here means the session lapsed,
  // so let it map to AuthError (and a login redirect) like every other
  // authenticated endpoint.
  await request<void>("/auth/password/change", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      current_password: currentPassword,
      new_password: newPassword,
    }),
  }, { fallbackMsg: "Password change failed" });
}

export async function disable2fa(currentPassword: string, code: string): Promise<void> {
  // Authenticated settings action (see changePassword).
  await request<void>("/auth/2fa/disable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ current_password: currentPassword, code }),
  }, { fallbackMsg: "Failed to disable 2FA" });
}

export async function registerUser(data: {
  email: string;
  password: string;
  name?: string;
  organization_name?: string;
}): Promise<SessionResponse> {
  // Public flow (user is logged out) — skip the auth redirect mapping.
  return request<SessionResponse>(
    "/auth/register",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
    { auth: false, fallbackMsg: "Registration failed" }
  );
}

export async function logout(): Promise<void> {
  // Fire-and-forget: a failed logout still clears client state, so we
  // deliberately don't route this through `request` / throw on non-OK.
  await apiFetch("/auth/logout", { method: "POST" });
}

export async function switchOrganization(
  organizationId: string
): Promise<{ organization_id: string }> {
  return request<{ organization_id: string }>("/auth/switch-org", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organization_id: organizationId }),
  }, { fallbackMsg: "Failed to switch organization" });
}

export async function createOrganization(name: string): Promise<Organization> {
  return request<Organization>("/organizations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  }, { fallbackMsg: "Failed to create organization" });
}

export async function fetchOrgMembers(): Promise<OrganizationMember[]> {
  return request<OrganizationMember[]>("/organizations/current/members", undefined, {
    fallbackMsg: "Failed to load members",
  });
}

export async function addOrgMember(
  email: string,
  role: "owner" | "admin" | "member" = "member"
): Promise<{ user_id: string; role: string }> {
  return request<{ user_id: string; role: string }>("/organizations/current/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, role }),
  }, { fallbackMsg: "Failed to add member" });
}

export async function removeOrgMember(userId: string): Promise<void> {
  await request<void>(
    `/organizations/current/members/${userId}`,
    { method: "DELETE" },
    { fallbackMsg: "Failed to remove member" }
  );
}

/* --- Notification preferences --- */

export type NotificationChannel = "email" | "slack";
export type NotificationEvent = "dlq" | "failed" | "quota_warning";
export const NOTIFICATION_EVENT_LABELS: Record<NotificationEvent, string> = {
  dlq: "Dead-letter queue",
  failed: "Other delivery failure",
  quota_warning: "Quota warning (80%)",
};

export interface NotificationPreference {
  id: string;
  channel: NotificationChannel;
  destination: string;
  events: string[];
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export async function fetchNotifications(): Promise<NotificationPreference[]> {
  return request<NotificationPreference[]>(
    "/organizations/current/notifications",
    undefined,
    { fallbackMsg: "Failed to load notifications" }
  );
}

export async function createNotification(data: {
  channel: NotificationChannel;
  destination: string;
  events?: string[];
  enabled?: boolean;
}): Promise<NotificationPreference> {
  return request<NotificationPreference>("/organizations/current/notifications", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, { fallbackMsg: "Create notification failed" });
}

export async function updateNotification(
  id: string,
  data: { destination?: string; events?: string[]; enabled?: boolean }
): Promise<NotificationPreference> {
  return request<NotificationPreference>(`/organizations/current/notifications/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, { fallbackMsg: "Update notification failed" });
}

export async function deleteNotification(id: string): Promise<void> {
  await request<void>(
    `/organizations/current/notifications/${id}`,
    { method: "DELETE" },
    { fallbackMsg: "Delete notification failed" }
  );
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
  return request<Invitation[]>(
    "/organizations/current/invitations",
    undefined,
    { fallbackMsg: "Failed to load invitations" }
  );
}

export async function createInvitation(data: {
  email: string;
  role?: "owner" | "admin" | "member";
  expires_in_days?: number;
}): Promise<CreatedInvitation> {
  return request<CreatedInvitation>("/organizations/current/invitations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, { fallbackMsg: "Failed to create invitation" });
}

export async function revokeInvitation(id: string): Promise<void> {
  await request<void>(
    `/organizations/current/invitations/${id}`,
    { method: "DELETE" },
    { fallbackMsg: "Failed to revoke invitation" }
  );
}

export interface InvitationLookup {
  email: string;
  role: "owner" | "admin" | "member";
  organization_name: string;
  expires_at: string;
}

/** Anonymous: read-only lookup for the registration page. */
export async function lookupInvitation(token: string): Promise<InvitationLookup> {
  // Anonymous endpoint — a 401 isn't an auth-session failure, so skip the
  // AuthError mapping (`auth: false`).
  return request<InvitationLookup>(
    `/invitations/${encodeURIComponent(token)}`,
    undefined,
    { auth: false, fallbackMsg: "Invitation not found" }
  );
}

/** Anonymous: redeem an invitation token + create a user. */
export async function acceptInvite(data: {
  token: string;
  password: string;
  name?: string;
}): Promise<SessionResponse> {
  // Anonymous endpoint (see lookupInvitation).
  return request<SessionResponse>(
    "/auth/accept-invite",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    },
    { auth: false, fallbackMsg: "Failed to accept invitation" }
  );
}

export async function fetchQuotas(): Promise<QuotasResponse> {
  return request<QuotasResponse>("/organizations/current/quotas", undefined, {
    fallbackMsg: "Failed to load quotas",
  });
}

export async function fetchApiKeys(): Promise<ApiKey[]> {
  return request<ApiKey[]>("/organizations/current/api-keys", undefined, {
    fallbackMsg: "Failed to load API keys",
  });
}

export async function createApiKey(data: {
  name: string;
  expires_in_days?: number;
}): Promise<CreatedApiKey> {
  return request<CreatedApiKey>("/organizations/current/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, { fallbackMsg: "Failed to create API key" });
}

export async function revokeApiKey(id: string): Promise<void> {
  await request<void>(
    `/organizations/current/api-keys/${id}`,
    { method: "DELETE" },
    { fallbackMsg: "Failed to revoke API key" }
  );
}

// --- Existing endpoints (now scoped to caller's org via cookie/api key) ---

export async function fetchHealth(): Promise<HealthResponse> {
  // /health is unauthenticated — keep it out of the AuthError redirect
  // path (`auth: false`), matching the original no-checkAuth behavior.
  return request<HealthResponse>("/health", undefined, {
    auth: false,
    fallbackMsg: "Health check failed",
  });
}

export async function fetchSubscriptions(): Promise<Subscription[]> {
  return request<Subscription[]>("/subscriptions", undefined, {
    fallbackMsg: "Failed to fetch subscriptions",
  });
}

export interface SubscriptionPage {
  subscriptions: Subscription[];
  total: number;
  page: number;
  pages: number;
}

/**
 * Paginated variant — opt into server-side paging when the org has
 * more than a few hundred subscriptions. Backend supports an ILIKE
 * `search` query that matches subscription_id / webhook_url /
 * args.endpoint_url; passing an empty string is the same as no
 * search at all.
 */
export async function fetchSubscriptionsPage(
  page: number,
  limit = 25,
  search = ""
): Promise<SubscriptionPage> {
  const params = new URLSearchParams({
    page: String(Math.max(1, page)),
    limit: String(Math.min(100, Math.max(1, limit))),
  });
  if (search.trim()) params.set("search", search.trim());
  return request<SubscriptionPage>(`/subscriptions?${params}`, undefined, {
    fallbackMsg: "Failed to fetch subscriptions",
  });
}

export async function fetchSubscription(id: string): Promise<Subscription> {
  return request<Subscription>(`/subscriptions/${id}`, undefined, {
    fallbackMsg: "Subscription not found",
  });
}

export async function fetchSubscriptionStatus(
  id: string
): Promise<SubscriptionStatus> {
  return request<SubscriptionStatus>(`/subscriptions/${id}/status`, undefined, {
    fallbackMsg: "Failed to fetch status",
  });
}

export async function fetchAllStatuses(): Promise<BulkStatusResponse> {
  return request<BulkStatusResponse>("/subscriptions/status/all", undefined, {
    fallbackMsg: "Failed to fetch statuses",
  });
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
  return request<DeliveryPage>(`/subscriptions/${id}/deliveries?${params}`, undefined, {
    fallbackMsg: "Failed to fetch deliveries",
  });
}

export async function fetchDeliveryStats(id: string): Promise<DeliveryStats> {
  return request<DeliveryStats>(`/subscriptions/${id}/deliveries/stats`, undefined, {
    fallbackMsg: "Failed to fetch delivery stats",
  });
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
  return request<DeliveryTimeseries>(`/deliveries/timeseries?${params}`, undefined, {
    fallbackMsg: "Failed to fetch delivery timeseries",
  });
}

export async function fetchGlobalDeliveryStats(): Promise<GlobalDeliveryStats> {
  return request<GlobalDeliveryStats>("/deliveries/stats", undefined, {
    fallbackMsg: "Failed to fetch global delivery stats",
  });
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
  return request<CreateSubscriptionResponse>("/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, { fallbackMsg: "Failed to create subscription" });
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
  return request<BulkSubscriptionResponse>("/subscribe/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscriptions }),
  }, { fallbackMsg: "Bulk import failed" });
}

export async function updateSubscription(
  id: string,
  data: {
    connection_type: string;
    args: Record<string, unknown>;
    webhook_url: string;
  }
): Promise<Subscription> {
  return request<Subscription>(`/subscriptions/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  }, { fallbackMsg: "Failed to update subscription" });
}

export async function deleteSubscription(id: string): Promise<void> {
  await request<void>("/unsubscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription_id: id }),
  }, { fallbackMsg: "Failed to delete subscription" });
}
