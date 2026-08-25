"use client";

import { type FormEvent, useState } from "react";
import { Key, X } from "@phosphor-icons/react";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";
import type { PanelSession } from "@/lib/session";

export type WorkspaceMember = {
  id: string;
  status: "active" | "suspended";
  joined_at: string | null;
  created_at: string;
  user_id: string;
  name: string | null;
  email: string;
  user_status: string;
  is_root: boolean;
  must_change_password: boolean;
  role_id: string;
  role_name: string;
  is_owner_role: boolean;
};

export function canManageMemberProfile(session: PanelSession, member: WorkspaceMember) {
  if (member.user_id === session.user.id) return false;
  if (session.user.isRoot && session.rootWorkspaceAccess) return true;
  if (member.is_root) return false;
  const actorRole = session.activeWorkspace?.role;
  if (actorRole === "OWNER") return !member.is_owner_role;
  if (actorRole === "ADMIN") return !member.is_owner_role && member.role_name !== "ADMIN";
  return false;
}

export function MemberProfileDialog({
  member,
  onClose,
  onSaved
}: {
  member: WorkspaceMember;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [mustChangePassword, setMustChangePassword] = useState(true);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setError("");

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    if (temporaryPassword !== passwordConfirmation) {
      setError("A confirmação da senha não confere.");
      return;
    }

    const payload = {
      name: name && name !== (member.name ?? "") ? name : undefined,
      email: email && email !== member.email ? email : undefined,
      newPassword: temporaryPassword || undefined,
      mustChangePassword: temporaryPassword ? mustChangePassword : undefined
    };
    if (!payload.name && !payload.email && !payload.newPassword) {
      setError("Altere o nome, o e-mail ou informe uma nova senha.");
      return;
    }

    setSaving(true);
    try {
      await api(`/workspaces/current/members/${member.id}/profile`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      await onSaved();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Falha ao atualizar o perfil do membro");
    } finally {
      setSaving(false);
    }
  }

  const passwordMinimum = mustChangePassword ? 8 : 12;

  return (
    <ModalDialog
      className="member-profile-dialog"
      labelledBy="member-profile-title"
      describedBy="member-profile-description"
      onClose={saving ? () => undefined : onClose}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <span className="eyebrow">CONTA DO MEMBRO</span>
          <h2 id="member-profile-title" className="mt-2">Editar perfil</h2>
        </div>
        <button type="button" className="btn px-2" aria-label="Fechar edição" disabled={saving} onClick={onClose}>
          <X size={17} aria-hidden="true" />
        </button>
      </div>
      <p id="member-profile-description">
        Nome e e-mail valem para todos os workspaces dessa conta. Uma nova senha encerra as sessões abertas.
      </p>

      <form className="admin-form mt-1" aria-busy={saving} onSubmit={submit}>
        <label className="field">
          <span className="label">Nome</span>
          <input
            className="input"
            name="name"
            type="text"
            defaultValue={member.name ?? ""}
            maxLength={200}
            data-autofocus
            disabled={saving}
          />
        </label>
        <label className="field">
          <span className="label">E-mail</span>
          <input className="input" name="email" type="email" defaultValue={member.email} disabled={saving} required />
        </label>

        <div className="border-t border-[var(--border)] pt-4">
          <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-[var(--heading)]">
            <Key size={17} className="accent" aria-hidden="true" />
            Redefinir senha
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <label className="field">
              <span className="label">{mustChangePassword ? "Senha temporária" : "Nova senha"}</span>
              <input
                className="input"
                name="newPassword"
                type="password"
                autoComplete="new-password"
                minLength={passwordMinimum}
                maxLength={200}
                value={temporaryPassword}
                placeholder="Opcional"
                disabled={saving}
                onChange={(event) => setTemporaryPassword(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="label">Confirmar senha</span>
              <input
                className="input"
                name="passwordConfirmation"
                type="password"
                autoComplete="new-password"
                minLength={passwordMinimum}
                maxLength={200}
                value={passwordConfirmation}
                placeholder="Repita a senha"
                disabled={saving}
                onChange={(event) => setPasswordConfirmation(event.target.value)}
              />
            </label>
          </div>
          <label className="mt-4 flex items-start gap-3 border border-[var(--border)] p-3 text-sm text-[var(--body)]">
            <input
              type="checkbox"
              checked={mustChangePassword}
              disabled={saving}
              onChange={(event) => setMustChangePassword(event.target.checked)}
            />
            <span>
              <strong className="block text-[var(--heading)]">Alterar senha no próximo login</strong>
              <small className="sub mt-1 block">
                O membro entra com esta senha temporária e precisa criar outra antes de acessar o painel.
              </small>
            </span>
          </label>
          <p className="sub mt-3 text-xs">
            {mustChangePassword
              ? "A senha temporária deve ter ao menos 8 caracteres."
              : "Sem troca obrigatória, a nova senha deve ter ao menos 12 caracteres."}
          </p>
        </div>

        {error ? <p className="error" role="alert">{error}</p> : null}
        {member.must_change_password ? (
          <p className="warning text-xs" role="status">Este membro já possui uma troca de senha pendente.</p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="btn" disabled={saving} onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? "Salvando…" : "Salvar perfil"}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
