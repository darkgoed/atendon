"use client";

import { useEffect } from "react";

export function PwaBootstrap() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let refreshing = false;
    let registration: ServiceWorkerRegistration | null = null;
    const hadController = Boolean(navigator.serviceWorker.controller);
    const reloadOnControllerChange = () => {
      // The first install claims the page too; only reload when replacing an
      // already active worker, otherwise a fresh visit is interrupted.
      if (!hadController || refreshing) return;
      refreshing = true;
      window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", reloadOnControllerChange);
    const updateWhenVisible = () => {
      if (document.visibilityState === "visible" && registration) void registration.update();
    };
    void navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((nextRegistration) => {
      registration = nextRegistration;
      if (nextRegistration.waiting) nextRegistration.waiting.postMessage({ type: "SKIP_WAITING" });
      nextRegistration.addEventListener("updatefound", () => {
        const installing = nextRegistration.installing;
        installing?.addEventListener("statechange", () => {
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            installing.postMessage({ type: "SKIP_WAITING" });
          }
        });
      });
      document.addEventListener("visibilitychange", updateWhenVisible);
    }).catch(() => undefined);
    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", reloadOnControllerChange);
      document.removeEventListener("visibilitychange", updateWhenVisible);
    };
  }, []);

  return null;
}
