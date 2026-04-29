import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { OfflineBanner } from "@/components/offline-banner";
import { DlqAlert } from "@/components/dlq-alert";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";
import { ToastProvider } from "@/lib/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnyHook Dashboard",
  description:
    "Manage your real-time webhook subscriptions — connect GraphQL and WebSocket sources to webhook endpoints.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased">
      <head>
        {/*
         * Apply the persisted theme class BEFORE first paint to avoid
         * the light-mode flash on dark-mode users. Inline because any
         * other strategy (CSS-only, useEffect) would either show the
         * wrong palette for one frame or block the entire render.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="min-h-full flex font-sans">
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <Sidebar />
              <main className="flex-1 min-h-screen overflow-auto">
                <OfflineBanner />
                <DlqAlert />
                <ErrorBoundary>{children}</ErrorBoundary>
              </main>
            </AuthProvider>
          </ToastProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
