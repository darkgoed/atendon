"use client";

import { type FormEvent, useState } from "react";
import { Eye, EyeSlash, Key } from "@phosphor-icons/react";
import { BrandMark } from "@/components/brand-mark";
import { api } from "@/lib/api";
import { Button, Field, Input } from "@/components/ui";

export default function RequiredPasswordChangePage() {
  const [saving, setSaving] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError("");

    const formData = new FormData(event.currentTarget);
    const newPassword = String(formData.get("newPassword") ?? "");
    const passwordConfirmation = String(formData.get("passwordConfirmation") ?? "");
    if (newPassword !== passwordConfirmation) {
      setError("A confirmação da nova senha não confere.");
      return;
    }

    setSaving(true);
    try {
      const response = await api<{ user: { isRoot: boolean } }>("/auth/password-change-required", {
        method: "POST",
        body: JSON.stringify({ newPassword, passwordConfirmation })
      });
      window.location.assign(response.user.isRoot ? "/root/workspaces" : "/");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Falha ao criar a nova senha");
      setSaving(false);
    }
  }

  return (
    <main className="invitation-page">
      <section className="invitation-panel" aria-labelledby="required-password-title">
        <div className="invitation-brand">
          <BrandMark />
          <span>AtendON</span>
        </div>
        <header className="invitation-header">
          <span className="eyebrow">SEGURANÇA DA CONTA</span>
          <h1 id="required-password-title">Crie uma nova senha</h1>
          <p>A senha recebida era temporária. Defina uma senha pessoal para liberar o acesso ao painel.</p>
        </header>

        <form className="admin-form" aria-busy={saving} onSubmit={submit}>
          <Field label="Nova senha" hint="Use ao menos 12 caracteres e não repita a senha temporária.">
            <div className="relative">
              <Input
                className="input--with-action"
                name="newPassword"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                minLength={12}
                maxLength={200}
                disabled={saving}
                required
                autoFocus
              />
              <button
                type="button"
                className="password-toggle"
                aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                disabled={saving}
                onClick={() => setShowPassword((current) => !current)}
              >
                {showPassword
                  ? <EyeSlash size={18} aria-hidden="true" />
                  : <Eye size={18} aria-hidden="true" />}
              </button>
            </div>
          </Field>
          <Field label="Confirmar nova senha">
            <Input
              name="passwordConfirmation"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              minLength={12}
              maxLength={200}
              disabled={saving}
              required
            />
          </Field>

          {error ? <p className="error" role="alert">{error}</p> : null}
          <Button type="submit" tone="primary" className="button-wide" icon={<Key size={18} aria-hidden="true" />} disabled={saving}>
            {saving ? "Salvando…" : "Criar senha e continuar"}
          </Button>
        </form>
      </section>
    </main>
  );
}
