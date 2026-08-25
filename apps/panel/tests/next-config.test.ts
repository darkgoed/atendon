import { describe, expect, it } from "vitest";
import {
  createPanelContentSecurityPolicy,
  panelContentSecurityPolicy,
  panelProxyPaths,
  panelSecurityHeaders
} from "../next.config";

describe("panel security headers", () => {
  it("allows camera and microphone only for the panel and the embedded Meet origin", () => {
    const permissionsPolicy = panelSecurityHeaders.find(({ key }) => key === "Permissions-Policy");
    expect(permissionsPolicy?.value).toBe('camera=(self "https://meet.atendon.alpdash.com.br"), microphone=(self "https://meet.atendon.alpdash.com.br"), display-capture=(self "https://meet.atendon.alpdash.com.br"), fullscreen=(self "https://meet.atendon.alpdash.com.br"), geolocation=()');
  });

  it("uses a production-compatible CSP without dynamic code execution", () => {
    expect(panelSecurityHeaders).toContainEqual({
      key: "Content-Security-Policy",
      value: panelContentSecurityPolicy
    });
    expect(panelContentSecurityPolicy).toContain("frame-ancestors 'none'");
    expect(panelContentSecurityPolicy).toContain("object-src 'none'");
    expect(panelContentSecurityPolicy).toContain("https://fonts.googleapis.com");
    expect(panelContentSecurityPolicy).toContain("https://fonts.gstatic.com");
    expect(panelContentSecurityPolicy).toContain("frame-src 'self' https://meet.atendon.alpdash.com.br");
    expect(panelContentSecurityPolicy).toContain("script-src 'self' 'unsafe-inline' https://meet.atendon.alpdash.com.br");
    expect(panelContentSecurityPolicy).not.toContain("'unsafe-eval'");
    expect(createPanelContentSecurityPolicy("production")).not.toContain("'unsafe-eval'");
  });

  it("allows only the Next development runtime to evaluate refresh modules", () => {
    expect(createPanelContentSecurityPolicy("development")).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval' https://meet.atendon.alpdash.com.br");
    expect(createPanelContentSecurityPolicy("test")).not.toContain("'unsafe-eval'");
  });

  it("can scope the Jitsi CSP to a configured Meet origin", () => {
    const policy = createPanelContentSecurityPolicy("production", "https://meet.example.test");
    expect(policy).toContain("script-src 'self' 'unsafe-inline' https://meet.example.test");
    expect(policy).toContain("frame-src 'self' https://meet.example.test");
  });

  it("proxies both development and production API paths for direct panel starts", () => {
    expect(panelProxyPaths).toEqual(["/backend/:path*", "/api/:path*"]);
  });
});
