import type { Metadata } from "next";
import { Sidebar } from "@/components/sidebar";
import { ErrorBoundary } from "@/components/error-boundary";
import { AuthProvider } from "@/lib/auth-context";
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
      <body className="min-h-full flex font-sans">
        <AuthProvider>
          <Sidebar />
          <main className="flex-1 min-h-screen overflow-auto">
            <ErrorBoundary>{children}</ErrorBoundary>
          </main>
        </AuthProvider>
      </body>
    </html>
  );
}
