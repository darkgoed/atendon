import { ArrowClockwise, CalendarDots, Check, DownloadSimple, FileVideo, Trash, UserMinus, VideoCamera, WhatsappLogo, X } from "@phosphor-icons/react";
import useSWR from "swr";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";
import { apiContentUrl, formatRecordingDate, formatRecordingSize, recordingCanPlay, type MeetRecordingsResponse } from "@/lib/meet";
import { isAppointmentResultPending } from "./agenda-appointment-state";
import { AppointmentCancellationForm, AppointmentOutcomeForm } from "./appointment-final-actions";
import { APPOINTMENT_STATUS_LABELS, formatSlot, isActiveAppointment } from "./agenda-utils";
import type { AgendaActions } from "./use-agenda-actions";

export function AgendaDetailDialog({ actions, timezone, now }: { actions: AgendaActions; timezone: string; now: number }) {
  const {
    selectedAppointment, closeAppointment, savingObservation, savingAssignee, pendingActionId,
    reschedulingId, openingConversationId, joiningAppointmentId, deletingLead, detailAssigneesData,
    detailAssignedMemberId, setDetailAssignedMemberId, detailAssigneesLoading, detailAssigneesError,
    saveAppointmentAssignee, actionError, finalAction, setFinalAction, setActionError, confirmDeleteLead,
    setConfirmDeleteLead, deleteLeadAction, runFinalAction, rescheduleTarget, setRescheduleTarget,
    submitReschedule, selectedStart, setSelectedStart, selectedEnd, setSelectedEnd
  } = actions;
  if (!selectedAppointment) return null;

  const busy = savingObservation || savingAssignee || Boolean(pendingActionId || reschedulingId || openingConversationId || joiningAppointmentId || deletingLead);
  return (
    <ModalDialog className="agenda-detail-dialog" labelledBy="agenda-detail-title" describedBy="agenda-detail-description" onClose={closeAppointment}>
      <header className="agenda-detail-header flex items-start justify-between gap-4">
        <div className="min-w-0">
          <span className="label">Detalhes da reunião</span>
          <h2 id="agenda-detail-title" className="mt-1 truncate">{selectedAppointment.lead_nome ?? selectedAppointment.lead_telefone}</h2>
          <p id="agenda-detail-description" className="mono mt-1 text-sm text-[var(--text-secondary)]">{formatSlot({ start: selectedAppointment.start, end: selectedAppointment.end, vagas: 1, capacidade: 1 }, timezone)}</p>
        </div>
        <button type="button" className="btn shrink-0 p-2 active:scale-[.98]" aria-label="Fechar detalhes" disabled={busy} onClick={closeAppointment}><X size={16} aria-hidden="true" /></button>
      </header>

      <dl className="agenda-detail-fields">
        <div><dt>Lead</dt><dd className="mono">{selectedAppointment.lead_telefone}</dd></div>
        <div><dt>Tipo</dt><dd>Reunião comercial</dd></div>
        <div><dt>Canal</dt><dd>{selectedAppointment.meeting_provider === "google_meet" ? "Google Meet" : selectedAppointment.meeting_provider === "atendon_meet" ? "AtendON Meet" : "Não informado"}</dd></div>
      </dl>

      <div className="agenda-detail-summary">
        <div><span className="label">Status</span><strong>{isAppointmentResultPending(selectedAppointment, now) ? "Resultado pendente" : APPOINTMENT_STATUS_LABELS[selectedAppointment.status]}</strong>{isAppointmentResultPending(selectedAppointment, now) ? <small className="mt-1 block text-[var(--warning-text)]">O horário terminou sem um desfecho registrado.</small> : null}</div>
        <div>
          <span className="label">Closer / responsável</span>
          {detailAssigneesData?.can_select_assignee && isActiveAppointment(selectedAppointment.status) ? (
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
              <select className="input min-w-0 flex-1" value={detailAssignedMemberId} disabled={savingAssignee || detailAssigneesLoading} onChange={(event) => setDetailAssignedMemberId(event.target.value)} aria-label="Responsável do lead">
                {!detailAssignedMemberId ? <option value="">Sem responsável disponível</option> : null}
                {detailAssigneesData.assignees.map((assignee) => <option key={assignee.member_id} value={assignee.member_id} disabled={!assignee.selectable && assignee.member_id !== selectedAppointment.responsavel?.member_id}>{assignee.name || assignee.email}{assignee.selectable ? "" : " · indisponível"}</option>)}
              </select>
              <button type="button" className="btn primary" disabled={savingAssignee || detailAssigneesLoading || !detailAssignedMemberId || detailAssignedMemberId === (selectedAppointment.responsavel?.member_id ?? "")} onClick={() => void saveAppointmentAssignee()}>{savingAssignee ? "Salvando…" : "Salvar responsável"}</button>
            </div>
          ) : <strong>{selectedAppointment.responsavel?.email ?? "Sem responsável"}</strong>}
          {detailAssigneesError ? <small className="mt-1 block text-[var(--warning-text)]">Não foi possível carregar os responsáveis.</small> : null}
        </div>
      </div>

      {detailAssigneesData?.assignees.length ? (
        <section className="agenda-team-capacity" aria-labelledby="agenda-team-capacity-title">
          <div className="agenda-team-capacity__heading">
            <span id="agenda-team-capacity-title" className="label">Capacidade da equipe</span>
            <span className="mono">carga futura</span>
          </div>
          <div className="agenda-team-capacity__list">
            {detailAssigneesData.assignees.map((assignee) => {
              const load = assignee.future_meetings_count;
              const level = !assignee.selectable || load >= 5 ? "danger" : load >= 3 ? "warn" : "ok";
              const name = assignee.name?.trim() || assignee.email;
              return (
                <div key={assignee.member_id} className="agenda-team-capacity__member">
                  <div className="agenda-team-capacity__meta">
                    <span className="agenda-team-capacity__avatar" aria-hidden="true">{name.slice(0, 2).toUpperCase()}</span>
                    <strong title={name}>{name}</strong>
                    <span className={`mono is-${level}`}>{load} reun.</span>
                  </div>
                  <span className={`agenda-team-capacity__track is-${level}`}><i style={{ width: `${Math.min(load * 20, 100)}%` }} /></span>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {actionError && !finalAction ? <p className="error" role="alert">{actionError}</p> : null}
      {confirmDeleteLead ? (
        <section className="grid gap-4 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-5" aria-labelledby="agenda-delete-lead-title">
          <div><span className="label">Confirmar exclusão</span><strong id="agenda-delete-lead-title" className="mt-1 block text-sm">Excluir agendamento</strong><p className="mt-1 text-sm text-[var(--warning-text)]">Esta ação remove apenas o agendamento da agenda. O lead, conversas e todo o histórico serão mantidos. Não pode ser desfeita.</p></div>
          <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn" disabled={deletingLead} onClick={() => setConfirmDeleteLead(false)}>Voltar</button><button type="button" className="btn warn active:scale-[.98]" disabled={deletingLead} onClick={() => void deleteLeadAction()}>{deletingLead ? "Excluindo…" : "Excluir agendamento"}</button></div>
        </section>
      ) : finalAction?.appointment.id === selectedAppointment.id ? (
        finalAction.action === "complete" ? <AppointmentOutcomeForm key={`${selectedAppointment.id}-outcome`} timezone={timezone} submitting={Boolean(pendingActionId)} serverError={actionError} onBack={() => { setFinalAction(null); setActionError(""); }} onClearError={() => setActionError("")} onSubmit={runFinalAction} />
          : finalAction.action === "cancel" ? <AppointmentCancellationForm key={`${selectedAppointment.id}-cancellation`} timezone={timezone} submitting={Boolean(pendingActionId)} serverError={actionError} onBack={() => { setFinalAction(null); setActionError(""); }} onClearError={() => setActionError("")} onSubmit={runFinalAction} />
            : <NoShowConfirmation actions={actions} />
      ) : rescheduleTarget?.id === selectedAppointment.id ? (
        <form className="grid gap-5 border-y border-[var(--border)] py-5" aria-labelledby="agenda-reschedule-title" onSubmit={submitReschedule}>
          <div><span className="label">Reagendar</span><strong id="agenda-reschedule-title" className="mt-1 block text-sm">Defina início e término</strong><p className="sub mt-1 text-xs">O horário pode ser informado em qualquer minuto e compartilhado por mais de um lead.</p></div>
          <div className="grid gap-4 sm:grid-cols-2"><label className="field"><span className="label">Início</span><input data-autofocus className="input" type="datetime-local" value={selectedStart} disabled={Boolean(reschedulingId)} onChange={(event) => setSelectedStart(event.target.value)} required /></label><label className="field"><span className="label">Término</span><input className="input" type="datetime-local" value={selectedEnd} disabled={Boolean(reschedulingId)} onChange={(event) => setSelectedEnd(event.target.value)} required /></label></div>
          <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn" disabled={Boolean(reschedulingId)} onClick={() => { setRescheduleTarget(null); setActionError(""); }}>Voltar</button><button type="submit" className="btn primary active:scale-[.98]" disabled={!selectedStart || !selectedEnd || Boolean(reschedulingId)}>{reschedulingId ? "Reagendando…" : "Confirmar novo horário"}</button></div>
        </form>
      ) : <AppointmentDetails actions={actions} timezone={timezone} />}
    </ModalDialog>
  );
}

function NoShowConfirmation({ actions }: { actions: AgendaActions }) {
  const { actionError, pendingActionId, setFinalAction, setActionError, runFinalAction } = actions;
  return (
    <section className="grid gap-4 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-5" aria-labelledby="agenda-final-action-title">
      <div><span className="label">Confirmar ação</span><strong id="agenda-final-action-title" className="mt-1 block text-sm">Registrar não comparecimento</strong><p className="mt-1 text-sm text-[var(--warning-text)]">Ao confirmar, uma ação de recuperação será criada para retomar este contato.</p></div>
      {actionError ? <p className="error" role="alert">{actionError}</p> : null}
      <div className="flex flex-wrap justify-end gap-2"><button type="button" className="btn" disabled={Boolean(pendingActionId)} onClick={() => { setFinalAction(null); setActionError(""); }}>Voltar</button><button type="button" className="btn warn active:scale-[.98]" disabled={Boolean(pendingActionId)} onClick={() => void runFinalAction()}>{pendingActionId ? "Salvando…" : "Marcar não comparecimento"}</button></div>
    </section>
  );
}

function AppointmentDetails({ actions, timezone }: { actions: AgendaActions; timezone: string }) {
  const { permissions, selectedAppointment, openingConversationId, openConversation, joiningAppointmentId, joinBlockedIds, joinReadyUrl, joinAppointment, beginReschedule, beginFinalAction, setConfirmDeleteLead, appointmentObservation, setAppointmentObservation, savingObservation, saveObservation } = actions;
  if (!selectedAppointment) return null;
  return (
    <>
      <div className="agenda-detail-actions flex flex-wrap gap-2" role="group" aria-label={`Ações para ${selectedAppointment.lead_nome ?? selectedAppointment.lead_telefone}`}>
        {permissions.canReply ? <button type="button" className="btn active:scale-[.98]" disabled={openingConversationId === selectedAppointment.id} onClick={() => void openConversation(selectedAppointment)}><WhatsappLogo size={15} aria-hidden="true" />{openingConversationId === selectedAppointment.id ? "Iniciando conversa…" : selectedAppointment.conversation_id ? "Abrir conversa" : "Iniciar conversa"}</button> : null}
        {selectedAppointment.meet_link ? (
          <button type="button" className="btn active:scale-[.98]" disabled={joiningAppointmentId === selectedAppointment.id || joinBlockedIds.has(selectedAppointment.id)} onClick={() => { if (joinReadyUrl) window.open(joinReadyUrl, "_blank", "noopener,noreferrer"); else void joinAppointment(selectedAppointment); }}>
            <VideoCamera size={15} aria-hidden="true" />{joiningAppointmentId === selectedAppointment.id ? "Verificando reunião…" : joinBlockedIds.has(selectedAppointment.id) ? "Sala indisponível" : joinReadyUrl ? "Abrir Meet liberado" : "Entrar no Meet"}
          </button>
        ) : null}
        {(isActiveAppointment(selectedAppointment.status) || selectedAppointment.status === "concluido" || selectedAppointment.status === "no_show") && permissions.canReschedule ? <button type="button" className="btn active:scale-[.98]" onClick={() => beginReschedule(selectedAppointment)}><CalendarDots size={15} aria-hidden="true" /> Reagendar</button> : null}
        {isActiveAppointment(selectedAppointment.status) && permissions.canComplete ? <button type="button" className="btn primary active:scale-[.98]" onClick={() => beginFinalAction(selectedAppointment, "complete")}><Check size={15} aria-hidden="true" /> Concluir</button> : null}
        {isActiveAppointment(selectedAppointment.status) && permissions.canNoShow ? <button type="button" className="btn warn active:scale-[.98]" onClick={() => beginFinalAction(selectedAppointment, "no_show")}><UserMinus size={15} aria-hidden="true" /> Não compareceu</button> : null}
        {selectedAppointment.status === "concluido" && permissions.canNoShow ? <button type="button" className="btn warn active:scale-[.98]" onClick={() => beginFinalAction(selectedAppointment, "no_show")}><UserMinus size={15} aria-hidden="true" /> Corrigir para não compareceu</button> : null}
        {selectedAppointment.status === "no_show" && permissions.canComplete ? <button type="button" className="btn primary active:scale-[.98]" onClick={() => beginFinalAction(selectedAppointment, "complete")}><Check size={15} aria-hidden="true" /> Corrigir para compareceu</button> : null}
        {isActiveAppointment(selectedAppointment.status) && permissions.canCancel ? <button type="button" className="btn warn active:scale-[.98]" onClick={() => beginFinalAction(selectedAppointment, "cancel")}><X size={15} aria-hidden="true" /> Cancelar</button> : null}
        {permissions.canDeleteLead ? <button type="button" className="btn warn active:scale-[.98]" aria-label={`Excluir agendamento de ${selectedAppointment.lead_nome ?? selectedAppointment.lead_telefone}`} title="Excluir agendamento" onClick={() => setConfirmDeleteLead(true)}><Trash size={15} aria-hidden="true" /> Excluir agendamento</button> : null}
      </div>
      <label className="field border-t border-[var(--border)] pt-5"><span className="label">Observação</span><textarea className="input min-h-28 resize-y" value={appointmentObservation} maxLength={4000} readOnly={!permissions.canManageNotes} onChange={(event) => setAppointmentObservation(event.target.value)} placeholder="Registre contexto importante para quem fará a reunião." /><small className="sub flex justify-between gap-3"><span>{permissions.canManageNotes ? "Visível para a equipe com acesso à agenda." : "Você possui acesso somente para leitura."}</span><span className="mono">{appointmentObservation.length}/4000</span></small></label>
      {permissions.canManageNotes ? <div className="flex justify-end"><button type="button" className="btn primary active:scale-[.98]" disabled={savingObservation || appointmentObservation === (selectedAppointment.observacao ?? "")} onClick={() => void saveObservation()}>{savingObservation ? "Salvando…" : "Salvar observação"}</button></div> : null}
      {selectedAppointment.meeting_provider === "atendon_meet" ? <AppointmentRecordings appointmentId={selectedAppointment.id} timezone={timezone} /> : null}
    </>
  );
}

function AppointmentRecordings({ appointmentId, timezone }: { appointmentId: string; timezone: string }) {
  const endpoint = `/meet/recordings?appointment_id=${encodeURIComponent(appointmentId)}`;
  const { data, error, isLoading, mutate } = useSWR<MeetRecordingsResponse>(endpoint, (url: string) => api<MeetRecordingsResponse>(url), {
    revalidateOnFocus: false,
    shouldRetryOnError: false
  });
  const recordings = data?.recordings ?? [];
  return (
    <section className="border-t border-[var(--border)] pt-5" aria-labelledby={`appointment-recordings-${appointmentId}`}>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <span className="label">Mídia da reunião</span>
          <h3 id={`appointment-recordings-${appointmentId}`} className="mt-1 text-sm font-semibold text-[var(--text)]">Gravações</h3>
        </div>
        {!isLoading && !error ? <span className="mono type-caption text-[var(--text-muted)]">{recordings.length} arquivo(s)</span> : null}
      </div>

      {isLoading ? (
        <div className="mt-4 grid gap-2" aria-busy="true" aria-label="Carregando gravações">
          <div className="skeleton h-16" />
          <div className="skeleton h-16" />
        </div>
      ) : error ? (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-3 py-4" role="alert">
          <p className="m-0 text-xs text-[var(--warning-text)]">{error instanceof Error ? error.message : "Não foi possível carregar as gravações."}</p>
          <button type="button" className="btn warn px-2 py-1 text-xs active:translate-y-px inline-flex items-center gap-1.5" onClick={() => void mutate()}><ArrowClockwise size={14} aria-hidden="true" />Tentar novamente</button>
        </div>
      ) : recordings.length === 0 ? (
        <div className="mt-4 grid grid-cols-[34px_minmax(0,1fr)] gap-3 border-y border-dashed border-[var(--border)] py-4 text-[var(--text-muted)]">
          <FileVideo size={24} aria-hidden="true" />
          <div><strong className="block text-xs text-[var(--text-secondary)]">Nenhuma gravação disponível</strong><p className="sub m-0 mt-1 text-xs">Depois que uma gravação for encerrada e processada, ela aparecerá aqui.</p></div>
        </div>
      ) : (
        <div className="mt-4 grid gap-4">
          {recordings.map((recording, index) => {
            const fileUrl = apiContentUrl(`/meet/recordings/${encodeURIComponent(recording.id)}/file`);
            const recordedAt = recording.started_at ?? recording.created_at;
            const playable = recordingCanPlay(recording.status);
            return (
              <article key={recording.id} className="grid gap-3 border-t border-[var(--border)] pt-4 first:border-t-0 first:pt-0">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
                  <div className="grid min-w-0 grid-cols-[30px_minmax(0,1fr)] items-center gap-3">
                    <span className="grid size-8 place-items-center rounded-full border border-[var(--border)] text-[var(--primary-text)]"><FileVideo size={16} aria-hidden="true" /></span>
                    <div className="min-w-0"><strong className="block truncate text-xs">{recording.file_name || `Gravação ${index + 1}`}</strong><span className="mono mt-1 block type-caption text-[var(--text-muted)]">{formatRecordingDate(recordedAt, timezone)} · {formatRecordingSize(recording.size_bytes)}</span></div>
                  </div>
                  {playable ? <a className="btn px-2 py-1 text-xs active:translate-y-px" href={fileUrl} download={recording.file_name || undefined}><DownloadSimple size={14} aria-hidden="true" />Baixar</a> : <span className="mono type-caption uppercase text-[var(--warning-text)]">{recording.status}</span>}
                </div>
                {playable ? <video className="block max-h-64 w-full border border-[var(--border)] bg-[var(--surface-elevated)]" controls preload="metadata" crossOrigin="use-credentials" src={fileUrl}>Seu navegador não consegue reproduzir esta gravação.</video> : <p className="sub m-0 text-xs">A gravação ainda está sendo processada.</p>}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
