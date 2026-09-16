"use client";

import { ArrowClockwise, FileText, List, Robot, SidebarSimple, WarningCircle } from "@phosphor-icons/react";
import React, { useEffect, useRef, useState } from "react";
import {
  tripzConversationStatusLabel,
  tripzProcessingStatusLabel,
  type TripzConversation,
  type TripzMessage,
  type TripzProposal
} from "../../lib/tripz-ai";
import { TripzComposer } from "./composer";
import { TripzMessageBubble } from "./message-bubble";
import styles from "./tripz-ai.module.css";

function MessagesSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-[52rem] gap-8 py-6" role="status" aria-label="Carregando conversa">
      <div className="grid w-3/4 gap-2">
        <span className="skeleton h-3 w-24" aria-hidden="true" />
        <span className="skeleton h-20 w-full" aria-hidden="true" />
      </div>
      <div className="ml-auto grid w-2/3 gap-2">
        <span className="skeleton ml-auto h-3 w-20" aria-hidden="true" />
        <span className="skeleton h-16 w-full" aria-hidden="true" />
      </div>
      <div className="grid w-4/5 gap-2">
        <span className="skeleton h-3 w-24" aria-hidden="true" />
        <span className="skeleton h-28 w-full" aria-hidden="true" />
      </div>
    </div>
  );
}

function ProcessingCard({
  conversation,
  failedMessageId,
  onRetry
}: {
  conversation: TripzConversation;
  failedMessageId?: string;
  onRetry: (messageId: string) => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const status = conversation.processingStatus;
  if (status === "failed") {
    return (
      <div className="mr-auto grid max-w-[36rem] grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-3 border-l-2 border-[var(--warning)] py-3 pl-3 pr-4" role="alert">
        <span className="grid h-9 w-9 place-items-center border border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning-text)]"><WarningCircle size={17} weight="duotone" aria-hidden="true" /></span>
        <span className="grid gap-2">
          <span><strong className="block text-[11px] text-[var(--text-secondary)]">A análise foi interrompida</strong><span className="text-[10px] leading-4 text-[var(--text-secondary)]">Seus dados continuam salvos. Tente processar o mesmo turno novamente.</span></span>
          {conversation.processingErrorCode ? <code className="text-[9px] text-[var(--text-muted)]">{conversation.processingErrorCode}</code> : null}
          {retryError ? <span className="text-[10px] text-[var(--warning-text)]">{retryError}</span> : null}
          <button type="button" className="btn w-fit" disabled={!failedMessageId || retrying} onClick={() => {
            if (!failedMessageId || retrying) return;
            setRetrying(true);
            setRetryError("");
            void onRetry(failedMessageId).catch((error) => setRetryError(error instanceof Error ? error.message : "Não foi possível tentar novamente.")).finally(() => setRetrying(false));
          }}><ArrowClockwise size={14} aria-hidden="true" />{retrying ? "Reenviando…" : "Tentar novamente"}</button>
        </span>
      </div>
    );
  }
  if (status !== "queued" && status !== "processing") return null;
  return (
    <div className="mr-auto grid max-w-[32rem] grid-cols-[2.25rem_minmax(0,1fr)] items-center gap-3 border-l-2 border-[var(--primary)] py-3 pl-3 pr-4" role="status" aria-live="polite" aria-atomic="true">
      <span className="grid h-9 w-9 place-items-center border border-[var(--primary-border)] bg-[var(--primary-subtle)] text-[var(--primary)]">
        <Robot size={17} weight="duotone" aria-hidden="true" />
      </span>
      <span className="grid gap-1">
        <strong className="text-[11px] font-semibold text-[var(--text-secondary)]">{tripzProcessingStatusLabel(status)}</strong>
        <span className="flex gap-1" aria-hidden="true">
          {[0, 1, 2].map((index) => <i key={index} className="h-1 w-8 animate-pulse bg-[var(--primary)] opacity-60" style={{ animationDelay: `${index * 140}ms` }} />)}
        </span>
      </span>
    </div>
  );
}

function ConversationEmpty() {
  return (
    <div className="mx-auto grid min-h-full w-full max-w-[52rem] content-center px-2 py-10 text-left">
      <div className="max-w-[34rem] border-l-2 border-[var(--primary)] pl-6 sm:pl-8">
        <span className="font-mono text-[9px] uppercase tracking-[.18em] text-[var(--primary)]">Comece pela informação mais fácil</span>
        <h2 className="mb-0 mt-3 text-2xl font-semibold leading-tight tracking-[-.035em] text-[var(--text)] sm:text-3xl">Conte o destino.<br />A proposta toma forma na conversa.</h2>
        <p className="mb-0 mt-4 max-w-[48ch] text-[13px] leading-6 text-[var(--text-secondary)]">Envie uma frase, prints dos voos, imagens da hospedagem ou um PDF. A Tripz IA organiza os dados e pergunta apenas o próximo ponto necessário.</p>
        <div className="mt-7 grid gap-2 border-t border-[var(--border)] pt-4 text-[11px] text-[var(--text-muted)] sm:grid-cols-2">
          <span>“Aruba para duas pessoas em outubro.”</span>
          <span>“Vou enviar os voos e o hotel agora.”</span>
        </div>
      </div>
    </div>
  );
}

export function TripzConversationView({
  conversation,
  messages,
  proposal,
  loading,
  error,
  onOpenHistory,
  onOpenReview,
  onRetry,
  onRetryTurn,
  onSent
}: {
  conversation: TripzConversation;
  messages: TripzMessage[];
  proposal?: TripzProposal;
  loading: boolean;
  error?: string;
  onOpenHistory: (event: React.MouseEvent<HTMLElement>) => void;
  onOpenReview: () => void;
  onRetry: () => void;
  onRetryTurn: (messageId: string) => Promise<void>;
  onSent: () => void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerDisabled = conversation.processingStatus === "queued" || conversation.processingStatus === "processing";
  const failedMessageId = [...messages].reverse().find((message) => message.role === "user" && message.processingStatus === "failed")?.id;

  useEffect(() => {
    const region = scrollRef.current;
    if (!region) return;
    region.scrollTo({ top: region.scrollHeight, behavior: messages.length > 1 ? "smooth" : "auto" });
  }, [messages.length, conversation.processingStatus]);

  return (
    <section className={styles.conversation} aria-label={`Conversa ${conversation.title}`}>
      <header className={`${styles.conversationHeader} flex min-h-16 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-3 sm:px-5`}>
        <div className="flex min-w-0 items-center gap-3">
          <button type="button" className="grid h-9 w-9 shrink-0 place-items-center border border-[var(--border)] bg-transparent text-[var(--text-secondary)] transition-[background,transform] hover:bg-[var(--surface-active)] hover:text-[var(--text)] active:translate-y-px lg:hidden" onClick={onOpenHistory} aria-label="Abrir histórico de propostas">
            <List size={17} aria-hidden="true" />
          </button>
          <div className="min-w-0">
            <h1 className="m-0 truncate text-sm font-semibold tracking-tight text-[var(--text)] sm:text-base">{conversation.title}</h1>
            <span className="mt-1 flex items-center gap-2 text-[10px] text-[var(--text-muted)]">
              <i className={`h-1.5 w-1.5 rounded-full ${conversation.status === "pdf_generated" ? "bg-[var(--success)]" : conversation.status === "collecting" ? "bg-[var(--text-muted)]" : "bg-[var(--primary)]"}`} aria-hidden="true" />
              {tripzConversationStatusLabel(conversation.status)}
            </span>
          </div>
        </div>
        <button type="button" className="btn shrink-0" onClick={onOpenReview} aria-label="Abrir resumo e revisão da proposta">
          <SidebarSimple size={15} aria-hidden="true" />
          <span className="hidden sm:inline">Revisar proposta</span>
          <span className="sm:hidden">Revisar</span>
        </button>
      </header>

      <div ref={scrollRef} className={`${styles.scrollRegion} min-h-0 overflow-y-auto overscroll-contain px-4 py-5 sm:px-6`} aria-busy={loading}>
        {loading ? <MessagesSkeleton /> : error ? (
          <div className="mx-auto grid min-h-full w-full max-w-[36rem] place-items-center py-10 text-center" role="alert">
            <div>
              <WarningCircle size={28} weight="duotone" className="mx-auto text-[var(--warning-text)]" aria-hidden="true" />
              <h2 className="mb-0 mt-4 text-sm text-[var(--text)]">Não foi possível carregar a conversa</h2>
              <p className="mb-0 mt-2 text-xs leading-5 text-[var(--text-secondary)]">{error}</p>
              <button type="button" className="btn mt-5" onClick={onRetry}><ArrowClockwise size={14} aria-hidden="true" />Tentar novamente</button>
            </div>
          </div>
        ) : messages.length === 0 ? <ConversationEmpty /> : (
          <div className="mx-auto grid w-full max-w-[52rem] gap-7 pb-3">
            {messages.map((message) => <TripzMessageBubble key={message.id} conversationId={conversation.id} message={message} />)}
            {proposal && (proposal.status !== "collecting" || proposal.inconsistencies.length > 0) ? (
              <button type="button" className="mr-auto grid max-w-[38rem] grid-cols-[auto_minmax(0,1fr)] gap-3 border-y border-[var(--border)] bg-transparent px-1 py-4 text-left transition-[border-color,transform] hover:border-[var(--primary)] active:translate-y-px" onClick={onOpenReview}>
                <span className="grid h-10 w-10 place-items-center border border-[var(--primary-border)] bg-[var(--primary-subtle)] text-[var(--primary)]"><FileText size={18} weight="duotone" aria-hidden="true" /></span>
                <span className="grid gap-1">
                  <strong className="text-xs text-[var(--text)]">Resumo da proposta atualizado</strong>
                  <span className="text-[10px] leading-4 text-[var(--text-muted)]">{proposal.missingInformation.length ? `${proposal.missingInformation.length} informação(ões) ainda pendente(s)` : "Dados reunidos para a revisão final"}</span>
                </span>
              </button>
            ) : null}
            <ProcessingCard conversation={conversation} failedMessageId={failedMessageId} onRetry={onRetryTurn} />
          </div>
        )}
      </div>

      <TripzComposer
        key={conversation.id}
        conversationId={conversation.id}
        processing={composerDisabled}
        disabled={Boolean(error)}
        onSent={onSent}
      />
    </section>
  );
}
