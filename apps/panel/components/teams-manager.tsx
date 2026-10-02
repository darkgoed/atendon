"use client";

/**
 * B6 Times (spec v7, ONDA 2) — gestão de equipes do workspace.
 * Endpoints existentes: GET/POST/PATCH/DELETE /organization/teams. Toda regra
 * fica no backend (nome único 409, exclusão com membros exige detach_members).
 * A permissão de gestão (members.update) é avaliada pelo pai e chega em
 * `canManage`; leitura é permitida a qualquer membro do workspace.
 */

import { type FormEvent, useState } from "react";
import useSWR from "swr";
import { PencilSimple, Trash, UsersThree } from "@/components/icons";
import { Empty, LoadingCards } from "@/components/page-state";
import { api } from "@/lib/api";
import { IconButton, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";

export type TeamView = {
  id: string;
  name: string;
  member_count: number;
  active_member_count: number;
};

const fetcher = <T,>(url: string) => api<T>(url);

export function useTeams(enabled: boolean) {
  const { data, error, mutate } = useSWR<{ teams: TeamView[] }>(enabled ? "/organization/teams" : null, fetcher, {
    revalidateOnFocus: false,
    shouldRetryOnError: false
  });
  return { teams: data?.teams ?? [], error, mutate };
}

export function TeamsManager({ teams, isLoading, loadFailed, canManage, onChanged }: {
  teams: TeamView[];
  isLoading: boolean;
  loadFailed: boolean;
  canManage: boolean;
  onChanged: () => unknown | Promise<unknown>;
}) {
  const save = useSaveFeedback();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function createTeam(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || creating) return;
    setCreating(true);
    setError("");
    try {
      await api("/organization/teams", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setName("");
      await onChanged();
      save.markDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao criar a equipe");
    } finally {
      setCreating(false);
    }
  }

  async function renameTeam(teamId: string) {
    if (!canManage || savingEdit) return;
    setSavingEdit(true);
    setError("");
    try {
      await api(`/organization/teams/${teamId}`, { method: "PATCH", body: JSON.stringify({ name: editName.trim() }) });
      setEditingId(null);
      await onChanged();
      save.markDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao renomear a equipe");
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteTeam(team: TeamView) {
    if (!canManage || busyId) return;
    if (!window.confirm(`Excluir a equipe “${team.name}”?`)) return;
    setBusyId(team.id);
    setError("");
    try {
      await api(`/organization/teams/${team.id}`, { method: "DELETE", body: JSON.stringify({ detach_members: false }) });
      await onChanged();
      save.markDone();
    } catch (cause) {
      // Regra do backend: exclusão com membros vinculados exige desassociação
      // explícita (409 TEAM_HAS_MEMBERS) — segunda confirmação decide.
      const message = cause instanceof Error ? cause.message : "";
      if (/membros/i.test(message) && window.confirm(`${message}\n\nDesassociar os membros e excluir a equipe?`)) {
        try {
          await api(`/organization/teams/${team.id}`, { method: "DELETE", body: JSON.stringify({ detach_members: true }) });
          await onChanged();
          save.markDone();
        } catch (retryCause) {
          setError(retryCause instanceof Error ? retryCause.message : "Falha ao excluir a equipe");
        }
      } else {
        setError(message || "Falha ao excluir a equipe");
      }
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="card admin-card" aria-busy={creating}>
      <div className="cardtitle">
        <span>Equipes <UsersThree size={16} className="accent inline" aria-hidden="true" /></span>
        <span className="sub">{teams.length} equipe(s)</span>
      </div>
      {loadFailed ? (
        <Empty>Não foi possível carregar as equipes.</Empty>
      ) : isLoading ? (
        <LoadingCards />
      ) : teams.length === 0 ? (
        <Empty>Nenhuma equipe criada. Agrupe membros para filtrar e atribuir conversas.</Empty>
      ) : (
        <ul className="grid gap-2" aria-label="Lista de equipes">
          {teams.map((team) => (
            <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] px-3 py-2" key={team.id}>
              {editingId === team.id ? (
                <form
                  className="flex flex-1 items-center gap-2"
                  onSubmit={(event) => { event.preventDefault(); void renameTeam(team.id); }}
                >
                  <input
                    className="input"
                    value={editName}
                    onChange={(event) => setEditName(event.target.value)}
                    maxLength={80}
                    required
                    aria-label={`Novo nome da equipe ${team.name}`}
                    disabled={savingEdit}
                    autoFocus
                  />
                  <SaveButton type="submit" state={savingEdit ? "busy" : "idle"} busyLabel="Salvando…">Salvar</SaveButton>
                  <button type="button" className="btn" onClick={() => setEditingId(null)} disabled={savingEdit}>Cancelar</button>
                </form>
              ) : (
                <>
                  <span className="min-w-0">
                    <strong>{team.name}</strong>
                    <span className="sub block">{team.active_member_count} ativo(s) de {team.member_count} membro(s)</span>
                  </span>
                  {canManage ? (
                    <span className="admin-actions">
                      <IconButton
                        type="button"
                        label={`Renomear ${team.name}`}
                        disabled={busyId === team.id}
                        onClick={() => { setEditingId(team.id); setEditName(team.name); }}
                      >
                        <PencilSimple size={15} aria-hidden="true" />
                      </IconButton>
                      <IconButton
                        type="button"
                        label={`Excluir ${team.name}`}
                        disabled={busyId === team.id}
                        onClick={() => void deleteTeam(team)}
                      >
                        <Trash size={15} aria-hidden="true" />
                      </IconButton>
                    </span>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form className="admin-form mt-3" onSubmit={createTeam}>
          <label className="field">
            <span className="label">Nova equipe</span>
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              placeholder="Ex.: Suporte nível 2"
              disabled={creating}
            />
          </label>
          <SaveButton type="submit" state={creating ? "busy" : save.state} busyLabel="Criando…" disabled={creating || name.trim().length === 0}>
            Criar equipe
          </SaveButton>
        </form>
      ) : null}
      {error ? <p className="error mt-2" role="alert">{error}</p> : null}
      <SaveToast show={save.done}>Equipes atualizadas</SaveToast>
    </section>
  );
}
