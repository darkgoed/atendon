"use client";

import { ArrowLeft, Eye, EyeSlash } from "@/components/icons";
import { type FormEvent, useState } from "react";
import { BrandMark } from "@/components/brand-mark";
import { Button, Field, Input } from "@/components/ui";
import { api } from "@/lib/api";

export default function Login() {
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // 2FA: /auth/login só emite o desafio; a sessão vem de /auth/totp/verify.
  const [totpStep, setTotpStep] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading) return;

    setLoading(true);
    setError("");
    const data = new FormData(event.currentTarget);

    try {
      const session = totpStep
        ? await api<{ user: { isRoot: boolean; mustChangePassword: boolean } }>("/auth/totp/verify", {
          method: "POST",
          body: JSON.stringify({ code: String(data.get("code") ?? "") })
        })
        : await api<{ totp_required?: boolean; user: { isRoot: boolean; mustChangePassword: boolean } }>("/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email: String(data.get("email") ?? ""),
            password: String(data.get("password") ?? "")
          })
        });
      if ("totp_required" in session && session.totp_required) {
        setTotpStep(true);
        setLoading(false);
        return;
      }
      window.location.assign(
        session.user.mustChangePassword
          ? "/alterar-senha"
          : session.user.isRoot ? "/root/workspaces" : "/"
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao entrar");
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-brand">
        <BrandMark className="login-brand-art" />
        <span>AtendON</span>
      </div>

      <a className="hub-link" href="https://alpdash.com.br/" aria-label="Voltar para o HubON">
        <ArrowLeft size={16} aria-hidden="true" />
        <span>HubON</span>
      </a>

      <section className="login-intro">
        <span className="eyebrow">ATENDIMENTO · INTELIGÊNCIA</span>
        <h1>
          Seu atendimento,<br />
          <span>sempre ligado.</span>
        </h1>
        <p>Conversas, agenda e operação do agente em um painel direto e seguro.</p>
      </section>

      <form className="login-form" aria-busy={loading} onSubmit={submit}>
        <header>
          <span className="eyebrow">ACESSO AO PAINEL</span>
          <h2>Boas-vindas</h2>
          <p>Use as credenciais fornecidas pela equipe AtendON.</p>
        </header>

        {totpStep ? (
          <Field label="Código de verificação" htmlFor="code" hint="Digite o código de 6 dígitos do seu app autenticador.">
            <Input
              id="code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9 ]{6,12}"
              maxLength={12}
              disabled={loading}
              required
              autoFocus
            />
          </Field>
        ) : <>
        <Field label="E-mail" htmlFor="email">
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            disabled={loading}
            required
            autoFocus
          />
        </Field>

        <Field label="Senha" htmlFor="password">
          <div className="relative">
            <Input
              className="input--with-action"
              id="password"
              name="password"
              type={showPassword ? "text" : "password"}
              autoComplete="current-password"
              disabled={loading}
              required
            />
            <button
              type="button"
              className="password-toggle"
              aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
              disabled={loading}
              onClick={() => setShowPassword((current) => !current)}
            >
              {showPassword
                ? <EyeSlash size={18} aria-hidden="true" />
                : <Eye size={18} aria-hidden="true" />}
            </button>
          </div>
        </Field>
        </>}

        {error ? <p className="error" role="alert">{error}</p> : null}

        <Button type="submit" tone="primary" className="button-wide" disabled={loading}>
          {loading ? "Entrando…" : totpStep ? "Verificar e entrar" : "Entrar"}
        </Button>
        <p className="login-note">Acesso restrito · sem cadastro público</p>
      </form>
    </main>
  );
}
