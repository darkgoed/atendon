const CACHE_VERSION = "atendon-pwa-v1";
const OFFLINE_URL = "/offline";
const STATIC_CACHE = `${CACHE_VERSION}-static`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then((cache) => cache.addAll([OFFLINE_URL, "/icon.png"])));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(Promise.all([
    caches.keys().then((keys) => Promise.all(keys
      .filter((key) => key.startsWith("atendon-pwa-") && key !== STATIC_CACHE)
      .map((key) => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Dados autenticados e APIs sempre passam direto pela rede e nunca entram no cache.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/backend/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => (
      await caches.match(OFFLINE_URL, { ignoreSearch: true }) || Response.error()
    )));
    return;
  }

  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/icon.png") {
    event.respondWith(caches.open(STATIC_CACHE).then(async (cache) => {
      const cached = await cache.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") await cache.put(request, response.clone());
      return response;
    }));
  }
});

const PUSH_COPY = {
  assigned_message: ["Nova mensagem", "Há uma nova mensagem em um caso atribuído."],
  case_assignment: ["Nova atribuição", "Um caso foi atribuído a você."],
  handoff: ["Atendimento solicitado", "Há um atendimento que precisa da sua atenção."],
  appointment_changed: ["Compromisso atualizado", "Um dos seus compromissos foi alterado."],
  appointment_reminder: ["Lembrete de compromisso", "Você tem um compromisso em breve."],
  critical_alert: ["Alerta crítico", "Há um alerta crítico no AtendON."],
  other: ["Atualização do AtendON", "Há uma atualização disponível no painel."]
};

function safePath(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return "/";
  try {
    const parsed = new URL(value, self.location.origin);
    return parsed.origin === self.location.origin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch {
    return "/";
  }
}

self.addEventListener("push", (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = {}; }
  const type = Object.prototype.hasOwnProperty.call(PUSH_COPY, payload.type) ? payload.type : "other";
  const [title, body] = PUSH_COPY[type];
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: "/icon.png",
    badge: "/icon.png",
    tag: typeof payload.notification_id === "string" ? `atendon-${payload.notification_id}` : `atendon-${type}`,
    data: { path: safePath(payload.path) },
    silent: payload.urgency !== "critical",
    renotify: payload.urgency === "critical"
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const path = safePath(event.notification.data?.path);
  const destination = new URL(path, self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (clients) => {
    const client = clients.find((candidate) => new URL(candidate.url).origin === self.location.origin);
    if (client) {
      await client.navigate(destination);
      return client.focus();
    }
    return self.clients.openWindow(destination);
  }));
});
