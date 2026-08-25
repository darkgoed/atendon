import { Plus, UsersThree, X } from "@phosphor-icons/react";
import { useRef } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { formatBrazilianPhone, isValidBrazilianPhone } from "@/lib/phone";
import { AgendaLeadCombobox } from "./agenda-lead-combobox";
import type { AgendaActions } from "./use-agenda-actions";
import { messageFrom } from "./agenda-utils";

export function AgendaCreateDialog({ actions, timezone }: { actions: AgendaActions; timezone: string }) {
  const {
    permissions, createTarget, closeCreate, creating, actionError, createAppointment, createMode, setCreateMode,
    createLead, setCreateLead, setCreateLeadId, newLead, setNewLead, selectedStart, setSelectedStart,
    createAssigneesLoading, createAssigneesError, retryCreateAssignees, createAssigneesData,
    createAssignedMemberId, setCreateAssignedMemberId, noCreateSelectableAssignee, createLeadId, setActionError
  } = actions;
  const newContactNameRef = useRef<HTMLInputElement>(null);
  if (!permissions.canCreate || !createTarget) return null;

  return (
    <ModalDialog className="agenda-create-dialog" labelledBy="agenda-create-title" describedBy="agenda-create-description" onClose={closeCreate}>
      <div className="flex items-start justify-between gap-4">
        <div><span className="label">Novo agendamento</span><h2 id="agenda-create-title" className="mt-1">Agendar reunião</h2></div>
        <button type="button" className="btn p-2" aria-label="Fechar" disabled={creating} onClick={closeCreate}><X size={16} aria-hidden="true" /></button>
      </div>
      <p id="agenda-create-description" className="text-sm text-[var(--muted)]">Escolha um lead existente ou cadastre um novo contato. Defina o início; a reunião terá 60 minutos.</p>
      {actionError ? <p className="error" role="alert">{actionError}</p> : null}
      <form className="grid gap-5" onSubmit={createAppointment}>
        {permissions.canCreateLeads ? (
          <div className="grid grid-cols-2 gap-1 rounded-lg border border-[var(--border)] p-1" role="group" aria-label="Origem do contato">
            <button type="button" className={`rounded px-3 py-2 text-xs font-semibold active:scale-[.98] ${createMode === "existing" ? "bg-[var(--accent-bg)] text-[var(--accent-soft)]" : "text-[var(--muted)]"}`} aria-pressed={createMode === "existing"} onClick={() => setCreateMode("existing")}>Lead existente</button>
            <button type="button" className={`rounded px-3 py-2 text-xs font-semibold active:scale-[.98] ${createMode === "new" ? "bg-[var(--accent-bg)] text-[var(--accent-soft)]" : "text-[var(--muted)]"}`} aria-pressed={createMode === "new"} onClick={() => { setCreateMode("new"); requestAnimationFrame(() => newContactNameRef.current?.focus()); }}>Novo contato</button>
          </div>
        ) : null}
        {createMode === "existing" ? (
          <AgendaLeadCombobox selected={createLead} disabled={creating} onSelect={(lead) => { setCreateLead(lead); setCreateLeadId(lead?.id ?? ""); setActionError(""); }} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="field"><span className="label">Nome do contato</span><input ref={newContactNameRef} data-autofocus className="input" value={newLead.nome} maxLength={200} disabled={creating} onChange={(event) => setNewLead((current) => ({ ...current, nome: event.target.value }))} required /></label>
            <label className="field">
              <span className="label">Número / WhatsApp</span>
              <input className="input" type="tel" inputMode="numeric" autoComplete="tel-national" value={newLead.telefone} maxLength={13} disabled={creating} onChange={(event) => setNewLead((current) => ({ ...current, telefone: formatBrazilianPhone(event.target.value) }))} placeholder="12 99606-2155" required />
            </label>
            <label className="field sm:col-span-2"><span className="label">Campanha (opcional)</span><input className="input" value={newLead.campanha} maxLength={200} disabled={creating} onChange={(event) => setNewLead((current) => ({ ...current, campanha: event.target.value }))} placeholder="Ex.: Meta · Lançamento agosto" /></label>
            <small className="sub sm:col-span-2">O contato ficará salvo em Leads sob responsabilidade de quem fez o cadastro.</small>
          </div>
        )}
        <div className="grid gap-4 border-t border-[var(--border)] pt-5">
          <label className="field"><span className="label">Início</span><input className="input" type="datetime-local" value={selectedStart} disabled={creating} onChange={(event) => { setSelectedStart(event.target.value); setActionError(""); }} required /></label>
          <small className="sub">Horário do workspace: {timezone}. Duração padrão de 60 minutos; o horário pode ser compartilhado por mais de um lead, mas conflitos permanecem bloqueados para o mesmo closer.</small>
        </div>
        <section className="grid gap-3 border-t border-[var(--border)] pt-5" aria-labelledby="agenda-create-assignee-title">
          <div className="flex items-start gap-3"><UsersThree className="mt-0.5 text-[var(--accent-soft)]" size={19} aria-hidden="true" /><div><strong id="agenda-create-assignee-title" className="block text-sm">Closer responsável</strong><p className="sub mt-1 text-xs">A lista considera disponibilidade e conflitos no horário escolhido.</p></div></div>
          {createAssigneesLoading ? <div className="skeleton h-11" aria-label="Carregando closers" /> : createAssigneesError ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--warn)]" role="alert"><span>{messageFrom(createAssigneesError, "Não foi possível carregar os closers.")}</span><button type="button" className="btn warn" onClick={() => void retryCreateAssignees()}>Tentar novamente</button></div>
          ) : createAssigneesData?.can_select_assignee ? (
            <label className="field">
              <span className="sr-only">Closer responsável pela reunião</span>
              <select className="input" value={createAssignedMemberId} disabled={creating} onChange={(event) => { setCreateAssignedMemberId(event.target.value); setActionError(""); }} aria-label="Closer responsável pela reunião">
                {noCreateSelectableAssignee ? <option value="">Sem closer disponível</option> : null}
                {createAssigneesData.assignees.map((assignee) => <option key={assignee.member_id} value={assignee.member_id} disabled={!assignee.selectable}>{assignee.name?.trim() || assignee.email}{assignee.suggested ? " · sugerido" : ""}{!assignee.selectable ? assignee.conflicts.length ? " · conflito no horário" : " · indisponível" : ""}</option>)}
              </select>
              {createAssigneesData.assignees.length === 0 ? <small className="sub">Nenhum closer está configurado no pool de atendimento.</small> : null}
            </label>
          ) : <p className="text-sm text-[var(--body)]">O responsável será definido automaticamente pelo rodízio.</p>}
        </section>
        <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
          <button type="button" className="btn" disabled={creating} onClick={closeCreate}>Cancelar</button>
          <button type="submit" className="btn primary active:scale-[.98]" disabled={(createMode === "existing" ? !createLeadId : !newLead.nome.trim() || !isValidBrazilianPhone(newLead.telefone)) || !selectedStart || createAssigneesLoading || Boolean(createAssigneesError) || (createAssigneesData?.can_select_assignee === true && !createAssignedMemberId && !noCreateSelectableAssignee) || creating}><Plus size={15} aria-hidden="true" />{creating ? "Agendando…" : "Agendar lead"}</button>
        </div>
      </form>
    </ModalDialog>
  );
}
