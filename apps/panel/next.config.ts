import { config as loadEnv } from "dotenv";
import type { NextConfig } from "next";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(currentDir, "../../.env"), quiet: true });

const backendUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:3110";
const meetOrigin = new URL(
  process.env.NEXT_PUBLIC_MEET_BASE_URL
    ?? process.env.MEET_PUBLIC_URL
    ?? "https://meet.atendon.alpdash.com.br"
).origin;

export const panelProxyPaths = ["/backend/:path*", "/api/:path*"] as const;

export function createPanelContentSecurityPolicy(environment = process.env.NODE_ENV, allowedMeetOrigin = meetOrigin) {
  return [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `script-src 'self' 'unsafe-inline'${environment === "development" ? " 'unsafe-eval'" : ""} ${allowedMeetOrigin}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "media-src 'self' blob:",
  "connect-src 'self' https: wss:",
  `frame-src 'self' ${allowedMeetOrigin}`
  ].join("; ");
}

export const panelContentSecurityPolicy = createPanelContentSecurityPolicy();

export const panelSecurityHeaders = [
  { key: "Content-Security-Policy", value: panelContentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Voice replies use same-origin audio; embedded calls also need capture and fullscreen permissions.
  { key: "Permissions-Policy", value: `camera=(self \"${meetOrigin}\"), microphone=(self \"${meetOrigin}\"), display-capture=(self \"${meetOrigin}\"), fullscreen=(self \"${meetOrigin}\"), geolocation=()` }
] as const;

const config: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: resolve(currentDir, "../.."),
  // The workspace build runs ESLint explicitly before Next to keep the lint gate
  // deterministic with the monorepo's root flat configuration.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [{
      source: "/:path*",
      headers: [...panelSecurityHeaders]
    }];
  },
  async rewrites() {
    return panelProxyPaths.map((source) => ({ source, destination: `${backendUrl}/:path*` }));
  }
};

export default config;
