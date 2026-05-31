import type { Metadata, Viewport } from "next";
import { Sidebar } from "@/components/sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { OfflineBanner } from "@/components/offline-banner";
import { DlqAlert } from "@/components/dlq-alert";
import { AuthProvider } from "@/lib/auth-context";
import { ThemeProvider, THEME_INIT_SCRIPT } from "@/lib/theme";
import { ToastProvider } from "@/lib/toast";
import { ServiceWorkerRegistrar } from "@/components/service-worker-registrar";
import "./globals.css";

export const metadata: Metadata = {
  title: "AnyHook Dashboard",
  description:
    "Manage your real-time webhook subscriptions — connect GraphQL and WebSocket sources to webhook endpoints.",
  // Next auto-links the manifest route (src/app/manifest.ts) but we declare it
  // explicitly so the <link rel="manifest"> is unambiguous.
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "AnyHook",
    statusBarStyle: "black-translucent",
  },
};

// Drives mobile browser chrome + the default viewport (previously left to
// Next's fallback). `themeColor` is media-aware so the address bar tints to
// the page background in each scheme rather than the indigo accent.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
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
        {/* Keyboard skip target — hidden until focused, see globals.css */}
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <ServiceWorkerRegistrar />
        <ThemeProvider>
          <ToastProvider>
            <AuthProvider>
              <Sidebar />
              <main
                id="main-content"
                className="flex-1 min-h-screen overflow-auto"
              >
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
