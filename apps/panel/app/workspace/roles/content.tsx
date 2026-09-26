"use client";

import { FormEvent, useMemo, useState } from "react";
import { Lock, Plus, Trash } from "@/components/icons";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { api } from "@/lib/api";
import { canAccessWithSession, type PanelSession } from "@/lib/session";
import { AdminButton, AdminPage, AdminPageHeader } from "@/components/admin";
import { IconButton, HelpHint, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";


type Role = {
  id: string;
  name: string;
  description: string;
  is_owner_role: boolean;
  is_system: boolean;
  permissions: string[];
  member_count: number;
};

type Permission = {
  key: string;
  module: string;
  action: string;
  description: string;
};

type RoleResponse = {
  roles: Role[];
  permissions: Permission[];
};

const fetcher = <T,>(url: string) => api<T>(url);

type EditorState = {
  id?: string;
  name: string;
  description: string;
  permissions: string[];
  isOwner: boolean;
  isSystem: boolean;
  memberCount: number;
};

function buildEditor(role?: Role): EditorState {
  if (!role) return { name: "", description: "", permissions: [], isOwner: false, isSystem: false, memberCount: 0 };
  return {
    id: role.id,
    name: role.name,
    description: role.description ?? "",
    permissions: [...role.permissions],
    isOwner: role.is_owner_role,
    isSystem: role.is_system,
    memberCount: role.member_count
  };
}

export function WorkspaceRolesContent() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const { data, error, mutate } = useSWR<RoleResponse>("/workspaces/current/roles", fetcher, { revalidateOnFocus: false });
  const [editor, setEditor] = useState<EditorState>(buildEditor());
  const [selectedId, setSelectedId] = useState<string | "new">("new");
  const [saving, setSaving] = useState(false);
  const save = useSaveFeedback();
  const [message, setMessage] = useState("");

  const roles = data?.roles ?? [];
  const permissions = useMemo(() => data?.permissions ?? [], [data?.permissions]);

  const groupedPermissions = useMemo(() => {
    const buckets = new Map<string, Permission[]>();
    for (const permission of permissions) {
      const list = buckets.get(permission.module) ?? [];
      list.push(permission);
      buckets.set(permission.module, list);
    }
    return [...buckets.entries()];
  }, [permissions]);

  const canCreate = session ? canAccessWithSession(session, ["roles.create"]) : false;
  const canUpdate = session ? canAccessWithSession(session, ["roles.update"]) : false;
  const canDelete = session ? canAccessWithSession(session, ["roles.delete"]) : false;
  const editingProtectedRole = editor.isOwner || editor.isSystem;
  const canEditSelected = editor.id ? canUpdate : canCreate;

  function selectRole(role?: Role) {
    setSelectedId(role?.id ?? "new");
    setEditor(buildEditor(role));
    setMessage("");
  }

  function togglePermission(key: string) {
    if (editingProtectedRole || !canEditSelected) return;
    setEditor((current) => ({
      ...current,
      permissions: current.permissions.includes(key)
        ? current.permissions.filter((value) => value !== key)
        : [...current.permissions, key]
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || editingProtectedRole || (!editor.id && !canCreate) || (editor.id && !canUpdate)) return;
    setSaving(true);
    setMessage("");
    try {
      const payload = {
        name: editor.name,
        description: editor.description,
        permissions: editor.permissions
      };
      let selectedRoleId = editor.id;
      if (selectedRoleId) {
        await api(`/workspaces/current/roles/${selectedRoleId}`, { method: "PUT", body: JSON.stringify(payload) });
      } else {
        const response = await api<{ role: { id: string } }>("/workspaces/current/roles", { method: "POST", body: JSON.stringify(payload) });
        selectedRoleId = response.role.id;
      }
      const next = await mutate();
      const nextRoles = next?.roles ?? [];
      const selected = nextRoles.find((role) => role.id === selectedRoleId);
      selectRole(selected);
      save.markDone();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Falha ao salvar função");
    } finally {
      setSaving(false);
    }
  }

  async function removeRole() {
    if (!editor.id || !canDelete || editingProtectedRole || saving) return;
    if (!confirm("Excluir esta função?")) return;
    setSaving(true);
    setMessage("");
    try {
      await api(`/workspaces/current/roles/${editor.id}`, { method: "DELETE" });
      await mutate();
      selectRole();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Falha ao excluir função");
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminPage>
      <AdminPageHeader title="Funções e permissões" actions={<AdminButton tone="primary" disabled={!canCreate} onClick={() => selectRole()}>
          <Plus size={16} aria-hidden="true" />
          Nova função
        </AdminButton>} />

      {error ? <p className="error mb-4" role="alert">{error.message}</p> : null}
      {message ? <p className="error mb-4" role="alert">{message}</p> : null}

      <section className="admin-grid admin-grid--sidebar">
        <div className="card admin-card">
          <div className="cardtitle">
            <span>Funções</span>
            <span className="sub">{roles.length} total</span>
          </div>
          {!data && !error ? (
            <div className="grid gap-2" role="status" aria-busy="true">
              <span className="sr-only">Carregando funções</span>
              {[1, 2, 3].map((i) => <div key={i} className="skeleton h-16" aria-hidden="true" />)}
            </div>
          ) : roles.length === 0 ? (
            <Empty>Nenhuma função disponível.</Empty>
          ) : (
            <div className="admin-list">
              {roles.map((role) => (
                <button
                  type="button"
                  key={role.id}
                  className={`admin-list-item${selectedId === role.id ? " admin-list-item--active" : ""}`}
                  onClick={() => selectRole(role)}
                >
                  <div>
                    <strong>{role.name}</strong>
                    <p>{role.description || "Sem descrição operacional."}</p>
                  </div>
                  <div className="admin-list-meta">
                    {role.is_owner_role ? <span className="admin-badge admin-badge--warn">OWNER</span> : null}
                    {role.is_system ? <span className="admin-badge">Sistema</span> : null}
                    <span className="sub">{role.member_count} membro(s)</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <form className="card admin-card" aria-busy={saving} onSubmit={submit}>
          <div className="cardtitle">
            <span>{editor.id ? "Editar função" : "Nova função"} <HelpHint label="Ajuda: Como as permissões valem">As permissões dizem o que quem tem a função pode ver e fazer. Ao salvar, o novo conjunto vale na hora para todos os membros com ela.</HelpHint></span>
            {editingProtectedRole ? (
              <span className="admin-badge admin-badge--warn"><Lock size={12} aria-hidden="true" />Protegida</span>
            ) : null}
          </div>

          {editingProtectedRole ? (
            <p className="sub mb-4" role="status">Função protegida. Esta configuração está disponível somente para consulta.</p>
          ) : !canEditSelected ? (
            <p className="sub mb-4" role="status">Acesso somente leitura. Você não tem permissão para {editor.id ? "editar" : "criar"} funções.</p>
          ) : null}

          <fieldset className="contents" disabled={saving || editingProtectedRole || !canEditSelected}>
          <div className="admin-form">
            <label className="field">
              <span className="label">Nome</span>
              <input
                className="input"
                value={editor.name}
                onChange={(event) => setEditor((current) => ({ ...current, name: event.target.value }))}
                placeholder="Ex.: Agenda externa"
                required
              />
            </label>
            <label className="field">
              <span className="label">Descrição</span>
              <textarea
                className="input admin-textarea"
                value={editor.description}
                onChange={(event) => setEditor((current) => ({ ...current, description: event.target.value }))}
                placeholder="Resumo operacional desta função."
                rows={4}
              />
            </label>
          </div>

          <div className="admin-matrix">
            {groupedPermissions.map(([module, modulePermissions]) => (
              <section key={module} className="admin-matrix-group">
                <header>
                  <strong>{module}</strong>
                  <span>{modulePermissions.length} permissão(ões)</span>
                </header>
                <div className="admin-matrix-rows">
                  {modulePermissions.map((permission) => (
                    <label key={permission.key} className="admin-matrix-row">
                      <div>
                        <strong>{permission.key}</strong>
                        <p>{permission.description}</p>
                      </div>
                      <input
                        type="checkbox"
                        checked={editor.permissions.includes(permission.key)}
                        onChange={() => togglePermission(permission.key)}
                      />
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </div>
          </fieldset>

          <div className="admin-actions admin-actions--end">
            {editor.id ? (
              <>
                <IconButton type="button" label="Excluir" disabled={!canDelete || saving || editingProtectedRole || editor.memberCount > 0} onClick={() => void removeRole()}>
                  <Trash size={16} aria-hidden="true" />
                </IconButton>
                <HelpHint label="Ajuda: Excluir função">Uma função usada por algum membro não pode ser excluída; mova os membros para outra função antes.</HelpHint>
              </>
            ) : null}
            <SaveButton type="submit" state={saving ? "busy" : save.state} disabled={saving || editingProtectedRole || (!editor.id && !canCreate) || (Boolean(editor.id) && !canUpdate)}>
              Salvar função
            </SaveButton>
          </div>
          <SaveToast show={save.done}>Função salva</SaveToast>
        </form>
      </section>
    </AdminPage>
  );
}
