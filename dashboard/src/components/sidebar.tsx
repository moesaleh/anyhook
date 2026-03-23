"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Radio,
  Settings,
  Webhook,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navigation = [
  { name: "Dashboard", href: "/", icon: LayoutDashboard },
  { name: "Subscriptions", href: "/subscriptions", icon: Radio },
];

const secondaryNav = [
  { name: "Activity", href: "#", icon: Activity, disabled: true },
  { name: "Webhooks", href: "#", icon: Webhook, disabled: true },
  { name: "Settings", href: "#", icon: Settings, disabled: true },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:flex-col lg:w-64 lg:border-r lg:border-neutral-200 dark:lg:border-neutral-800 bg-neutral-50 dark:bg-neutral-950">
      <div className="flex h-14 items-center gap-2 border-b border-neutral-200 dark:border-neutral-800 px-5">
        <Radio className="h-6 w-6 text-indigo-600" />
        <span className="text-lg font-semibold tracking-tight">AnyHook</span>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1">
        <p className="px-2 mb-2 text-xs font-medium text-neutral-500 uppercase tracking-wider">
          Main
        </p>
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

        <p className="px-2 mt-6 mb-2 text-xs font-medium text-neutral-500 uppercase tracking-wider">
          Coming Soon
        </p>
        {secondaryNav.map((item) => (
          <span
            key={item.name}
            className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-neutral-400 dark:text-neutral-600 cursor-not-allowed"
          >
            <item.icon className="h-4 w-4" />
            {item.name}
            <span className="ml-auto text-[10px] bg-neutral-200 dark:bg-neutral-800 text-neutral-500 px-1.5 py-0.5 rounded-full">
              Soon
            </span>
          </span>
        ))}
      </nav>

      <div className="border-t border-neutral-200 dark:border-neutral-800 px-5 py-3">
        <p className="text-xs text-neutral-500">AnyHook v1.0.0</p>
      </div>
    </aside>
  );
}
