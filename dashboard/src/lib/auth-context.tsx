"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter, usePathname } from "next/navigation";
import {
  fetchMe,
  logout as apiLogout,
  switchOrganization as apiSwitchOrganization,
  AuthError,
  type SessionResponse,
  type User,
  type Organization,
} from "./api";

interface AuthContextValue {
  user: User | null;
  organization: Organization | null;
  organizations: Organization[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  switchOrg: (id: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const PUBLIC_PATHS = new Set(["/login", "/register"]);

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchMe();
      setSession(data);
    } catch (err) {
      if (err instanceof AuthError) {
        setSession(null);
        // Only redirect if we're on a protected path
        if (!PUBLIC_PATHS.has(pathname)) {
          router.replace("/login");
        }
      } else {
        setError(err instanceof Error ? err.message : "Failed to load session");
      }
    } finally {
      setLoading(false);
    }
  }, [pathname, router]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setSession(null);
      router.replace("/login");
    }
  }, [router]);

  const switchOrg = useCallback(
    async (id: string) => {
      await apiSwitchOrganization(id);
      await refresh();
      router.refresh();
    },
    [refresh, router]
  );

  const value: AuthContextValue = {
    user: session?.user ?? null,
    organization: session?.organization ?? null,
    organizations: session?.organizations ?? [],
    loading,
    error,
    refresh,
    logout,
    switchOrg,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
