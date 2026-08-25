"use client";

import { BellRinging, DeviceMobile, Prohibit } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import useSWR from "swr";
import { api } from "@/lib/api";

type PushPreferences = {
  web_push_enabled: boolean;
  push_assigned_messages: boolean;
  push_assignments: boolean;
  push_appointments: boolean;
  push_critical_alerts: boolean;
  push_other: boolean;
};

type PushSettingsResponse = {
  enabled: boolean;
  configured: boolean;
  public_key: string | null;
  subscription_count: number;
  preferences: PushPreferences;
};

const preferenceOptions: ReadonlyArray<{
  key: keyof Omit<PushPreferences, "web_push_enabled">;
  label: string;
  description: string;
}> = [
  { key: "push_assigned_messages", label: "Mensagens atribuídas", description: "Novas mensagens dos seus casos." },
  { key: "push_assignments", label: "Atribuições e handoffs", description: "Casos novos ou pedindo sua atenção." },
  { key: "push_appointments", label: "Compromissos", description: "Alterações e lembretes da sua agenda." },
  { key: "push_critical_alerts", label: "Alertas críticos", description: "Falhas importantes do workspace." },
  { key: "push_other", label: "Outras atualizações", description: "Categoria opcional, desativada por padrão." }
];

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = `${value}${"=".repeat((4 - value.length % 4) % 4)}`.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(normalized);
  const buffer = new ArrayBuffer(decoded.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function subscriptionPayload(subscription: PushSubscription) {
  const serialized = subscription.toJSON();
  if (!serialized.endpoint || !serialized.keys?.p256dh || !serialized.keys.auth) {
    throw new Error("O navegador retornou uma inscrição Web Push inválida.");
  }
  return {
    endpoint: serialized.endpoint,
    expirationTime: serialized.expirationTime ?? null,
    keys: { p256dh: serialized.keys.p256dh, auth: serialized.keys.auth },
    deviceName: navigator.platform?.trim() || "Este dispositivo"
  };
}

export function WebPushSettings() {
  const { data, error, isLoading, mutate } = useSWR<PushSettingsResponse>(
    "/me/push",
    (url: string) => api<PushSettingsResponse>(url),
    { revalidateOnFocus: true }
  );
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  useEffect(() => {
    if (!supported) return;
    let cancelled = false;
    void navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((current) => { if (!cancelled) setSubscription(current); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [supported]);

  async function enable() {
    if (!data?.enabled || !data.public_key || !supported || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("Permissão não concedida. Você pode alterá-la nas configurações do navegador.");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      const next = current ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(data.public_key)
      });
      await api("/me/push/subscriptions", {
        method: "POST",
        body: JSON.stringify(subscriptionPayload(next))
      });
      setSubscription(next);
      setMessage("Notificações deste dispositivo ativadas.");
      await mutate();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Não foi possível ativar o Web Push.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    if (!subscription || busy) return;
    setBusy(true);
    setMessage("");
    const endpoint = subscription.endpoint;
    try {
      await subscription.unsubscribe();
      await api("/me/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint }) });
      await api("/me/push/preferences", { method: "PATCH", body: JSON.stringify({ web_push_enabled: false }) });
      setSubscription(null);
      setMessage("Notificações deste dispositivo desativadas.");
      await mutate();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Não foi possível desativar o Web Push.");
    } finally {
      setBusy(false);
    }
  }

  async function change(key: keyof PushPreferences, value: boolean) {
    if (!data || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await api<{ preferences: PushPreferences }>("/me/push/preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value })
      });
      await mutate({ ...data, preferences: response.preferences }, { revalidate: false });
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "Não foi possível salvar a preferência.");
    } finally {
      setBusy(false);
    }
  }

  if (isLoading) return <div className="skeleton h-52" role="status" aria-label="Carregando Web Push" />;
  return (
    <section className="border-t border-[var(--border)] pt-5" aria-labelledby="web-push-title">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h3 id="web-push-title" className="flex items-center gap-2 text-sm font-semibold"><BellRinging aria-hidden="true" /> Web Push discreto</h3>
          <p className="sub mt-1 max-w-2xl text-xs">Funciona com o painel fechado. A tela bloqueada mostra somente o tipo e a urgência; nome, telefone e conteúdo da mensagem nunca fazem parte do payload.</p>
        </div>
        {subscription ? (
          <button type="button" className="btn" disabled={busy} onClick={() => void disable()}><Prohibit aria-hidden="true" /> Desativar neste dispositivo</button>
        ) : (
          <button type="button" className="btn primary" disabled={busy || !supported || !data?.enabled} onClick={() => void enable()}><DeviceMobile aria-hidden="true" /> Ativar neste dispositivo</button>
        )}
      </div>
      {error ? <p className="error mt-3" role="alert">{error.message}</p> : null}
      {!supported ? <p className="mt-3 text-sm text-[var(--warn)]">Este navegador não oferece Web Push.</p> : null}
      {supported && data && !data.configured ? <p className="mt-3 text-sm text-[var(--warn)]">VAPID ainda não foi configurado pelo administrador.</p> : null}
      {message ? <p className="mt-3 text-sm text-[var(--muted)]" role="status">{message}</p> : null}
      <p className="mono mt-3 text-[10px] text-[var(--faint)]">{data?.subscription_count ?? 0} dispositivo(s) inscrito(s) neste workspace</p>
      {data ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {preferenceOptions.map((option) => (
            <label key={option.key} className="flex gap-3 border border-[var(--border)] p-3">
              <input
                type="checkbox"
                checked={data.preferences[option.key]}
                disabled={busy}
                onChange={(event) => void change(option.key, event.target.checked)}
              />
              <span><strong className="block text-sm">{option.label}</strong><small className="sub mt-1 block">{option.description}</small></span>
            </label>
          ))}
        </div>
      ) : null}
    </section>
  );
}
