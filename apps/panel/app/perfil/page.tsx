"use client";

import { type FormEvent, useState } from "react";
import { CheckCircle, SlidersHorizontal, UserCircle } from "@/components/icons";
import useSWR from "swr";
import { Shell } from "@/components/shell";
import { AppearancePreferences } from "@/components/appearance-preferences";
import { api } from "@/lib/api";
import { workspaceRoleLabel } from "@/lib/labels";
import type { PanelSession } from "@/lib/session";
import { Card, Field, Input, PageHeader, SaveButton, SaveToast, Section, useSaveFeedback } from "@/components/ui";
import styles from "@/components/settings-panels.module.css";

const fetcher = <T,>(url: string) => api<T>(url);

export default function ProfilePage() {
  const save = useSaveFeedback();
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
      save.markDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar perfil");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Shell>
      <PageHeader title="Perfil" />

      {sessionError ? (
        <section className="mb-5 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-4" role="alert">
          <p className="error">Não foi possível carregar os dados do perfil.</p>
          <button type="button" className="btn warn" onClick={() => void mutate()}>Tentar novamente</button>
        </section>
      ) : null}

      <div className={styles.surface}>
      <div className="admin-grid admin-grid--sidebar">
        <form key={session?.user.email ?? "loading"} className="card admin-card" aria-busy={saving || sessionLoading} onSubmit={submit}>
          <Section title="Dados de acesso" className={styles.section}>
            <UserCircle size={18} className="accent" aria-hidden="true" />
          <div className={styles.form}>
            <Field label="Nome"><Input name="name" type="text" defaultValue={session?.user.name ?? ""} placeholder="Como você quer ser identificado nas mensagens" disabled={saving || !session} /></Field>
            <Field label="E-mail"><Input name="email" type="email" defaultValue={session?.user.email ?? ""} disabled={saving || !session} required /></Field>
            <Field label="Senha atual" hint="Necessária só para alterar e-mail ou senha"><Input name="currentPassword" type="password" autoComplete="current-password" disabled={saving || !session} /></Field>
            <Field label="Nova senha" hint="Opcional" help="Ao salvar, suas outras sessões abertas são encerradas."><Input name="newPassword" type="password" autoComplete="new-password" minLength={12} disabled={saving || !session} /></Field>
            <Field label="Confirmar nova senha" hint="Opcional"><Input name="confirmPassword" type="password" autoComplete="new-password" minLength={12} disabled={saving || !session} /></Field>
            {error ? <p className="error" role="alert">{error}</p> : null}
            {message ? <p className="accent text-sm" role="status">{message}</p> : null}
            <SaveButton type="submit" state={saving ? "busy" : save.state} disabled={saving || !session}>
              Salvar perfil
            </SaveButton>
            <SaveToast show={save.done}>Perfil salvo</SaveToast>
          </div>
          </Section>
        </form>

        <Card className="admin-card">
          <Section title="Sessão atual" className={styles.section}>
            <CheckCircle size={18} className="accent" aria-hidden="true" />
          <dl className="admin-meta-list">
            <div><dt>Usuário</dt><dd>{session?.user.email ?? (sessionError ? "Indisponível" : "Carregando…")}</dd></div>
            <div><dt>Tipo</dt><dd>{session?.user.isRoot ? "ROOT" : "Workspace"}</dd></div>
            <div><dt>Workspace</dt><dd>{session?.activeWorkspace?.name ?? "-"}</dd></div>
            <div><dt>Função</dt><dd>{workspaceRoleLabel(session?.activeWorkspace?.role)}</dd></div>
          </dl>
          </Section>
        </Card>
      </div>

      <Card className="admin-card">
        <Section title="Preferências" className={styles.section}>
          <SlidersHorizontal size={18} className="accent" aria-hidden="true" />
          <AppearancePreferences />
        </Section>
      </Card>
      </div>
    </Shell>
  );
}
