import { beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

let serviceWorker = "";
let manifest = "";
let settings = "";

beforeAll(async () => {
  [serviceWorker, manifest, settings] = await Promise.all([
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../components/web-push-settings.tsx", import.meta.url), "utf8")
  ]);
});

describe("PWA and Web Push surface", () => {
  it("is installable in standalone mode and provides an offline fallback", () => {
    expect(manifest).toContain('display: "standalone"');
    expect(manifest).toContain('start_url: "/"');
    expect(serviceWorker).toContain('const OFFLINE_URL = "/offline"');
    expect(serviceWorker).toContain('request.mode === "navigate"');
  });

  it("does not reload a fresh visit when the first service worker claims it", async () => {
    const bootstrap = await readFile(new URL("../components/pwa-bootstrap.tsx", import.meta.url), "utf8");
    expect(bootstrap).toContain("const hadController = Boolean(navigator.serviceWorker.controller)");
    expect(bootstrap).toContain("if (!hadController || refreshing) return");
  });

  it("never caches authenticated API responses", () => {
    const apiGuard = serviceWorker.indexOf('url.pathname.startsWith("/api/")');
    const cacheWrite = serviceWorker.indexOf("cache.put(request, response.clone())");
    expect(apiGuard).toBeGreaterThan(0);
    expect(cacheWrite).toBeGreaterThan(apiGuard);
    expect(serviceWorker.slice(apiGuard, cacheWrite)).toContain("return;");
  });

  it("shows only generic lock-screen copy and has no direct notification actions", () => {
    expect(serviceWorker).toContain('assigned_message: ["Nova mensagem", "Há uma nova mensagem em um caso atribuído."]');
    expect(serviceWorker).not.toMatch(/contactName|contactPhone|preview|telefone|trecho/);
    expect(serviceWorker).not.toContain("actions:");
  });

  it("requests browser consent only from the explicit activation handler", () => {
    expect(settings).toContain("async function enable()");
    expect(settings).toContain("await Notification.requestPermission()");
    expect(settings).toContain('onClick={() => void enable()}');
  });
});
