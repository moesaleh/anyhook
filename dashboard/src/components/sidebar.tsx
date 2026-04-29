"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  LayoutDashboard,
  Radio,
  Settings,
  ChevronsUpDown,
  LogOut,
  Check,
  Building2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { QuotaIndicator } from "./quota-indicator";
import { ThemeToggle } from "./theme-toggle";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Subscriptions", href: "/subscriptions", icon: Radio },
  { name: "Settings", href: "/settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, organization, organizations, switchOrg, logout } = useAuth();
  const [orgPickerOpen, setOrgPickerOpen] = useState(false);

  // Hide sidebar on auth pages
  if (pathname === "/login" || pathname === "/register") {
    return null;
  }

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:border-r lg:border-neutral-200 dark:lg:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
      <div className="flex h-14 items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 px-5">
        <Radio className="h-6 w-6 text-indigo-600" />
        <span className="text-lg font-semibold tracking-tight">AnyHook</span>
      </div>

      {/* Organization picker */}
      {organization && (
        <div className="relative border-b border-neutral-200 dark:border-neutral-800 p-3">
          <button
            type="button"
            onClick={() => setOrgPickerOpen((v) => !v)}
            className="w-full flex items-center gap-2 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 px-3 py-2 text-left text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
          >
            <Building2 className="h-4 w-4 text-neutral-500 flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="font-medium truncate">{organization.name}</div>
              {organization.role && (
                <div className="text-[10px] text-neutral-500 capitalize">
                  {organization.role}
                </div>
              )}
            </div>
            <ChevronsUpDown className="h-3.5 w-3.5 text-neutral-400 flex-shrink-0" />
          </button>

          {orgPickerOpen && (
            <div className="absolute left-3 right-3 mt-1 z-10 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-lg overflow-hidden">
              {organizations.map((org) => {
                const active = org.id === organization.id;
                return (
                  <button
                    key={org.id}
                    type="button"
                    onClick={async () => {
                      setOrgPickerOpen(false);
                      if (!active) await switchOrg(org.id);
                    }}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-sm text-left",
                      active
                        ? "bg-indigo-50 dark:bg-indigo-950/30 text-indigo-700 dark:text-indigo-300"
                        : "hover:bg-neutral-50 dark:hover:bg-neutral-900"
                    )}
                  >
                    <Building2 className="h-3.5 w-3.5 flex-shrink-0" />
                    <span className="flex-1 truncate">{org.name}</span>
                    {active && <Check className="h-3.5 w-3.5" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <nav className="flex-1 px-3 py-4 space-y-1">
        {navigation.map((item) => {
          const isActive =
            pathname === item.href ||
            (item.href !== "/" && pathname.startsWith(item.href));
          return (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                isActive
                  ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                  : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
              )}
            >
              <item.icon className="h-4 w-4" />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {/* Per-org quota usage */}
      {organization && <QuotaIndicator />}

      {/* Theme toggle */}
      <div className="px-3 py-3 border-t border-neutral-200 dark:border-neutral-800">
        <ThemeToggle />
      </div>

      {/* User card + logout */}
      <div className="border-t border-neutral-200 dark:border-neutral-800 p-3">
        {user ? (
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-indigo-100 dark:bg-indigo-950 flex items-center justify-center text-xs font-medium text-indigo-700 dark:text-indigo-300 flex-shrink-0">
              {(user.name || user.email).slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-xs font-medium truncate">
                {user.name || user.email.split("@")[0]}
              </div>
              <div className="text-[10px] text-neutral-500 truncate">
                {user.email}
              </div>
            </div>
            <button
              type="button"
              onClick={logout}
              className="p-1.5 rounded-md text-neutral-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 transition-colors"
              title="Sign out"
              aria-label="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <p className="text-xs text-neutral-500">AnyHook v1.0.0</p>
        )}
      </div>
    </aside>
  );
}
