"use client";

import { FormEvent, useState } from "react";
import { CheckCircle, UserCircle } from "@phosphor-icons/react";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import type { PanelSession } from "@/lib/session";

const fetcher = <T,>(url: string) => api<T>(url);

export default function ProfilePage() {
  const {
    data: session,
    error: sessionError,
    isLoading: sessionLoading,
    mutate
  } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session) return;
    setSaving(true);
    setMessage("");
    setError("");
    const form = event.currentTarget;
    const formData = new FormData(form);
    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const confirmPassword = String(formData.get("confirmPassword") ?? "");

    if (newPassword && newPassword !== confirmPassword) {
      setError("A confirmação da nova senha não confere.");
      setSaving(false);
      return;
    }

    const payload = {
      name: name && name !== (session.user.name ?? "") ? name : undefined,
      email: email !== session.user.email ? email : undefined,
      currentPassword: currentPassword || undefined,
      newPassword: newPassword || undefined
    };

    if (!payload.name && !payload.email && !payload.newPassword) {
      setError("Altere o nome, o e-mail ou informe uma nova senha.");
      setSaving(false);
      return;
    }

    try {
      const nextSession = await api<PanelSession>("/me/profile", { method: "PATCH", body: JSON.stringify(payload) });
      await mutate(nextSession, false);
      form.reset();
      setMessage("Perfil atualizado.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar perfil");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <header className="pagehead" style={{ "--eyebrow": '"PAINEL · CONTA"' } as React.CSSProperties}>
        <div>
          <h1>Perfil</h1>
          <p>Atualize o acesso da sua conta no painel.</p>
        </div>
      </header>

      {sessionError ? (
        <section className="mb-5 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--warn-border)] bg-[var(--warn-bg)] px-4 py-4" role="alert">
          <p className="error">Não foi possível carregar os dados do perfil.</p>
          <button type="button" className="btn warn" onClick={() => void mutate()}>Tentar novamente</button>
        </section>
      ) : null}

      <section className="admin-grid admin-grid--sidebar">
        <form key={session?.user.email ?? "loading"} className="card admin-card" aria-busy={saving || sessionLoading} onSubmit={submit}>
          <div className="cardtitle">
            <span>Dados de acesso</span>
            <UserCircle size={18} className="accent" aria-hidden="true" />
          </div>
          <div className="admin-form">
            <label className="field">
              <span className="label">Nome</span>
              <input className="input" name="name" type="text" defaultValue={session?.user.name ?? ""} placeholder="Como você quer ser identificado nas mensagens" disabled={saving || !session} />
            </label>
            <label className="field">
              <span className="label">E-mail</span>
              <input className="input" name="email" type="email" defaultValue={session?.user.email ?? ""} disabled={saving || !session} required />
            </label>
            <label className="field">
              <span className="label">Senha atual</span>
              <input className="input" name="currentPassword" type="password" autoComplete="current-password" placeholder="Necessária só para alterar e-mail ou senha" disabled={saving || !session} />
            </label>
            <label className="field">
              <span className="label">Nova senha</span>
              <input className="input" name="newPassword" type="password" autoComplete="new-password" minLength={12} placeholder="Opcional" disabled={saving || !session} />
            </label>
            <label className="field">
              <span className="label">Confirmar nova senha</span>
              <input className="input" name="confirmPassword" type="password" autoComplete="new-password" minLength={12} placeholder="Opcional" disabled={saving || !session} />
            </label>
            {error ? <p className="error" role="alert">{error}</p> : null}
            {message ? <p className="accent text-sm" role="status">{message}</p> : null}
            <button type="submit" className="btn primary" disabled={saving || !session}>
              {saving ? "Salvando…" : "Salvar perfil"}
            </button>
          </div>
        </form>

        <div className="card admin-card">
          <div className="cardtitle">
            <span>Sessão atual</span>
            <CheckCircle size={18} className="accent" aria-hidden="true" />
          </div>
          <dl className="admin-meta-list">
            <div><dt>Usuário</dt><dd>{session?.user.email ?? (sessionError ? "Indisponível" : "Carregando…")}</dd></div>
            <div><dt>Tipo</dt><dd>{session?.user.isRoot ? "ROOT" : "Workspace"}</dd></div>
            <div><dt>Workspace</dt><dd>{session?.activeWorkspace?.name ?? "-"}</dd></div>
            <div><dt>Função</dt><dd>{session?.activeWorkspace?.role ?? "-"}</dd></div>
          </dl>
        </div>
      </section>
    </Shell>
  );
}
