"use client";

import { FormEvent, useMemo, useState } from "react";
import { ArrowsClockwise, ArrowsLeftRight, DotsThreeVertical, LinkSimple, PencilSimple, Trash } from "@phosphor-icons/react";
import useSWR from "swr";
import { Empty, LoadingCards } from "@/components/page-state";
import { PopoverMenu } from "@/components/popover-menu";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { accessStatusLabel } from "@/lib/labels";
import { canAccessWithSession, type PanelSession } from "@/lib/session";
import {
  canManageMemberProfile,
  MemberProfileDialog,
  type WorkspaceMember
} from "./member-profile-dialog";
import { AdminField, AdminPage, AdminPageHeader, AdminTableScroll } from "@/components/admin";
import { IconButton, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";


type Role = {
  id: string;
  name: string;
  description: string;
  is_owner_role: boolean;
  is_system: boolean;
  permissions: string[];
  member_count: number;
};

type Invitation = {
  id: string;
  email: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  expires_at: string;
  created_at: string;
  accepted_at: string | null;
  role_id: string;
  role_name: string;
  invited_by_email: string;
  accepted_by_email: string | null;
};

type InviteResult = {
  email: string;
  expiresAt: string;
  token?: string;
  emailDelivery?: { status: "sent" | "failed"; error?: string };
};

const fetcher = <T,>(url: string) => api<T>(url);
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });

function toneForStatus(status: string) {
  if (status === "active" || status === "accepted") return "admin-badge admin-badge--ok";
  if (status === "pending") return "admin-badge admin-badge--warn";
  return "admin-badge";
}

function invitationStatusDetail(invitation: Invitation) {
  if (invitation.accepted_at) return `Aceito em ${dateTime.format(new Date(invitation.accepted_at))}`;
  if (invitation.status === "revoked") return "Revogado antes do aceite";
  if (invitation.status === "expired") return "Expirou antes do aceite";
  return "Aguardando aceite";
}

export default function WorkspaceMembersPage() {
  const { data: session } = useSWR<PanelSession>("/me", fetcher, { revalidateOnFocus: false, dedupingInterval: 10_000 });
  const { data: membersData, error: membersError, mutate: mutateMembers } = useSWR<{ members: WorkspaceMember[] }>("/workspaces/current/members", fetcher, { revalidateOnFocus: false });
  const { data: rolesData, error: rolesError, mutate: mutateRoles } = useSWR<{ roles: Role[] }>("/workspaces/current/member-roles", fetcher, { revalidateOnFocus: false });
  const { data: invitationsData, error: invitationsError, mutate: mutateInvitations } = useSWR<{ invitations: Invitation[] }>("/workspaces/current/invitations", fetcher, { revalidateOnFocus: false });

  const [error, setError] = useState("");
  const save = useSaveFeedback();
  const [submittingInvite, setSubmittingInvite] = useState(false);
  const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
  const [busyMemberId, setBusyMemberId] = useState<string | null>(null);
  const [busyInvitationId, setBusyInvitationId] = useState<string | null>(null);
  const [editingMember, setEditingMember] = useState<WorkspaceMember | null>(null);

  const members = membersData?.members ?? [];
  const invitations = invitationsData?.invitations ?? [];
  const roles = useMemo(() => rolesData?.roles ?? [], [rolesData?.roles]);
  const inviteRoles = useMemo(() => roles.filter((role) => !role.is_owner_role), [roles]);

  const canInvite = session ? canAccessWithSession(session, ["members.invite"]) : false;
  const canUpdateMembers = session ? canAccessWithSession(session, ["members.update"]) : false;
  const canRemoveMembers = session ? canAccessWithSession(session, ["members.remove"]) : false;
  const canTransferOwner = Boolean(session && canUpdateMembers && (session.activeWorkspace?.role === "OWNER" || session.user.isRoot));

  async function submitInvite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingInvite || !canInvite) return;
    const form = event.currentTarget;
    setSubmittingInvite(true);
    setError("");
    setInviteResult(null);
    const formData = new FormData(form);
    try {
      const response = await api<{ invitation: { email: string; expiresAt: string }; token?: string; emailDelivery?: InviteResult["emailDelivery"] }>("/workspaces/current/invitations", {
        method: "POST",
        body: JSON.stringify({
          email: String(formData.get("email") ?? ""),
          roleId: String(formData.get("roleId") ?? "")
        })
      });
      setInviteResult({ email: response.invitation.email, expiresAt: response.invitation.expiresAt, token: response.token, emailDelivery: response.emailDelivery });
      save.markDone();
      form.reset();
      await mutateInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao enviar convite");
    } finally {
      setSubmittingInvite(false);
    }
  }

  async function updateMember(memberId: string, payload: { roleId?: string; status?: "active" | "suspended" }) {
    setBusyMemberId(memberId);
    setError("");
    try {
      await api(`/workspaces/current/members/${memberId}`, { method: "PATCH", body: JSON.stringify(payload) });
      await mutateMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao atualizar membro");
    } finally {
      setBusyMemberId(null);
    }
  }

  async function removeMember(memberId: string) {
    if (!confirm("Remover este membro do workspace?")) return;
    setBusyMemberId(memberId);
    setError("");
    try {
      await api(`/workspaces/current/members/${memberId}`, { method: "DELETE" });
      await mutateMembers();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao remover membro");
    } finally {
      setBusyMemberId(null);
    }
  }

  async function transferOwner(memberId: string) {
    if (!confirm("Transferir a propriedade do workspace para este membro?")) return;
    setBusyMemberId(memberId);
    setError("");
    try {
      await api("/workspaces/current/owner-transfer", { method: "POST", body: JSON.stringify({ memberId }) });
      await Promise.all([mutateMembers(), mutateInvitations()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao transferir propriedade");
    } finally {
      setBusyMemberId(null);
    }
  }

  async function revokeInvitation(invitationId: string) {
    if (!confirm("Revogar este convite pendente?")) return;
    setBusyInvitationId(invitationId);
    setError("");
    try {
      await api(`/workspaces/current/invitations/${invitationId}`, { method: "DELETE" });
      await mutateInvitations();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao revogar convite");
    } finally {
      setBusyInvitationId(null);
    }
  }

  const activeMembers = members.filter((member) => member.status === "active").length;
  const pendingInvites = invitations.filter((invitation) => invitation.status === "pending").length;
  const dataError = membersError || rolesError || invitationsError;

  return (
    <Shell><AdminPage>
      <AdminPageHeader title="Membros" />

      {error ? <p className="error mb-4" role="alert">{error}</p> : null}
      {dataError ? (
        <section className="mb-4 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-4" role="alert">
          <p className="error">{dataError instanceof Error ? dataError.message : "Não foi possível carregar os membros."}</p>
          <IconButton type="button" label="Tentar novamente" onClick={() => void Promise.all([mutateMembers(), mutateRoles(), mutateInvitations()])}><ArrowsClockwise size={16} aria-hidden="true" /></IconButton>
        </section>
      ) : null}

      {!dataError && (!membersData || !rolesData || !invitationsData) ? (
        <LoadingCards />
      ) : dataError ? null : (
        <>
          <section className="grid4">
            <div className="card">
              <span className="label">Membros</span>
              <div className="metric">{members.length}</div>
              <p className="sub">{activeMembers} ativos</p>
            </div>
            <div className="card">
              <span className="label">Convites</span>
              <div className="metric">{pendingInvites}</div>
              <p className="sub">pendentes</p>
            </div>
            <div className="card">
              <span className="label">Funções</span>
              <div className="metric">{inviteRoles.length}</div>
              <p className="sub">disponíveis para convite</p>
            </div>
            <div className="card">
              <span className="label">Escopo atual</span>
              <div className="metric admin-metric-copy">{session?.activeWorkspace?.role ?? "-"}</div>
              <p className="sub">{session?.user.email ?? "Sessão em preparação"}</p>
            </div>
          </section>

          <section className="admin-grid admin-grid--sidebar">
            <div className="card admin-card">
              <div className="cardtitle">
                <span>Equipe ativa</span>
                <span className="sub">{members.length} registro(s)</span>
              </div>
              {members.length === 0 ? (
                <Empty>Nenhum membro neste workspace.</Empty>
              ) : (
                <AdminTableScroll className="admin-table-wrap responsive-table-wrap">
                  <table className="admin-table responsive-table">
                    <thead>
                      <tr>
                        <th>E-mail</th>
                        <th>Função</th>
                        <th>Status</th>
                        <th>Entrada</th>
                        <th>Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {members.map((member) => {
                        const locked = busyMemberId === member.id;
                        return (
                          <tr key={member.id}>
                            <td data-label="E-mail">
                              <strong>{member.name || member.email}</strong>
                              <span className="sub">{member.name ? member.email : (member.is_owner_role ? "Proprietário atual" : member.user_status)}</span>
                              {member.must_change_password ? (
                                <span className="admin-badge admin-badge--warn mt-2">Troca de senha pendente</span>
                              ) : null}
                            </td>
                            <td data-label="Função">
                              {canUpdateMembers && !member.is_owner_role ? (
                                <select
                                  className="input"
                                  aria-label={`Função de ${member.name || member.email}`}
                                  value={member.role_id}
                                  disabled={locked}
                                  onChange={(event) => void updateMember(member.id, { roleId: event.target.value })}
                                >
                                  {inviteRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                                </select>
                              ) : (
                                <span className="admin-pill">{member.role_name}</span>
                              )}
                            </td>
                            <td data-label="Status">
                              {canUpdateMembers && !member.is_owner_role ? (
                                <select
                                  className="input"
                                  aria-label={`Status de ${member.name || member.email}`}
                                  value={member.status}
                                  disabled={locked}
                                  onChange={(event) => void updateMember(member.id, { status: event.target.value as "active" | "suspended" })}
                                >
                                  <option value="active">Ativo</option>
                                  <option value="suspended">Suspenso</option>
                                </select>
                              ) : (
                                <span className={toneForStatus(member.status)}>{accessStatusLabel(member.status)}</span>
                              )}
                            </td>
                            <td data-label="Entrada">{member.joined_at ? dateTime.format(new Date(member.joined_at)) : "Ainda não entrou"}</td>
                            <td data-label="Ações">
                              <div className="admin-actions">
                                {session && canManageMemberProfile(session, member) ? (
                                  <IconButton type="button" label="Perfil" disabled={locked} onClick={() => setEditingMember(member)}>
                                    <PencilSimple size={16} aria-hidden="true" />
                                  </IconButton>
                                ) : null}
                                {(canTransferOwner && !member.is_owner_role && member.status === "active") || (canRemoveMembers && !member.is_owner_role) ? (
                                  <PopoverMenu
                                    buttonClassName="btn"
                                    icon={<DotsThreeVertical size={16} weight="bold" aria-hidden="true" />}
                                    ariaLabel={`Mais ações de ${member.name || member.email}`}
                                    title="Mais ações"
                                    panelClassName="conversation-action-menu__panel"
                                  >
                                    {(close) => (
                                      <>
                                        {canTransferOwner && !member.is_owner_role && member.status === "active" ? (
                                          <button type="button" className="conversation-action-menu__item" disabled={locked} onClick={() => { close(); void transferOwner(member.id); }}>
                                            <ArrowsLeftRight size={15} aria-hidden="true" /> Transferir propriedade
                                          </button>
                                        ) : null}
                                        {canRemoveMembers && !member.is_owner_role ? (
                                          <button type="button" className="conversation-action-menu__item conversation-action-menu__item--warn" disabled={locked} onClick={() => { close(); void removeMember(member.id); }}>
                                            <Trash size={15} aria-hidden="true" /> Remover do workspace
                                          </button>
                                        ) : null}
                                      </>
                                    )}
                                  </PopoverMenu>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </AdminTableScroll>
              )}
            </div>

            <aside className="admin-stack">
              <form className="card admin-card" aria-busy={submittingInvite} onSubmit={submitInvite}>
                <div className="cardtitle">
                  <span>Novo convite</span>
                  <span className="sub">Fluxo público de aceite</span>
                </div>
                {!canInvite ? (
                  <Empty>Esta sessão não pode emitir convites.</Empty>
                ) : (
                  <div className="admin-form">
                    <AdminField label="E-mail" htmlFor="invite-email">
                      <input id="invite-email" className="input" name="email" type="email" placeholder="pessoa@empresa.com" disabled={submittingInvite} required />
                    </AdminField>
                    <AdminField label="Função" htmlFor="invite-role">
                      <select id="invite-role" className="input" name="roleId" required defaultValue={inviteRoles[0]?.id ?? ""} disabled={submittingInvite}>
                        {inviteRoles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
                      </select>
                    </AdminField>
                    <SaveButton type="submit" state={submittingInvite ? "busy" : save.state} busyLabel="Enviando…" disabled={submittingInvite || inviteRoles.length === 0}>
                      Enviar convite
                    </SaveButton>
                    <SaveToast show={save.done}>Convite enviado</SaveToast>
                  </div>
                )}
              </form>

              {inviteResult ? (
                <div className="card admin-card admin-card--accent" role="status">
                  <div className="cardtitle">
                    <span>Convite gerado</span>
                    <LinkSimple size={16} className="accent" aria-hidden="true" />
                  </div>
                  <dl className="admin-meta-list">
                    <div><dt>E-mail</dt><dd>{inviteResult.email}</dd></div>
                    <div><dt>Expira em</dt><dd>{dateTime.format(new Date(inviteResult.expiresAt))}</dd></div>
                    {inviteResult.emailDelivery?.status === "failed" ? (
                      <div><dt>E-mail</dt><dd className="warning">{inviteResult.emailDelivery.error ?? "Falha ao enviar convite por e-mail."}</dd></div>
                    ) : null}
                    {inviteResult.token ? (
                      <div><dt>Link público</dt><dd><a href={`/convite?token=${encodeURIComponent(inviteResult.token)}`} className="admin-inline-link">/convite?token={inviteResult.token}</a></dd></div>
                    ) : null}
                  </dl>
                </div>
              ) : null}
            </aside>
          </section>

          <section className="card admin-card">
            <div className="cardtitle">
              <span>Histórico de convites</span>
              <span className="sub">{invitations.length} registro(s)</span>
            </div>
            {invitations.length === 0 ? (
              <Empty>Nenhum convite emitido ainda.</Empty>
            ) : (
              <AdminTableScroll className="admin-table-wrap responsive-table-wrap">
                <table className="admin-table responsive-table">
                  <thead>
                    <tr>
                      <th>E-mail</th>
                      <th>Função</th>
                      <th>Status</th>
                      <th>Expiração</th>
                      <th>Origem</th>
                      <th>Ações</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((invitation) => (
                      <tr key={invitation.id}>
                        <td data-label="E-mail">
                          <strong>{invitation.email}</strong>
                          <span className="sub">{invitation.accepted_by_email ?? invitation.invited_by_email}</span>
                        </td>
                        <td data-label="Função"><span className="admin-pill">{invitation.role_name}</span></td>
                        <td data-label="Status"><span className={toneForStatus(invitation.status)}>{accessStatusLabel(invitation.status)}</span></td>
                        <td data-label="Expiração">{dateTime.format(new Date(invitation.expires_at))}</td>
                        <td data-label="Origem">
                          <strong>{invitation.invited_by_email}</strong>
                          <span className="sub">{invitationStatusDetail(invitation)}</span>
                        </td>
                        <td data-label="Ações">
                          {canInvite && invitation.status === "pending" ? (
                            <IconButton type="button" label="Revogar" disabled={busyInvitationId === invitation.id} onClick={() => void revokeInvitation(invitation.id)}>
                              <Trash size={16} aria-hidden="true" />
                            </IconButton>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </AdminTableScroll>
                )}
          </section>
        </>
      )}
      {editingMember ? (
        <MemberProfileDialog
          member={editingMember}
          onClose={() => setEditingMember(null)}
          onSaved={async () => { await mutateMembers(); }}
        />
      ) : null}
    </AdminPage></Shell>
  );
}
