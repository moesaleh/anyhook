import type { MetadataRoute } from "next";

/**
 * Web App Manifest (Next metadata route → served at /manifest.webmanifest).
 *
 * Completes the PWA story so the dashboard is installable / add-to-home-
 * screen capable, pairing with the asset-caching service worker registered
 * in the root layout. The brand color (`#4f46e5`, indigo-600) matches the
 * Radio logo + accents used throughout the UI.
 *
 * Icons: the repo ships no raster icon assets, so the app icon is an inline
 * SVG data URI (the same indigo broadcast/Radio glyph as the sidebar mark).
 * SVG icons are honored by Chromium-based installers; declaring `purpose:
 * "any maskable"` lets the platform pad it for adaptive icons. If raster
 * PNGs (192/512) are added to /public later, list them here too.
 */

// Indigo "broadcast" glyph on a rounded indigo-tinted tile — mirrors the
// lucide `Radio` icon used as the AnyHook wordmark.
const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="96" fill="#eef2ff"/>
<g fill="none" stroke="#4f46e5" stroke-width="28" stroke-linecap="round" stroke-linejoin="round">
<circle cx="256" cy="256" r="32" fill="#4f46e5" stroke="none"/>
<path d="M168 168a124 124 0 0 0 0 176M344 168a124 124 0 0 1 0 176"/>
<path d="M120 120a192 192 0 0 0 0 272M392 120a192 192 0 0 1 0 272"/>
</g>
</svg>`;

const ICON_DATA_URI = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`;

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "AnyHook Dashboard",
    short_name: "AnyHook",
    description:
      "Manage your real-time webhook subscriptions — connect GraphQL and WebSocket sources to webhook endpoints.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#0a0a0a",
    theme_color: "#4f46e5",
    icons: [
      {
        src: ICON_DATA_URI,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: ICON_DATA_URI,
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
