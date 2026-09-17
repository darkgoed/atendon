"use client";

import { ArrowLeft, ArrowsClockwise, MagicWand, PencilSimple, Star, UserSwitch, X } from "@phosphor-icons/react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { ContactAvatar } from "@/components/contact-avatar";
import { Shell } from "@/components/shell";
import { ApiError, api } from "@/lib/api";
import { fetchLead, fetchLeadFollowUp, updateLeadStatus, qualifyLeadContext,  addLeadNote, transferLead } from "@/lib/leads-api";
import { formatLeadStatusLabel } from "@/lib/format";
import { statusLabel } from "../lead-domain";
import { commercialPreparationAnswers } from "@/lib/labels";
import { lossReasonLabel, useLossReasons } from "@/lib/loss-reasons";
import { useRealtimeSignals } from "@/lib/realtime";
import {
  canLeaveCaseUnassigned,
  hasWorkspaceWideCaseScope,
  losesCaseAccessAfterTransfer,
  type PanelSession
} from "@/lib/session";
import { usePermission } from "@/lib/use-permission";

type LeadStatus = "novo" | "em_atendimento" | "aguardando_resposta" | "qualificado" | "agendado" | "em_negociacao" | "proposta_enviada" | "follow_up" | "fechado" | "perdido";

type Qualificacao = {
  estrelas: number;
  resumo: string | null;
  avaliado_em: string | null;
  requer_decisao_humana: boolean;
  respostas?: Record<string, string> | null;
  origem_facebook?: { source_type?: string; source_id?: string; source_url?: string; headline?: string; body?: string; ctwa_clid?: string };
};

type LeadDetailData = {
  lead: {
    nome?: string;
    telefone: string;
    avatar_url?: string | null;
    status: LeadStatus;
    unidade_nome?: string;
    categoria_nome?: string;
    parceiro_nome?: string;
    origem?: string;
    campanha?: string | null;
    sdr_email?: string | null;
    closer_email?: string | null;
    recovery_required?: boolean;
    recovery_email?: string | null;
    loss_reason?: string | null;
    loss_reason_note?: string | null;
  };
  qualificacao: Qualificacao | null;
  agendamentos: Array<{
    id: string;
    start: string;
    end: string;
    status: string;
    result_pending_at?: string | null;
    responsavel: {
      member_id: string;
      email: string | null;
      availability_status: "available" | "unavailable" | null;
    } | null;
  }>;
  status_permitidos: LeadStatus[];
  timezone: string;
};

type FollowUpData = {
  follow_up: {
    responsavel: {
      member_id: string;
      user_id: string;
      email: string;
      availability_status: "available" | "unavailable" | null;
    } | null;
    proxima_acao: string | null;
    proxima_acao_em: string | null;
    timezone: string;
  };
  notas: Array<{ id: string; nota: string; autor_user_id: string; autor_email: string; criado_em: string }>;
  responsaveis: Array<{
    member_id: string;
    user_id: string;
    email: string;
    funcao: string;
    availability_status: "available" | "unavailable";
  }>;
};

function localDateTimeInput(value: string | null, timezone: string) {
  if (!value) return "";
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(value)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export default function LeadDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const canUpdateStatus = usePermission("leads.update_status");
  const canTransfer = usePermission("leads.transfer");
  const canReadFollowUp = usePermission("leads.follow_up.read");
  const canManageFollowUp = usePermission("leads.follow_up.manage");
  const { reasons: lossReasons } = useLossReasons();
  const [data, setData] = useState<LeadDetailData>();
  const [followUpData, setFollowUpData] = useState<FollowUpData>();
  const [followUpLoading, setFollowUpLoading] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [qualifying, setQualifying] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [editingIdentity, setEditingIdentity] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [identityName, setIdentityName] = useState("");
  const [identityPhone, setIdentityPhone] = useState("");
  const [nextStatus, setNextStatus] = useState<LeadStatus | "">("");
  const [responsibleMemberId, setResponsibleMemberId] = useState("");
  const [nextAction, setNextAction] = useState("");
  const [nextActionLocal, setNextActionLocal] = useState("");
  const [note, setNote] = useState("");
  const [savingFollowUp, setSavingFollowUp] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const hadAccessRef = useRef(false);
  const accessEpochRef = useRef(0);
  const { data: session } = useSWR<PanelSession>("/me", (url: string) => api<PanelSession>(url), {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const hasWorkspaceScope = Boolean(session && hasWorkspaceWideCaseScope(session));

  const handleLoadError = useCallback((loadError: unknown, fallback: string) => {
    if (loadError instanceof ApiError && loadError.status === 404) {
      const lostExistingAccess = hadAccessRef.current;
      hadAccessRef.current = false;
      accessEpochRef.current += 1;
      setData(undefined);
      setFollowUpData(undefined);
      if (lostExistingAccess) {
        router.replace("/contatos?acesso=atualizado");
        return;
      }
    }
    setError(loadError instanceof Error ? loadError.message : fallback);
  }, [router]);

  const load = useCallback(async () => {
    const requestEpoch = accessEpochRef.current;
    try {
      const response = await fetchLead<LeadDetailData>(id);
      if (requestEpoch !== accessEpochRef.current) return;
      hadAccessRef.current = true;
      setData(response);
      setError("");
    } catch (loadError) {
      handleLoadError(loadError, "Falha ao carregar o lead");
    }
  }, [handleLoadError, id]);

  const loadFollowUp = useCallback(async () => {
    if (!canReadFollowUp) {
      setFollowUpData(undefined);
      return;
    }
    setFollowUpLoading(true);
    const requestEpoch = accessEpochRef.current;
    try {
      const response = await fetchLeadFollowUp<FollowUpData>(id);
      if (requestEpoch !== accessEpochRef.current) return;
      setFollowUpData(response);
    } catch (loadError) {
      handleLoadError(loadError, "Falha ao carregar o acompanhamento interno");
    } finally {
      setFollowUpLoading(false);
    }
  }, [canReadFollowUp, handleLoadError, id]);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(interval);
  }, [load]);

  useEffect(() => {
    void loadFollowUp();
    const interval = window.setInterval(() => void loadFollowUp(), 10_000);
    return () => window.clearInterval(interval);
  }, [loadFollowUp]);

  useRealtimeSignals({
    onCatchUp: () => {
      if (document.visibilityState !== "visible") return;
      void load();
      void loadFollowUp();
    },
    onSignal: (signal) => {
      if (
        document.visibilityState !== "visible"
        || (
          signal.type !== "conversation.messages.changed"
          && signal.type !== "case.assignment.changed"
          && signal.type !== "appointment.changed"
        )
      ) return;
      void load();
      void loadFollowUp();
    }
  });

  useEffect(() => {
    setNextStatus(data?.status_permitidos[0] ?? "");
  }, [data?.lead.status, data?.status_permitidos]);

  useEffect(() => {
    if (!followUpData) return;
    setResponsibleMemberId(followUpData.follow_up.responsavel?.member_id ?? "");
    setNextAction(followUpData.follow_up.proxima_acao ?? "");
    setNextActionLocal(localDateTimeInput(followUpData.follow_up.proxima_acao_em, followUpData.follow_up.timezone));
  }, [followUpData]);

  async function refreshAfterFollowUpMutation(successMessage: string) {
    const [leadResult, followUpResult] = await Promise.allSettled([
      fetchLead<LeadDetailData>(id),
      fetchLeadFollowUp<FollowUpData>(id)
    ]);
    if (leadResult.status === "fulfilled") setData(leadResult.value);
    if (followUpResult.status === "fulfilled") setFollowUpData(followUpResult.value);
    const accessWasRevoked = [leadResult, followUpResult].some((result) =>
      result.status === "rejected"
      && result.reason instanceof ApiError
      && result.reason.status === 404
    );
    if (accessWasRevoked) {
      handleLoadError(
        new ApiError("Lead não encontrado", 404),
        "Falha ao recarregar o acompanhamento"
      );
      return;
    }
    const reloadFailed = leadResult.status === "rejected" || followUpResult.status === "rejected";
    setFeedback(reloadFailed
      ? `${successMessage} A recarga completa falhou; os dados salvos já estão exibidos e você pode atualizar a página depois.`
      : successMessage);
  }

  async function updateStatus(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canUpdateStatus || !nextStatus) return;
    setSavingStatus(true);
    setError("");
    setFeedback("");
    try {
      await updateLeadStatus(id, nextStatus);
      await load();
      setFeedback(`Status atualizado para ${statusLabel(nextStatus)}.`);
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Falha ao atualizar o status");
    } finally {
      setSavingStatus(false);
    }
  }

  function beginIdentityEdit() {
    if (!data) return;
    setIdentityName(data.lead.nome ?? "");
    setIdentityPhone(data.lead.telefone);
    setEditingIdentity(true);
    setError("");
    setFeedback("");
  }

  async function saveIdentity(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canUpdateStatus || !data || savingIdentity) return;
    const nome = identityName.trim();
    const telefone = identityPhone.trim();
    if (!nome || telefone.replace(/\D/g, "").length < 8) {
      setError("Informe um nome e um telefone com ao menos 8 dígitos.");
      return;
    }
    setSavingIdentity(true);
    setError("");
    setFeedback("");
    try {
      await api(`/scheduling/leads/${id}/identity`, { method: "PATCH", body: JSON.stringify({ nome, telefone }) });
      await load();
      setEditingIdentity(false);
      setFeedback("Nome e telefone atualizados no lead e no contato vinculado.");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Falha ao atualizar nome e telefone");
    } finally {
      setSavingIdentity(false);
    }
  }

  async function qualifyFromConversation() {
    if (!canUpdateStatus || qualifying || data?.qualificacao) return;
    setQualifying(true);
    setError("");
    setFeedback("");
    try {
      const result = await qualifyLeadContext(id) as { mensagens_analisadas: number };
      await load();
      setFeedback(`Qualificação concluída pela IA com base em ${result.mensagens_analisadas} mensagem(ns) da conversa.`);
    } catch (qualificationError) {
      setError(qualificationError instanceof Error ? qualificationError.message : "Falha ao qualificar o lead com IA");
    } finally {
      setQualifying(false);
    }
  }

  async function saveFollowUp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageFollowUp || savingFollowUp) return;
    if (session && !canLeaveCaseUnassigned(session) && !responsibleMemberId) {
      setError("Operadores precisam transferir o lead para outro membro ativo do pool.");
      return;
    }
    const action = nextAction.trim();
    if (Boolean(action) !== Boolean(nextActionLocal)) {
      setError("Informe a próxima ação e a data juntas, ou deixe ambas vazias.");
      return;
    }
    setSavingFollowUp(true);
    setError("");
    setFeedback("");
    try {
      const previousMemberId = followUpData?.follow_up.responsavel?.member_id ?? null;
      const targetUserId = responsibleMemberId
        ? followUpData?.responsaveis.find((item) => item.member_id === responsibleMemberId)?.user_id
          ?? (followUpData?.follow_up.responsavel?.member_id === responsibleMemberId
            ? followUpData.follow_up.responsavel.user_id
            : null)
        : null;
      const losesAccess = Boolean(
        session
        && previousMemberId !== responsibleMemberId
        && losesCaseAccessAfterTransfer(session, targetUserId)
      );
      const persisted = await api<{ follow_up: FollowUpData["follow_up"]; alterado: boolean }>(`/scheduling/leads/${id}/follow-up`, {
        method: "PATCH",
        body: JSON.stringify({
          responsavel_member_id: responsibleMemberId || null,
          proxima_acao: action || null,
          proxima_acao_em_local: nextActionLocal || null
        })
      });
      if (losesAccess) {
        hadAccessRef.current = false;
        accessEpochRef.current += 1;
        setData(undefined);
        setFollowUpData(undefined);
        router.replace("/contatos?acesso=atualizado");
        return;
      }
      setFeedback("Acompanhamento interno atualizado.");
      setFollowUpData((current) => current ? { ...current, follow_up: persisted.follow_up } : current);
      await refreshAfterFollowUpMutation("Acompanhamento interno atualizado.");
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "Falha ao atualizar o acompanhamento");
    } finally {
      setSavingFollowUp(false);
    }
  }

  async function addNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = note.trim();
    if (!canManageFollowUp || !content || addingNote) return;
    setAddingNote(true);
    setError("");
    setFeedback("");
    try {
      const persisted = await addLeadNote(id, content) as { nota: FollowUpData["notas"][number] };
      setNote("");
      setFeedback("Nota interna adicionada.");
      setFollowUpData((current) => current ? { ...current, notas: [persisted.nota, ...current.notas] } : current);
      await refreshAfterFollowUpMutation("Nota interna adicionada.");
    } catch (noteError) {
      setError(noteError instanceof Error ? noteError.message : "Falha ao adicionar a nota interna");
    } finally {
      setAddingNote(false);
    }
  }

  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canTransfer) return;
    const form = event.currentTarget;
    const motivo = String(new FormData(form).get("motivo") ?? "").trim();
    if (!motivo) return;
    setSending(true);
    setError("");
    setFeedback("");
    try {
      await transferLead(id, motivo);
      form.reset();
      await load();
      setFeedback("Lead transferido para atendimento humano.");
    } catch (transferError) {
      setError(transferError instanceof Error ? transferError.message : "Falha ao transferir");
    } finally {
      setSending(false);
    }
  }

  const responsibleOptions = followUpData ? [...followUpData.responsaveis] : [];
  if (followUpData?.follow_up.responsavel && !responsibleOptions.some((item) => item.member_id === followUpData.follow_up.responsavel?.member_id)) {
    responsibleOptions.push({
      ...followUpData.follow_up.responsavel,
      funcao: "Fora do pool",
      availability_status: followUpData.follow_up.responsavel.availability_status ?? "unavailable"
    });
  }
  const pendingResults = (data?.agendamentos ?? []).filter((item) => item.result_pending_at).length;

  return (
    <Shell>
      <div className="lead-detail-page">
      <Link href="/contatos" className="lead-detail-page__back inline-flex items-center gap-2 text-xs text-[var(--text-secondary)]">
        <ArrowLeft aria-hidden="true" />
        Voltar aos contatos
      </Link>
      {error ? <p className="error mb-4" role="alert">{error}</p> : null}
      {feedback ? <p className="accent mb-4" role="status" aria-live="polite">{feedback}</p> : null}
      {!data && !error ? (
        <div className="skeleton h-96" role="status" aria-label="Carregando detalhes do lead" />
      ) : data ? (
        <>
          <header className="lead-detail-page__header">
            <div className="flex min-w-0 flex-1 items-center gap-4">
              <ContactAvatar name={data.lead.nome ?? data.lead.telefone} src={data.lead.avatar_url} className="h-10 w-10 text-sm" />
              {editingIdentity ? (
                <form className="crm-detail-form" onSubmit={saveIdentity}>
                  <label className="field">
                    <span className="sr-only">Nome do contato</span>
                    <input className="input" value={identityName} onChange={(event) => setIdentityName(event.target.value)} maxLength={200} required aria-label="Nome do contato" />
                  </label>
                  <label className="field">
                    <span className="sr-only">Telefone do contato</span>
                    <input className="input mono" type="tel" value={identityPhone} onChange={(event) => setIdentityPhone(event.target.value)} maxLength={50} required aria-label="Telefone do contato" />
                  </label>
                  <div className="flex gap-2">
                    <button className="btn primary" disabled={savingIdentity}>{savingIdentity ? "Salvando…" : "Salvar"}</button>
                    <button type="button" className="btn px-2.5" onClick={() => setEditingIdentity(false)} disabled={savingIdentity} aria-label="Cancelar edição"><X size={16} aria-hidden="true" /></button>
                  </div>
                </form>
              ) : (
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0">
                    <h1 className="truncate">{data.lead.nome ?? "Lead sem nome"}</h1>
                    <p className="mono truncate">{data.lead.telefone} · {statusLabel(data.lead.status)}</p>
                    {pendingResults ? <span className="crm-notice mt-2">{pendingResults} resultado(s) pendente(s)</span> : null}
                  </div>
                  {canUpdateStatus ? <button type="button" className="mt-0.5 shrink-0 text-[var(--text-secondary)] transition-colors hover:text-[var(--text)]" onClick={beginIdentityEdit} aria-label="Editar nome e telefone"><PencilSimple size={17} aria-hidden="true" /></button> : null}
                </div>
              )}
            </div>
            {canUpdateStatus && !data.qualificacao && !editingIdentity ? (
              <button type="button" className="btn primary" onClick={qualifyFromConversation} disabled={qualifying}>
                <MagicWand size={17} aria-hidden="true" />
                {qualifying ? "Analisando conversa…" : "Qualificar com IA"}
              </button>
            ) : null}
          </header>
          <div className="lead-detail-layout">
            <div className="lead-detail-main">
              {data.qualificacao ? (
                <section className="card" aria-labelledby="qualification-title">
                  <div className="flex flex-wrap items-center justify-between gap-3"><div id="qualification-title" className="cardtitle">Qualificação contextual</div><strong className="flex items-center gap-1.5 text-lg text-[var(--primary-text)]"><Star size={18} weight="fill" aria-hidden="true" />{data.qualificacao.estrelas} de 5</strong></div>
                  <dl className="mb-4 grid gap-3 text-sm md:grid-cols-2">
                    <Item label="Situação" value={data.qualificacao.requer_decisao_humana ? "Requer decisão humana" : "Oportunidade qualificada"} />
                    <Item label="Avaliado em" value={data.qualificacao.avaliado_em ? new Date(data.qualificacao.avaliado_em).toLocaleString("pt-BR", { timeZone: data.timezone }) : undefined} />
                    <Item label="Campanha/anúncio" value={data.qualificacao.origem_facebook?.headline ?? data.qualificacao.origem_facebook?.source_id} />
                    <Item label="Origem" value={data.qualificacao.origem_facebook?.source_type ? `Facebook · ${data.qualificacao.origem_facebook.source_type}` : "Facebook/WhatsApp"} />
                  </dl>
                  {commercialPreparationAnswers(data.qualificacao.respostas).length ? (
                    <dl className="mb-4 grid gap-3 text-sm md:grid-cols-2">
                      {commercialPreparationAnswers(data.qualificacao.respostas).map((item) => <Item key={item.key} label={item.label} value={item.value} />)}
                    </dl>
                  ) : null}
                  <div className="rounded border border-[var(--border)] p-4"><strong className="mb-2 block text-xs">Resumo</strong><p className="whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{data.qualificacao.resumo ?? "—"}</p></div>
                </section>
              ) : (
                <section className="card" aria-labelledby="qualification-title">
                  <div id="qualification-title" className="cardtitle">Qualificação contextual</div>
                  <p className="sub">Este contato ainda não foi qualificado. Use “Qualificar com IA” para analisar o histórico completo da conversa.</p>
                </section>
              )}
              {canReadFollowUp ? (
                <section className="card" aria-labelledby="internal-notes-title">
                  <div id="internal-notes-title" className="cardtitle">Notas internas</div>
                  <p className="sub mb-4">Visíveis apenas para membros autorizados do workspace.</p>
                  {canManageFollowUp ? (
                    <form className="mb-5 border-b border-[var(--border)] pb-5" onSubmit={addNote}>
                      <label className="field">
                        <span className="label">Nova nota</span>
                        <textarea className="input min-h-24 resize-y" value={note} onChange={(event) => setNote(event.target.value)} maxLength={4000} required placeholder="Registre contexto útil para o próximo atendimento" />
                      </label>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <span className="crm-caption">{note.length}/4000</span>
                        <button className="btn primary" disabled={addingNote || !note.trim()}>{addingNote ? "Adicionando…" : "Adicionar nota"}</button>
                      </div>
                    </form>
                  ) : null}
                  {followUpLoading && !followUpData ? <div className="skeleton h-20" aria-label="Carregando notas internas" /> : null}
                  {followUpData?.notas.length === 0 ? <p className="sub" role="status">Nenhuma nota interna registrada.</p> : null}
                  {followUpData?.notas.length ? (
                    <div className="grid gap-3">
                      {followUpData.notas.map((item) => (
                        <article key={item.id} className="rounded border border-[var(--border)] p-4">
                          <p className="whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{item.nota}</p>
                          <footer className="crm-detail-note__footer">
                            <span>{item.autor_email}</span>
                            <time className="mono">{new Date(item.criado_em).toLocaleString("pt-BR", { timeZone: followUpData.follow_up.timezone })}</time>
                          </footer>
                        </article>
                      ))}
                    </div>
                  ) : null}
                </section>
              ) : null}
            </div>
            <aside className="lead-detail-aside">
              <section className="card">
                <div className="cardtitle">Dados</div>
                <dl className="grid gap-3 text-sm">
                  <Item label="Unidade" value={data.lead.unidade_nome} />
                  <Item label="Categoria" value={data.lead.categoria_nome} />
                  <Item label="Parceiro" value={data.lead.parceiro_nome} />
                  <Item label="Origem" value={data.lead.origem} />
                  <Item label="Campanha" value={data.lead.campanha ?? undefined} />
                  <Item label="SDR" value={data.lead.sdr_email ?? "Não atribuído"} />
                  <Item label="Closer" value={data.lead.closer_email ?? "Não atribuído"} />
                  {data.lead.recovery_required ? <Item label="Recuperação" value={data.lead.recovery_email ?? "Responsável pendente"} /> : null}
                  {data.lead.loss_reason ? <Item label="Motivo da desqualificação" value={lossReasonLabel(lossReasons, data.lead.loss_reason)} /> : null}
                  {data.lead.loss_reason_note ? <Item label="Observação" value={data.lead.loss_reason_note} /> : null}
                </dl>
              </section>
              {canReadFollowUp ? (
                <section className="card" aria-labelledby="follow-up-title">
                  <div id="follow-up-title" className="cardtitle">Próximo acompanhamento</div>
                  {followUpLoading && !followUpData ? <div className="skeleton h-28" aria-label="Carregando acompanhamento" /> : null}
                  {followUpData ? (
                    <>
                      <dl className="mb-4 grid gap-3 text-sm">
                        <Item
                          label="Responsável"
                          value={followUpData.follow_up.responsavel
                            ? `${followUpData.follow_up.responsavel.email} · ${followUpData.follow_up.responsavel.availability_status === "available" ? "disponível" : followUpData.follow_up.responsavel.availability_status === "unavailable" ? "indisponível" : "fora do pool"}`
                            : "Não atribuído"}
                        />
                        <Item label="Próxima ação" value={followUpData.follow_up.proxima_acao ?? "Nenhuma ação definida"} />
                        <Item
                          label="Data"
                          value={followUpData.follow_up.proxima_acao_em
                            ? new Date(followUpData.follow_up.proxima_acao_em).toLocaleString("pt-BR", { timeZone: followUpData.follow_up.timezone })
                            : "Nenhuma data definida"}
                        />
                      </dl>
                      <p className="crm-detail-timezone">Fuso: {followUpData.follow_up.timezone}</p>
                      {canManageFollowUp ? (
                        <form className="grid gap-3 border-t border-[var(--border)] pt-4" onSubmit={saveFollowUp}>
                          <label className="field">
                            <span className="label">Responsável</span>
                            <select className="input" value={responsibleMemberId} onChange={(event) => setResponsibleMemberId(event.target.value)}>
                              {hasWorkspaceScope ? <option value="">Não atribuído</option> : null}
                              {responsibleOptions.map((item) => <option key={item.member_id} value={item.member_id}>{item.email} · {item.funcao} · {item.availability_status === "available" ? "disponível" : "indisponível"}</option>)}
                            </select>
                          </label>
                          <label className="field">
                            <span className="label">Próxima ação</span>
                            <textarea className="input min-h-20 resize-y" value={nextAction} onChange={(event) => setNextAction(event.target.value)} maxLength={500} placeholder="Ex.: retornar com a proposta" />
                          </label>
                          <label className="field">
                            <span className="label">Data e hora</span>
                            <input className="input" type="datetime-local" value={nextActionLocal} onChange={(event) => setNextActionLocal(event.target.value)} />
                          </label>
                          <p className="sub">
                            A ação e a data devem ser preenchidas ou removidas juntas.
                            {!hasWorkspaceScope ? " Ao transferir, escolha outro membro ativo do pool; o atendimento não pode ficar sem responsável." : ""}
                          </p>
                          <button className="btn primary w-full" disabled={savingFollowUp || (!hasWorkspaceScope && !responsibleMemberId)}>{savingFollowUp ? "Salvando…" : "Salvar acompanhamento"}</button>
                        </form>
                      ) : <p className="sub">Acesso somente leitura ao acompanhamento.</p>}
                    </>
                  ) : null}
                </section>
              ) : null}
              {canUpdateStatus ? (
                <form className="card" onSubmit={updateStatus}>
                  <div className="cardtitle">
                    <span className="flex items-center gap-2"><ArrowsClockwise />Atualizar status</span>
                  </div>
                  <p className="sub mb-3">Atual: {statusLabel(data.lead.status)}</p>
                  {data.status_permitidos.length ? (
                    <>
                      <label className="field">
                        <span className="label">Próximo status</span>
                        <select className="input" value={nextStatus} onChange={(event) => setNextStatus(event.target.value as LeadStatus)}>
                          {data.status_permitidos.map((status) => <option key={status} value={status}>{statusLabel(status)}</option>)}
                        </select>
                      </label>
                      <button disabled={savingStatus || !nextStatus} className="btn primary mt-3 w-full">
                        {savingStatus ? "Atualizando…" : "Atualizar status"}
                      </button>
                    </>
                  ) : (
                    <p className="sub">Não há transições manuais disponíveis para este status.</p>
                  )}
                </form>
              ) : null}
              {canTransfer ? (
                <form className="card" onSubmit={transfer}>
                  <div className="cardtitle">
                    <span className="flex items-center gap-2"><UserSwitch />Transferir para humano</span>
                  </div>
                  <label className="field">
                    <span className="label">Motivo</span>
                    <textarea name="motivo" className="input min-h-24 resize-y" required placeholder="Contexto para o atendente responsável" />
                  </label>
                  <button disabled={sending} className="btn warn mt-3 w-full">{sending ? "Transferindo…" : "Transferir manualmente"}</button>
                </form>
              ) : (
                <section className="card" aria-label="Transferência para atendimento humano">
                  <div className="cardtitle">
                    <span className="flex items-center gap-2"><UserSwitch />Transferir para humano</span>
                  </div>
                  <p className="sub" role="status">Acesso somente leitura. Você não tem permissão para transferir este lead.</p>
                </section>
              )}
              {data.agendamentos.length ? (
                <section className="card">
                  <div className="cardtitle">Agendamentos</div>
                  {data.agendamentos.map((item) => (
                    <div key={item.id} className="crm-appointment">
                      <strong>{new Date(item.start).toLocaleString("pt-BR", { timeZone: data.timezone })}</strong>
                      <span>{formatLeadStatusLabel(item.status)}</span>
                      {item.result_pending_at ? <span className="crm-appointment__pending">Resultado pendente</span> : null}
                      <span>
                        {item.responsavel?.email
                          ? `${item.responsavel.email} · ${item.responsavel.availability_status === "available" ? "disponível" : item.responsavel.availability_status === "unavailable" ? "indisponível" : "fora do pool"}`
                          : "Sem atendente"}
                      </span>
                    </div>
                  ))}
                </section>
              ) : null}
            </aside>
          </div>
        </>
      ) : null}
      </div>
    </Shell>
  );
}

function Item({ label, value }: { label: string; value?: string }) {
  return <div><dt className="label">{label}</dt><dd className="mt-1 text-[var(--text-secondary)]">{value ?? "—"}</dd></div>;
}
