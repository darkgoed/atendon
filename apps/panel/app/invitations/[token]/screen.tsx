"use client";

import { ArrowRight, SealCheck, Warning } from "@/components/icons";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { api } from "@/lib/api";
import { finalInvitationState, newPasswordsMatch, type InvitationStatus } from "./invitation-state";

type Invitation = {
  email: string;
  status: InvitationStatus;
  expires_at: string;
  workspace_name: string;
  role_name: string;
  existingUser: boolean;
};

const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "long", timeStyle: "short" });

export default function InvitationAcceptPage({ token }: { token: string }) {
  const router = useRouter();
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("Token do convite ausente.");
      setLoading(false);
      return;
    }
    let cancelled = false;
    api<{ invitation: Invitation }>(`/invitations/${encodeURIComponent(token)}`)
      .then((response) => {
        if (!cancelled) setInvitation(response.invitation);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Convite indisponível");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setError("");
    const formData = new FormData(event.currentTarget);
    const currentPassword = String(formData.get("currentPassword") ?? "");
    const newPassword = String(formData.get("newPassword") ?? "");
    const passwordConfirmation = String(formData.get("passwordConfirmation") ?? "");
    if (!invitation?.existingUser && !newPasswordsMatch(newPassword, passwordConfirmation)) {
      setError("A confirmação da nova senha não confere.");
      return;
    }
    setSubmitting(true);
    try {
      await api("/auth/accept-invitation", {
        method: "POST",
        body: JSON.stringify({
          token,
          ...(invitation?.existingUser
            ? { currentPassword }
            : { newPassword, passwordConfirmation })
        })
      });
      router.push("/?welcome=invite");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao aceitar convite");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="invitation-page">
      <section className="invitation-panel">
        <div className="invitation-brand"><BrandMark className="login-brand-art" /><span>AtendON</span></div>
        <header className="invitation-header">
          <span className="eyebrow">CONVITE DE WORKSPACE</span>
          <h1>{invitation?.status === "pending" ? "Aceitar convite" : "Status do convite"}</h1>
          <p>
            {invitation?.status === "pending"
              ? invitation.existingUser
                ? "Confirme sua identidade com a senha atual da sua conta."
                : "Crie uma senha para ativar sua conta e acessar o workspace."
              : "Confira abaixo a situação deste convite."}
          </p>
        </header>

        {loading ? (
          <div role="status" aria-busy="true">
            <span className="sr-only">Carregando convite</span>
            <div className="skeleton invitation-loading" aria-hidden="true" />
          </div>
        ) : null}
        {error ? <p className="error" role="alert">{error}</p> : null}

        {invitation ? (
          <>
            <div className="invitation-summary">
              <div><span className="label">Workspace</span><strong>{invitation.workspace_name}</strong></div>
              <div><span className="label">Função</span><strong>{invitation.role_name}</strong></div>
              <div><span className="label">E-mail</span><strong>{invitation.email}</strong></div>
              <div><span className="label">Expiração</span><strong>{dateTime.format(new Date(invitation.expires_at))}</strong></div>
            </div>

            {invitation.status === "pending" ? (
              <form className="invitation-form" aria-busy={submitting} onSubmit={submit}>
                {invitation.existingUser ? (
                  <label className="field">
                    <span className="label">Senha atual</span>
                    <input className="input" name="currentPassword" type="password" minLength={8} autoComplete="current-password" disabled={submitting} required />
                  </label>
                ) : (
                  <>
                    <label className="field">
                      <span className="label">Nova senha</span>
                      <input className="input" name="newPassword" type="password" minLength={8} autoComplete="new-password" disabled={submitting} required />
                    </label>
                    <label className="field">
                      <span className="label">Confirmar nova senha</span>
                      <input className="input" name="passwordConfirmation" type="password" minLength={8} autoComplete="new-password" disabled={submitting} required />
                    </label>
                  </>
                )}
                <button type="submit" className="btn primary" disabled={submitting}>
                  {submitting ? "Confirmando…" : "Aceitar convite"}
                  <ArrowRight size={16} aria-hidden="true" />
                </button>
              </form>
            ) : (
              <InvitationFinalState status={invitation.status} />
            )}
          </>
        ) : null}
      </section>
    </main>
  );
}

function InvitationFinalState({ status }: { status: Exclude<InvitationStatus, "pending"> }) {
  const state = finalInvitationState(status);
  return (
    <div className="invitation-state">
      <div className={`invitation-state__icon${status === "accepted" ? " invitation-state__icon--ok" : ""}`} aria-hidden="true">
        {status === "accepted" ? <SealCheck size={24} /> : <Warning size={24} />}
      </div>
      <div>
        <strong>{state.title}</strong>
        <p>{state.description}</p>
        {state.canLogin ? <Link className="btn mt-4 inline-flex" href="/login">Entrar no painel</Link> : null}
      </div>
    </div>
  );
}
