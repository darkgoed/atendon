"use client";

import { ArrowSquareOut, CheckCircle, DownloadSimple, Eye, FilePdf, PencilSimple, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import React from "react";
import { ModalDialog } from "../modal-dialog";
import {
  tripzApiContentUrl,
  tripzConversationStatusLabel,
  tripzDocumentContentPath,
  type TripzDocument,
  type TripzProposal
} from "../../lib/tripz-ai";
import styles from "./tripz-ai.module.css";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function textValue(source: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function listLength(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    if (Array.isArray(source[key])) return source[key].length;
  }
  return 0;
}

function SummaryField({ label, value }: { label: string; value?: string }) {
  return (
    <div className="grid gap-1 border-t border-[var(--border)] py-3 first:border-t-0 first:pt-0">
      <dt className="font-mono text-[9px] uppercase tracking-[.12em] text-[var(--text-muted)]">{label}</dt>
      <dd className={`m-0 text-xs leading-5 ${value ? "text-[var(--text-secondary)]" : "text-[var(--text-muted)]"}`}>{value || "Ainda não informado"}</dd>
    </div>
  );
}

export function TripzProposalReview({
  conversationId,
  proposal,
  preview,
  pdf,
  generatingPreview,
  generatingPdf,
  processing,
  actionError,
  onClose,
  onGeneratePreview,
  onGeneratePdf,
  onRequestCorrection
}: {
  conversationId: string;
  proposal?: TripzProposal;
  preview?: TripzDocument;
  pdf?: TripzDocument;
  generatingPreview: boolean;
  generatingPdf: boolean;
  processing: boolean;
  actionError?: string;
  onClose: () => void;
  onGeneratePreview: () => void;
  onGeneratePdf: () => void;
  onRequestCorrection: () => void;
}) {
  const state = proposal?.state ?? {};
  const hotel = record(state.hotel);
  const pricing = record(state.pricing);
  const passengers = record(state.passengers);
  const itineraryCount = listLength(state, "itinerary");
  const flightCount = listLength(state, "flights");
  const includedCount = listLength(state, "includedItems", "included_items");
  const pdfHref = pdf?.id ? tripzApiContentUrl(tripzDocumentContentPath(conversationId, pdf.id)) : undefined;
  const dateRange = [proposal?.startDate, proposal?.endDate].filter(Boolean).join(" — ");
  const passengerSummary = [
    textValue(passengers, "adults") ? `${textValue(passengers, "adults")} adulto(s)` : "",
    textValue(passengers, "children") ? `${textValue(passengers, "children")} criança(s)` : "",
    textValue(passengers, "infants") ? `${textValue(passengers, "infants")} bebê(s)` : ""
  ].filter(Boolean).join(", ");
  const price = textValue(pricing, "totalPrice", "total_price") ?? textValue(pricing, "pricePerPerson", "price_per_person");
  const currency = textValue(pricing, "currency");

  return (
    <ModalDialog
      className={styles.reviewModal}
      labelledBy="tripz-review-title"
      describedBy="tripz-review-description"
      onClose={onClose}
    >
      <header className="flex items-start justify-between gap-4 border-b border-[var(--border)] px-5 py-4 sm:px-6">
        <div className="min-w-0">
          <span className="font-mono text-[9px] uppercase tracking-[.17em] text-[var(--primary-text)]">Revisão da proposta</span>
          <h2 id="tripz-review-title" className="mt-1 truncate !text-lg">{proposal?.title || proposal?.destination || "Proposta em construção"}</h2>
          <p id="tripz-review-description" className="m-0 mt-1 text-[11px] text-[var(--text-secondary)]">Confira os dados estruturados e gere uma prévia antes do PDF.</p>
        </div>
        <button type="button" className="grid h-9 w-9 shrink-0 place-items-center bg-transparent text-[var(--text-secondary)] transition-[background,transform] hover:bg-[var(--surface-active)] hover:text-[var(--text)] active:scale-[.96]" onClick={onClose} aria-label="Fechar revisão">
          <X size={17} aria-hidden="true" />
        </button>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[19rem_minmax(0,1fr)] md:overflow-hidden">
        <section className="min-h-0 border-b border-[var(--border)] bg-[var(--surface-sunken)] p-5 md:overflow-y-auto md:border-b-0 md:border-r sm:p-6" aria-label="Resumo estruturado">
          {proposal ? (
            <>
              <div className="mb-5 flex items-center gap-2 border-b border-[var(--border)] pb-4">
                <CheckCircle size={16} weight="duotone" className="text-[var(--primary)]" aria-hidden="true" />
                <div>
                  <strong className="block text-xs text-[var(--text)]">{tripzConversationStatusLabel(proposal.status)}</strong>
                  <span className="font-mono text-[9px] text-[var(--text-muted)]">Revisão {proposal.revision}</span>
                </div>
              </div>
              <dl className="m-0">
                <SummaryField label="Cliente" value={proposal.clientName} />
                <SummaryField label="Destino" value={proposal.destination} />
                <SummaryField label="Período" value={dateRange} />
                <SummaryField label="Passageiros" value={passengerSummary} />
                <SummaryField label="Hospedagem" value={textValue(hotel, "name")} />
                <SummaryField label="Acomodação" value={textValue(hotel, "roomType", "room_type")} />
                <SummaryField label="Investimento" value={[currency, price].filter(Boolean).join(" ")} />
                <SummaryField label="Conteúdo" value={`${flightCount} voo(s) · ${itineraryCount} dia(s) de roteiro · ${includedCount} item(ns) incluso(s)`} />
              </dl>

              {proposal.inconsistencies.length > 0 ? (
                <div className="mt-5 border-l-2 border-[var(--warning)] pl-3">
                  <strong className="flex items-center gap-2 text-[11px] text-[var(--warning-text)]"><WarningCircle size={14} weight="fill" aria-hidden="true" />Pontos a confirmar</strong>
                  <ul className="mb-0 mt-2 grid gap-1.5 pl-4 text-[10px] leading-4 text-[var(--warning-text)]">
                    {proposal.inconsistencies.map((issue) => <li key={issue}>{issue}</li>)}
                  </ul>
                </div>
              ) : null}
              {proposal.missingInformation.length > 0 ? (
                <div className="mt-5 border-t border-[var(--border)] pt-4">
                  <strong className="text-[10px] uppercase tracking-wide text-[var(--text-secondary)]">Ainda falta</strong>
                  <ul className="mb-0 mt-2 grid gap-1.5 pl-4 text-[10px] leading-4 text-[var(--text-muted)]">
                    {proposal.missingInformation.map((item) => <li key={item}>{item}</li>)}
                  </ul>
                </div>
              ) : null}
            </>
          ) : (
            <div className="py-8" role="status">
              <span className="skeleton mb-3 block h-4 w-2/3" aria-hidden="true" />
              <span className="skeleton mb-2 block h-10 w-full" aria-hidden="true" />
              <span className="skeleton block h-24 w-full" aria-hidden="true" />
              <p className="mt-4 text-xs text-[var(--text-secondary)]">O resumo aparecerá quando a proposta for estruturada.</p>
            </div>
          )}
        </section>

        <section className="grid min-h-[28rem] grid-rows-[auto_minmax(0,1fr)] bg-[var(--bg)] md:min-h-0" aria-label="Prévia do documento" aria-busy={processing}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3 sm:px-5">
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
              <Eye size={15} aria-hidden="true" />
              <span>{processing ? "Aguarde a análise atual" : preview?.status === "ready" ? "Prévia fiel ao PDF" : preview?.status === "processing" || preview?.status === "queued" ? "Preparando prévia" : "Prévia ainda não gerada"}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" disabled={!proposal || processing || generatingPreview} onClick={onGeneratePreview}>
                {generatingPreview ? <SpinnerGap size={14} className="animate-spin" aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
                {preview ? "Atualizar prévia" : "Gerar prévia"}
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={!proposal || processing || generatingPdf || !preview?.html || preview.proposalRevision !== proposal.revision}
                title={!preview?.html || preview.proposalRevision !== proposal?.revision ? "Gere e revise a prévia desta versão primeiro" : undefined}
                onClick={onGeneratePdf}
              >
                {generatingPdf ? <SpinnerGap size={14} className="animate-spin" aria-hidden="true" /> : <FilePdf size={14} aria-hidden="true" />}
                Gerar PDF
              </button>
              {pdfHref ? (
                <a className="btn" href={pdfHref} download={pdf?.filename || "proposta-tripz.pdf"}>
                  <DownloadSimple size={14} aria-hidden="true" />Baixar PDF
                </a>
              ) : null}
            </div>
          </div>
          <div className="relative min-h-0 overflow-auto p-4 sm:p-6">
            {preview?.html ? (
              <iframe
                className={styles.reviewDocument}
                title="Prévia segura da proposta Tripz"
                sandbox=""
                referrerPolicy="no-referrer"
                srcDoc={preview.html}
              />
            ) : (
              <div className="grid h-full min-h-[24rem] place-items-center border border-dashed border-[var(--border)] bg-[var(--surface-sunken)] px-6 text-center">
                <div className="max-w-xs">
                  <ArrowSquareOut size={30} weight="duotone" className="mx-auto text-[var(--text-muted)]" aria-hidden="true" />
                  <h3 className="mb-0 mt-4 text-sm text-[var(--text)]">Visualize antes de finalizar</h3>
                  <p className="mb-0 mt-2 text-xs leading-5 text-[var(--text-secondary)]">A prévia usa o mesmo conteúdo do PDF e abre isolada, sem executar scripts.</p>
                </div>
              </div>
            )}
          </div>
        </section>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-5 py-3 sm:px-6">
        <p className={`m-0 text-[10px] ${actionError ? "text-[var(--warning-text)]" : "text-[var(--text-muted)]"}`} role={actionError ? "alert" : undefined}>
          {actionError || "Correções continuam sendo feitas por mensagem, mantendo o histórico da revisão."}
        </p>
        <button type="button" className="btn" onClick={onRequestCorrection}>
          <PencilSimple size={14} aria-hidden="true" />Corrigir na conversa
        </button>
      </footer>
    </ModalDialog>
  );
}
