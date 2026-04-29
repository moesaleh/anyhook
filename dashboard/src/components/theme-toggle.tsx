"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { cn } from "@/lib/utils";

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

/**
 * 3-segment toggle for theme mode. Lives in the sidebar footer.
 * The pressed state is the user's persisted preference, NOT the
 * resolved appearance — so on `system` mode the System segment is
 * highlighted even if the OS is currently dark.
 */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  return (
    <div
      className="flex items-center gap-1 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-0.5"
      role="radiogroup"
      aria-label="Theme"
    >
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = mode === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => setMode(value)}
            className={cn(
              "flex-1 inline-flex items-center justify-center rounded-md py-1 text-[10px] font-medium transition-colors",
              active
                ? "bg-indigo-50 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
                : "text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300"
            )}
          >
            <Icon className="h-3 w-3" />
          </button>
        );
      })}
    </div>
  );
}
