"use client";

import { AirplaneTilt, ArrowClockwise, Plus, Sparkle, Trash, WarningCircle, X } from "@phosphor-icons/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { ModalDialog } from "../modal-dialog";
import {
  createTripzConversation,
  deleteTripzConversation,
  fetchTripzDocumentHtml,
  generateTripzPdf,
  generateTripzPreview,
  getTripzConversation,
  getTripzProposal,
  listTripzConversations,
  renameTripzConversation,
  retryTripzMessage,
  selectLatestTripzProposal,
  type TripzConversation,
  type TripzConversationList,
  type TripzDocument
} from "../../lib/tripz-ai";
import { TripzConversationView } from "./conversation-view";
import { TripzHistorySidebar } from "./history-sidebar";
import styles from "./tripz-ai.module.css";
import { TripzProposalReview } from "./proposal-review";

function readableError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function WorkspaceEmpty({ creating, onCreate, onOpenHistory }: { creating: boolean; onCreate: () => void; onOpenHistory: (event: React.MouseEvent<HTMLElement>) => void }) {
  return (
    <section className="relative grid min-h-0 min-w-0 place-items-center overflow-y-auto bg-[var(--bg)] px-5 py-12" aria-label="Tripz IA sem proposta selecionada">
      <button type="button" className="absolute left-3 top-3 grid h-10 w-10 place-items-center border border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)] transition-[background,transform] hover:bg-[var(--surface-active)] active:translate-y-px lg:hidden" onClick={onOpenHistory} aria-label="Abrir histórico">
        <AirplaneTilt size={18} aria-hidden="true" />
      </button>
      <div className="grid w-full max-w-[48rem] grid-cols-1 gap-8 md:grid-cols-[minmax(0,1fr)_12rem] md:items-end">
        <div className="border-l-2 border-[var(--primary)] pl-6 sm:pl-9">
          <span className="font-mono text-[9px] uppercase tracking-[.2em] text-[var(--primary)]">Copiloto de propostas</span>
          <h1 className="mb-0 mt-4 text-3xl font-semibold leading-[1.08] tracking-[-.045em] text-[var(--text)] sm:text-4xl">Da conversa ao PDF,<br />sem perder o contexto.</h1>
          <p className="mb-0 mt-5 max-w-[50ch] text-[13px] leading-6 text-[var(--text-secondary)]">Organize voos, hospedagem, imagens, valores e roteiro em uma sessão independente do atendimento.</p>
          <button type="button" className="btn primary mt-7 min-h-10 px-4" onClick={onCreate} disabled={creating}>
            <Plus size={15} weight="bold" aria-hidden="true" />{creating ? "Criando…" : "Criar nova proposta"}
          </button>
        </div>
        <div className="hidden border-t border-[var(--border)] pt-4 text-[10px] leading-5 text-[var(--text-muted)] md:block">
          <Sparkle size={18} className="mb-3 text-[var(--primary)]" weight="duotone" aria-hidden="true" />
          Envie somente os materiais fornecidos pelo cliente. A Tripz IA não pesquisa preços nem serviços externos.
        </div>
      </div>
    </section>
  );
}

export function TripzWorkspace() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyTriggerRef = useRef<HTMLElement>(null);
  const openHistory = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    historyTriggerRef.current = event.currentTarget;
    setHistoryOpen(true);
  }, []);
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<TripzConversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [renamingId, setRenamingId] = useState<string>();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<TripzDocument>();
  const [pdf, setPdf] = useState<TripzDocument>();
  const [generatingPreview, setGeneratingPreview] = useState(false);
  const [generatingPdf, setGeneratingPdf] = useState(false);
  const [documentError, setDocumentError] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [historyTail, setHistoryTail] = useState<TripzConversationList>({ conversations: [] });
  const [loadingMoreHistory, setLoadingMoreHistory] = useState(false);

  const {
    data: historyData,
    error: historyError,
    isLoading: historyLoading,
    mutate: mutateHistory
  } = useSWR("tripz-ai:conversations", () => listTripzConversations(), {
    revalidateOnFocus: true,
    dedupingInterval: 2_000,
    shouldRetryOnError: false
  });

  const conversations = useMemo(() => {
    const seen = new Set<string>();
    return [...(historyData?.conversations ?? []), ...historyTail.conversations].filter((conversationItem) => {
      if (seen.has(conversationItem.id)) return false;
      seen.add(conversationItem.id);
      return true;
    });
  }, [historyData?.conversations, historyTail.conversations]);
  const nextHistoryCursor = historyTail.conversations.length > 0 ? historyTail.nextCursor : historyData?.nextCursor;
  const selectedSummary = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId),
    [conversations, selectedId]
  );

  const {
    data: detail,
    error: detailError,
    isLoading: detailLoading,
    mutate: mutateDetail
  } = useSWR(selectedId ? `tripz-ai:conversation:${selectedId}` : null, () => getTripzConversation(selectedId!), {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
    refreshInterval: (latest) => latest?.conversation.processingStatus === "queued" || latest?.conversation.processingStatus === "processing" ? 2_000 : 0
  });

  const conversation = detail?.conversation ?? selectedSummary;
  const polling = conversation?.processingStatus === "queued" || conversation?.processingStatus === "processing";

  const {
    data: proposalData,
    error: proposalError,
    mutate: mutateProposal
  } = useSWR(selectedId ? `tripz-ai:proposal:${selectedId}` : null, () => getTripzProposal(selectedId!), {
    revalidateOnFocus: true,
    shouldRetryOnError: false,
    refreshInterval: polling ? 2_000 : 0
  });

  const messages = useMemo(() => {
    return detail?.messages ?? [];
  }, [detail?.messages]);
  const proposal = selectLatestTripzProposal(proposalData, detail?.proposal);

  useEffect(() => {
    if (selectedId && conversations.some((conversationItem) => conversationItem.id === selectedId)) return;
    setSelectedId(conversations[0]?.id ?? null);
  }, [conversations, selectedId]);

  useEffect(() => {
    const persistedPreview = detail?.documents?.find((document) => document.kind === "preview"
      && document.status === "ready" && document.proposalRevision === detail.proposal?.revision);
    const persistedPdf = detail?.documents?.find((document) => document.kind === "pdf"
      && document.status === "ready" && document.proposalRevision === detail.proposal?.revision);
    setPreview((current) => current?.id && current.id === persistedPreview?.id && current.html
      ? { ...persistedPreview, html: current.html }
      : persistedPreview);
    setPdf(persistedPdf);
  }, [detail?.documents, detail?.proposal?.revision, selectedId]);

  useEffect(() => {
    const latest = detail?.conversation;
    if (!latest) return;
    void mutateHistory((current) => current ? {
      ...current,
      conversations: current.conversations.map((item) => item.id === latest.id ? latest : item)
    } : current, false);
    setHistoryTail((current) => ({
      ...current,
      conversations: current.conversations.map((item) => item.id === latest.id ? latest : item)
    }));
  }, [detail?.conversation, mutateHistory]);

  useEffect(() => {
    if (!reviewOpen || !selectedId || !preview?.id || preview.html) return;
    let active = true;
    setDocumentError("");
    void fetchTripzDocumentHtml(selectedId, preview.id)
      .then((html) => { if (active) setPreview((current) => current ? { ...current, html } : current); })
      .catch((error) => { if (active) setDocumentError(readableError(error, "Não foi possível abrir a prévia salva.")); })
    return () => { active = false; };
  }, [preview?.html, preview?.id, reviewOpen, selectedId]);

  const refreshConversation = useCallback(async () => {
    await Promise.all([mutateHistory(), mutateDetail(), mutateProposal()]);
  }, [mutateDetail, mutateHistory, mutateProposal]);

  const retryTurn = useCallback(async (messageId: string) => {
    if (!selectedId) return;
    await retryTripzMessage(selectedId, messageId);
    await refreshConversation();
  }, [refreshConversation, selectedId]);

  const createConversation = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setWorkspaceError("");
    try {
      const created = await createTripzConversation();
      await mutateHistory((current) => current
        ? { ...current, conversations: [created, ...current.conversations.filter((item) => item.id !== created.id)] }
        : { conversations: [created] }, false);
      setSelectedId(created.id);
      setHistoryOpen(false);
    } catch (error) {
      setWorkspaceError(readableError(error, "Não foi possível criar a proposta."));
    } finally {
      setCreating(false);
    }
  }, [creating, mutateHistory]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setWorkspaceError("");
    try {
      await deleteTripzConversation(deleteTarget.id);
      const remaining = conversations.filter((conversationItem) => conversationItem.id !== deleteTarget.id);
      await mutateHistory((current) => current ? { ...current, conversations: remaining } : { conversations: remaining }, false);
      setHistoryTail((current) => ({ ...current, conversations: current.conversations.filter((item) => item.id !== deleteTarget.id) }));
      if (selectedId === deleteTarget.id) setSelectedId(remaining[0]?.id ?? null);
      setDeleteTarget(null);
    } catch (error) {
      setWorkspaceError(readableError(error, "Não foi possível excluir a proposta."));
    } finally {
      setDeleting(false);
    }
  }, [conversations, deleteTarget, deleting, mutateHistory, selectedId]);

  const loadMoreHistory = useCallback(async () => {
    if (!nextHistoryCursor || loadingMoreHistory) return;
    setLoadingMoreHistory(true);
    setWorkspaceError("");
    try {
      const page = await listTripzConversations(nextHistoryCursor);
      setHistoryTail((current) => ({
        conversations: [...current.conversations, ...page.conversations],
        nextCursor: page.nextCursor
      }));
    } catch (error) {
      setWorkspaceError(readableError(error, "Não foi possível carregar mais propostas."));
    } finally {
      setLoadingMoreHistory(false);
    }
  }, [loadingMoreHistory, nextHistoryCursor]);

  const renameConversation = useCallback(async (target: TripzConversation, title: string) => {
    if (renamingId) return;
    setRenamingId(target.id);
    setWorkspaceError("");
    try {
      const renamed = await renameTripzConversation(target.id, title);
      await mutateHistory((current) => current ? {
        ...current,
        conversations: current.conversations.map((item) => item.id === renamed.id ? renamed : item)
      } : current, false);
      setHistoryTail((current) => ({
        ...current,
        conversations: current.conversations.map((item) => item.id === renamed.id ? renamed : item)
      }));
      await mutateDetail((current) => current && current.conversation.id === renamed.id
        ? { ...current, conversation: renamed }
        : current, false);
    } catch (error) {
      setWorkspaceError(readableError(error, "Não foi possível renomear a proposta."));
      throw error;
    } finally {
      setRenamingId(undefined);
    }
  }, [mutateDetail, mutateHistory, renamingId]);

  const generatePreview = useCallback(async () => {
    const expectedRevision = proposal?.revision;
    if (!selectedId || expectedRevision == null || generatingPreview) return;
    setGeneratingPreview(true);
    setDocumentError("");
    try {
      let document = await generateTripzPreview(selectedId, expectedRevision);
      if (!document.html && document.id && document.status === "ready") {
        document = { ...document, html: await fetchTripzDocumentHtml(selectedId, document.id) };
      }
      setPreview(document);
      await Promise.all([mutateDetail(), mutateHistory()]);
    } catch (error) {
      setDocumentError(readableError(error, "Não foi possível gerar a prévia."));
    } finally {
      setGeneratingPreview(false);
    }
  }, [generatingPreview, mutateDetail, mutateHistory, proposal?.revision, selectedId]);

  const generatePdf = useCallback(async () => {
    const expectedRevision = proposal?.revision;
    if (!selectedId || expectedRevision == null || generatingPdf) return;
    setGeneratingPdf(true);
    setDocumentError("");
    try {
      const document = await generateTripzPdf(selectedId, expectedRevision);
      setPdf(document);
      await Promise.all([mutateDetail(), mutateHistory(), mutateProposal()]);
    } catch (error) {
      setDocumentError(readableError(error, "Não foi possível gerar o PDF."));
    } finally {
      setGeneratingPdf(false);
    }
  }, [generatingPdf, mutateDetail, mutateHistory, mutateProposal, proposal?.revision, selectedId]);

  const openConversation = (id: string) => {
    setSelectedId(id);
    setHistoryOpen(false);
    setReviewOpen(false);
    setDocumentError("");
  };

  return (
    <div className={styles.workspace}>
      <TripzHistorySidebar
        conversations={conversations}
        selectedId={selectedId}
        loading={historyLoading}
        creating={creating}
        loadingMore={loadingMoreHistory}
        renamingId={renamingId}
        hasMore={Boolean(nextHistoryCursor)}
        mobileOpen={historyOpen}
        onCloseMobile={() => setHistoryOpen(false)}
        mobileTriggerRef={historyTriggerRef}
        onCreate={() => void createConversation()}
        onSelect={openConversation}
        onDelete={setDeleteTarget}
        onRename={renameConversation}
        onLoadMore={() => void loadMoreHistory()}
      />

      {historyError && !historyData ? (
        <section className="grid min-h-0 place-items-center p-6 text-center" role="alert">
          <div className="max-w-sm">
            <WarningCircle size={28} weight="duotone" className="mx-auto text-[var(--warning-text)]" aria-hidden="true" />
            <h1 className="mb-0 mt-4 text-base text-[var(--text)]">Não foi possível abrir a Tripz IA</h1>
            <p className="mb-0 mt-2 text-xs leading-5 text-[var(--text-secondary)]">{readableError(historyError, "Falha ao carregar as propostas.")}</p>
            <button type="button" className="btn mt-5" onClick={() => void mutateHistory()}><ArrowClockwise size={14} aria-hidden="true" />Tentar novamente</button>
          </div>
        </section>
      ) : conversation ? (
        <TripzConversationView
          conversation={conversation}
          messages={messages}
          proposal={proposal}
          loading={detailLoading}
          error={detailError ? readableError(detailError, "Falha ao carregar a conversa.") : undefined}
          onOpenHistory={openHistory}
          onOpenReview={() => setReviewOpen(true)}
          onRetry={() => void refreshConversation()}
          onRetryTurn={retryTurn}
          onSent={refreshConversation}
        />
      ) : (
        <WorkspaceEmpty creating={creating} onCreate={() => void createConversation()} onOpenHistory={openHistory} />
      )}

      {reviewOpen && selectedId ? (
        <TripzProposalReview
          conversationId={selectedId}
          proposal={proposal}
          preview={preview}
          pdf={pdf}
          generatingPreview={generatingPreview}
          generatingPdf={generatingPdf}
          processing={polling}
          actionError={documentError || (proposalError ? readableError(proposalError, "O resumo não pôde ser carregado.") : undefined)}
          onClose={() => setReviewOpen(false)}
          onGeneratePreview={() => void generatePreview()}
          onGeneratePdf={() => void generatePdf()}
          onRequestCorrection={() => {
            setReviewOpen(false);
            requestAnimationFrame(() => document.getElementById("tripz-message")?.focus());
          }}
        />
      ) : null}

      {deleteTarget ? (
        <ModalDialog labelledBy="tripz-delete-title" describedBy="tripz-delete-description" onClose={() => { if (!deleting) setDeleteTarget(null); }}>
          <span className="grid h-10 w-10 place-items-center border border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning-text)]"><Trash size={18} weight="duotone" aria-hidden="true" /></span>
          <h2 id="tripz-delete-title">Excluir esta proposta?</h2>
          <p id="tripz-delete-description">A conversa “{deleteTarget.title}”, seus anexos e documentos deixam de aparecer no histórico.</p>
          <div className="flex justify-end gap-2 border-t border-[var(--border)] pt-4">
            <button type="button" className="btn" disabled={deleting} onClick={() => setDeleteTarget(null)}>Cancelar</button>
            <button type="button" className="btn warn" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "Excluindo…" : "Excluir proposta"}</button>
          </div>
        </ModalDialog>
      ) : null}

      {workspaceError ? (
        <div className="fixed bottom-4 left-4 right-4 z-[3] flex items-start justify-between gap-3 border border-[var(--warning-border)] bg-[var(--surface-elevated)] p-3 text-xs text-[var(--warning-text)] sm:left-auto sm:max-w-sm" role="alert">
          <span>{workspaceError}</span>
          <button type="button" className="grid h-6 w-6 shrink-0 place-items-center bg-transparent transition-transform active:scale-[.96]" onClick={() => setWorkspaceError("")} aria-label="Fechar aviso"><X size={14} aria-hidden="true" /></button>
        </div>
      ) : null}
    </div>
  );
}
