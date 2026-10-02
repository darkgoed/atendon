"use client";

import { type FormEvent, useState } from "react";
import useSWR from "swr";
import { QRCodeSVG } from "qrcode.react";
import { Lock, ShieldCheck } from "@/components/icons";
import { api } from "@/lib/api";
import { formatPanelDateTime } from "@/lib/format";
import { Button, Card, Field, Input, SaveButton, Section, useSaveFeedback } from "@/components/ui";

const fetcher = <T,>(url: string) => api<T>(url);

type SessionItem = {
  id: string;
  created_at: string;
  expires_at: string;
  current: boolean;
  ip_address: string | null;
  user_agent: string | null;
};

type TotpSetup = { secret: string; otpauth_url: string };

/**
 * B2 Security (specs/active/v7-port-crm-whatsapp.md, ONDA 2): UI de sessões
 * ativas revogáveis e de 2FA TOTP por usuário. O backend (auth/security-routes)
 * já define o contrato: setup não ativa; ativar exige código válido;
 * desativar exige re-autenticação por senha.
 */
export function AccountSecurity({ totpEnabled, onTotpChanged }: { totpEnabled: boolean | undefined; onTotpChanged: () => void }) {
  const save = useSaveFeedback();
  const { data, error, mutate } = useSWR<{ items: SessionItem[] }>("/me/sessions", fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false,
    dedupingInterval: 10_000
  });
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokingOthers, setRevokingOthers] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("");
  const [sessionError, setSessionError] = useState("");

  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [activating, setActivating] = useState(false);
  const [deactivating, setDeactivating] = useState(false);
  const [totpMessage, setTotpMessage] = useState("");
  const [totpError, setTotpError] = useState("");

  const sessions = data?.items ?? [];

  async function revoke(session: SessionItem) {
    setRevoking(session.id);
    setSessionError("");
    setSessionMessage("");
    try {
      const result = await api<{ ok: boolean; current: boolean }>(`/me/sessions/${session.id}`, { method: "DELETE" });
      if (result.current) {
        window.location.assign("/login");
        return;
      }
      setSessionMessage("Sessão encerrada.");
      await mutate();
    } catch (caught) {
      setSessionError(caught instanceof Error ? caught.message : "Falha ao encerrar a sessão");
    } finally {
      setRevoking(null);
    }
  }

  async function revokeOthers() {
    setRevokingOthers(true);
    setSessionError("");
    setSessionMessage("");
    try {
      const result = await api<{ ok: boolean; revoked: number }>("/me/sessions/revoke-others", { method: "POST" });
      setSessionMessage(result.revoked > 0 ? `${result.revoked} outra(s) sessão(ões) encerrada(s).` : "Nenhuma outra sessão aberta.");
      await mutate();
      save.markDone();
    } catch (caught) {
      setSessionError(caught instanceof Error ? caught.message : "Falha ao encerrar as outras sessões");
    } finally {
      setRevokingOthers(false);
    }
  }

  async function startSetup() {
    setTotpError("");
    setTotpMessage("");
    setActivating(true);
    try {
      setSetup(await api<TotpSetup>("/me/totp/setup", { method: "POST" }));
    } catch (caught) {
      setTotpError(caught instanceof Error ? caught.message : "Falha ao iniciar a configuração do 2FA");
    } finally {
      setActivating(false);
    }
  }

  async function activate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup) return;
    const code = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    setTotpError("");
    setActivating(true);
    try {
      await api("/me/totp/activate", { method: "POST", body: JSON.stringify({ code }) });
      setSetup(null);
      setTotpMessage("Verificação em duas etapas ativada.");
      onTotpChanged();
      save.markDone();
    } catch (caught) {
      setTotpError(caught instanceof Error ? caught.message : "Falha ao ativar a verificação em duas etapas");
    } finally {
      setActivating(false);
    }
  }

  async function deactivate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const currentPassword = String(new FormData(event.currentTarget).get("currentPassword") ?? "");
    setTotpError("");
    setDeactivating(true);
    try {
      await api("/me/totp/deactivate", { method: "POST", body: JSON.stringify({ current_password: currentPassword }) });
      setTotpMessage("Verificação em duas etapas desativada.");
      onTotpChanged();
      save.markDone();
    } catch (caught) {
      setTotpError(caught instanceof Error ? caught.message : "Falha ao desativar a verificação em duas etapas");
    } finally {
      setDeactivating(false);
    }
  }

  return (
    <div className="grid gap-5">
      <Card className="admin-card">
        <Section title="Verificação em duas etapas" className="section">
          <ShieldCheck size={18} className="accent" aria-hidden="true" />
          <div className="grid gap-3">
            <p className="sub">
              {totpEnabled
                ? "Ativa: além da senha, um código do seu aplicativo autenticador é pedido a cada login."
                : "Inativa: adicione uma segunda etapa de verificação por aplicativo autenticador (TOTP) ao seu login."}
            </p>
            {totpError ? <p className="error" role="alert">{totpError}</p> : null}
            {totpMessage ? <p className="accent text-sm" role="status">{totpMessage}</p> : null}
            {!totpEnabled && !setup ? (
              <div>
                <Button type="button" disabled={activating} onClick={() => void startSetup()}>
                  {activating ? "Preparando…" : "Ativar verificação em duas etapas"}
                </Button>
              </div>
            ) : null}
            {!totpEnabled && setup ? (
              <form className="grid gap-3" onSubmit={activate} aria-busy={activating}>
                <Field label="1. Escaneie o QR Code no seu aplicativo autenticador">
                  <div className="flex flex-wrap items-center gap-4">
                    <QRCodeSVG value={setup.otpauth_url} size={148} role="img" aria-label="QR Code de configuração da verificação em duas etapas" />
                    <div className="grid gap-1">
                      <span className="label">Chave manual</span>
                      <code className="mono text-sm">{setup.secret}</code>
                    </div>
                  </div>
                </Field>
                <Field label="2. Código gerado pelo aplicativo" htmlFor="totp-code">
                  <Input
                    id="totp-code"
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    placeholder="000000"
                    disabled={activating}
                    required
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-2">
                  <SaveButton type="submit" state={activating ? "busy" : save.state} disabled={activating}>Confirmar ativação</SaveButton>
                  <button type="button" className="btn" disabled={activating} onClick={() => setSetup(null)}>Cancelar</button>
                </div>
              </form>
            ) : null}
            {totpEnabled ? (
              <form className="grid gap-3" onSubmit={deactivate} aria-busy={deactivating}>
                <Field label="Senha atual" hint="Exigida para desativar a segunda etapa" htmlFor="totp-current-password">
                  <Input id="totp-current-password" name="currentPassword" type="password" autoComplete="current-password" disabled={deactivating} required />
                </Field>
                <div>
                  <SaveButton type="submit" state={deactivating ? "busy" : save.state} disabled={deactivating} tone="danger">Desativar verificação em duas etapas</SaveButton>
                </div>
              </form>
            ) : null}
          </div>
        </Section>
      </Card>

      <Card className="admin-card">
        <Section title="Sessões ativas" className="section">
          <Lock size={18} className="accent" aria-hidden="true" />
          <div className="grid gap-3">
            <p className="sub">Dispositivos com login ativo na sua conta. Encerrar uma sessão a desconecta imediatamente.</p>
            {sessionError ? <p className="error" role="alert">{sessionError}</p> : null}
            {sessionMessage ? <p className="accent text-sm" role="status">{sessionMessage}</p> : null}
            {error ? (
              <p className="error" role="alert">Não foi possível carregar as sessões.</p>
            ) : sessions.length === 0 ? (
              <p className="sub">Nenhuma sessão ativa.</p>
            ) : (
              <ul className="grid gap-2" aria-label="Lista de sessões ativas">
                {sessions.map((session) => (
                  <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-2" key={session.id}>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <strong className="text-sm">{formatPanelDateTime(session.created_at, { dateStyle: "short", timeStyle: "short" })}</strong>
                        {session.current ? (
                          <span className="rounded border border-[var(--primary-border)] px-2 py-0.5 type-caption font-semibold uppercase tracking-[.1em] text-[var(--primary-text)]">Esta sessão</span>
                        ) : null}
                      </div>
                      <span className="mono block truncate text-xs text-[var(--text-secondary)]">
                        {session.ip_address ?? "IP indisponível"} · {session.user_agent ?? "dispositivo não identificado"}
                      </span>
                    </div>
                    <SaveButton
                      type="button"
                      state={revoking === session.id ? "busy" : "idle"}
                      busyLabel="Encerrando…"
                      disabled={revoking === session.id}
                      onClick={() => void revoke(session)}
                    >
                      Encerrar
                    </SaveButton>
                  </li>
                ))}
              </ul>
            )}
            {sessions.some((session) => !session.current) ? (
              <div>
                <Button
                  type="button"
                  tone="danger"
                  disabled={revokingOthers}
                  onClick={() => {
                    if (!window.confirm("Encerrar todas as outras sessões abertas da sua conta?")) return;
                    void revokeOthers();
                  }}
                >
                  {revokingOthers ? "Encerrando…" : "Encerrar outras sessões"}
                </Button>
              </div>
            ) : null}
          </div>
        </Section>
      </Card>
    </div>
  );
}
