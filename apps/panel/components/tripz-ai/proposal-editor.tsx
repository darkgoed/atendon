"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowClockwise, CheckCircle, WarningCircle, X } from "@/components/icons";
import type { TripzDocument, TripzProposal, TripzProposalValidation, TripzProposalVersion } from "@/lib/tripz-ai";
import {
  finalizeTripzProposal,
  generateTripzPreview,
  listTripzProposalVersions,
  patchTripzProposal,
  revertTripzProposalVersion,
  sendTripzMessage,
  tripzMediaFromUrl,
  uploadTripzAttachment,
  validateTripzProposalState
} from "@/lib/tripz-ai";

type Assignment = {
  mediaId?: string;
  role?: string;
  targetId?: string;
  position?: { x?: number; y?: number; zoom?: number };
  caption?: string;
};

type Props = {
  conversationId: string;
  proposal: TripzProposal;
  onClose: () => void;
  onProposalChange: (proposal: TripzProposal) => void;
};

function pageEntries(previewHtml: string): Array<{ index: number; label: string }> {
  const labels: Array<[string, string]> = [
    ["tp-cover", "Capa"],
    ["tp-concept", "Conceito"],
    ["tp-overview", "Visão geral"],
    ["tp-destination", "Jornada"],
    ["tp-hotel", "Hospedagem"],
    ["tp-experiences", "Experiências"],
    ["tp-services", "Serviços"],
    ["tp-flights", "Voos"],
    ["tp-closing", "Fechamento"]
  ];
  return Array.from(previewHtml.matchAll(/class="tp-page ([^"]*)"/g)).map((match, index) => {
    const found = labels.find(([marker]) => match[1].includes(marker));
    return { index, label: found ? found[1] : "Página" };
  });
}

function editorial(state: Record<string, unknown>): Record<string, unknown> {
  const raw = state.editorial;
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}

function assignmentsOf(state: Record<string, unknown>): Assignment[] {
  const raw = editorial(state).imageAssignments;
  return Array.isArray(raw) ? raw as Assignment[] : [];
}

export function TripzProposalEditor({ conversationId, proposal, onClose, onProposalChange }: Props) {
  const [preview, setPreview] = useState<TripzDocument | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [validation, setValidation] = useState<TripzProposalValidation | null>(null);
  const [versions, setVersions] = useState<TripzProposalVersion[]>([]);
  const [selectedPage, setSelectedPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [quick, setQuick] = useState({
    title: proposal.title ?? "",
    clientName: proposal.clientName ?? "",
    destination: proposal.destination ?? "",
    startDate: proposal.startDate ?? "",
    endDate: proposal.endDate ?? "",
    adults: String((proposal.state.passengers as { adults?: number } | undefined)?.adults ?? 2)
  });
  const [investment, setInvestment] = useState(() => {
    const commercial = editorial(proposal.state).commercial as Record<string, unknown> | undefined;
    return String(commercial?.total ?? "");
  });
  const [paymentLabel, setPaymentLabel] = useState(() => {
    const commercial = editorial(proposal.state).commercial as Record<string, unknown> | undefined;
    const entries = Array.isArray(commercial?.paymentEntries) ? commercial?.paymentEntries as Array<Record<string, unknown>> : [];
    return String(entries[0]?.value ?? "");
  });
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const pages = useMemo(() => (preview?.html ? pageEntries(preview.html) : []), [preview]);

  const refreshPreview = useCallback(async () => {
    setLoadingPreview(true);
    setError(null);
    try {
      const document = await generateTripzPreview(conversationId, proposal.revision);
      setPreview(document);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao gerar o preview");
    } finally {
      setLoadingPreview(false);
    }
  }, [conversationId, proposal.revision]);

  const refreshMeta = useCallback(async () => {
    try {
      const [validationState, versionList] = await Promise.all([
        validateTripzProposalState(conversationId),
        listTripzProposalVersions(conversationId)
      ]);
      setValidation(validationState);
      setVersions(versionList);
    } catch {
      // validação/versões são secundárias ao preview
    }
  }, [conversationId]);

  useEffect(() => {
    void refreshPreview();
    void refreshMeta();
  }, [refreshPreview, refreshMeta]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !pages.length) return;
    const go = () => {
      const target = iframe.contentDocument?.querySelectorAll<HTMLElement>(".tp-page")[selectedPage];
      target?.scrollIntoView({ block: "start" });
    };
    const timer = window.setTimeout(go, 220);
    return () => window.clearTimeout(timer);
  }, [selectedPage, pages, preview]);

  async function run(edit: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await edit();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Ação falhou");
    } finally {
      setBusy(false);
    }
  }

  async function patchEditorial(value: Record<string, unknown>) {
    await run(async () => {
      const updated = await patchTripzProposal(conversationId, proposal.revision, { editorial: value });
      onProposalChange(updated);
      await refreshPreview();
      await refreshMeta();
    });
  }

  const assignments = assignmentsOf(proposal.state);

  async function replaceAssignmentPhoto(index: number, mediaId: string) {
    const next = assignments.map((assignment, position) => (
      position === index ? { ...assignment, mediaId } : assignment
    ));
    await patchEditorial({ imageAssignments: next });
  }

  const criticalIssues = validation?.issues.filter((issue) => issue.severity === "critical") ?? [];

  return (
    <div className="fixed inset-0 z-[4] grid grid-cols-[260px_1fr_300px] bg-[var(--surface)]">
      {/* coluna 1 — páginas */}
      <aside className="flex min-h-0 flex-col border-r border-[var(--border)]">
        <header className="flex items-center justify-between border-b border-[var(--border)] p-3">
          <span className="text-xs font-semibold">Páginas ({pages.length})</span>
          <button type="button" className="btn-icon" onClick={() => void refreshPreview()} aria-label="Regenerar preview">
            <ArrowClockwise size={14} aria-hidden="true" className={loadingPreview ? "animate-spin" : ""} />
          </button>
        </header>
        <ol className="min-h-0 flex-1 overflow-auto p-2">
          {pages.map((page) => (
            <li key={page.index}>
              <button
                type="button"
                onClick={() => setSelectedPage(page.index)}
                aria-current={page.index === selectedPage}
                className={`mb-1 w-full rounded border px-2 py-2 text-left text-xs ${page.index === selectedPage ? "border-[var(--primary)] bg-[var(--surface-elevated)]" : "border-[var(--border)]"}`}
              >
                <span className="block font-semibold">P{page.index + 1}</span>
                <span className="block text-[var(--text-secondary)]">{page.label}</span>
              </button>
            </li>
          ))}
          {!pages.length && !loadingPreview ? <li className="p-3 text-xs text-[var(--text-secondary)]">Preview ainda não gerado.</li> : null}
        </ol>
        <footer className="border-t border-[var(--border)] p-3">
          <button type="button" className="btn w-full" disabled={busy || !validation?.canFinalize || criticalIssues.length > 0}
            onClick={() => void run(async () => {
              const result = await finalizeTripzProposal(conversationId, { label: `Finalizada em ${new Date().toLocaleDateString("pt-BR")}` });
              setVersions((current) => [result.version, ...current]);
            })}>
            Finalizar proposta
          </button>
          {versions.length ? (
            <div className="mt-2">
              <span className="text-[11px] text-[var(--text-secondary)]">Versões</span>
              <ul>
                {versions.slice(0, 5).map((version) => (
                  <li key={version.id} className="flex items-center justify-between gap-2 text-[11px]">
                    <span>V{version.versionNumber}{version.label ? ` · ${version.label}` : ""}</span>
                    <button type="button" className="btn-icon" disabled={busy}
                      onClick={() => void run(async () => {
                        const updated = await revertTripzProposalVersion(conversationId, version.id);
                        onProposalChange(updated);
                        await refreshPreview();
                      })}>Reverter</button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </footer>
      </aside>

      {/* coluna 2 — canvas A4 */}
      <section className="flex min-h-0 flex-col bg-[var(--surface-subtle)]">
        <header className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-2">
          <span className="text-xs text-[var(--text-secondary)]">Preview A4 — mesmas páginas do PDF final</span>
          <button type="button" className="btn-icon" onClick={onClose} aria-label="Fechar editor"><X size={14} aria-hidden="true" /></button>
        </header>
        {preview?.html ? (
          <iframe ref={iframeRef} title="Preview da proposta" srcDoc={preview.html}
            className="h-full w-full border-0 bg-white" sandbox="allow-same-origin" />
        ) : (
          <div className="grid flex-1 place-items-center text-xs text-[var(--text-secondary)]">
            {loadingPreview ? "Gerando preview…" : (error ?? "Sem preview")}
          </div>
        )}
      </section>

      {/* coluna 3 — inspetor */}
      <aside className="flex min-h-0 flex-col overflow-auto border-l border-[var(--border)]">
        <header className="border-b border-[var(--border)] p-3 text-xs font-semibold">Resumo & ajustes</header>
        <div className="space-y-3 p-3 text-xs">
          <fieldset className="grid gap-2">
            <label>Título da proposta
              <input className="input" value={quick.title} onChange={(event) => setQuick({ ...quick, title: event.target.value })} />
            </label>
            <label>Viajantes
              <input className="input" value={quick.clientName} onChange={(event) => setQuick({ ...quick, clientName: event.target.value })} />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label>Início<input type="date" className="input" value={quick.startDate} onChange={(event) => setQuick({ ...quick, startDate: event.target.value })} /></label>
              <label>Fim<input type="date" className="input" value={quick.endDate} onChange={(event) => setQuick({ ...quick, endDate: event.target.value })} /></label>
            </div>
            <label>Destino<input className="input" value={quick.destination} onChange={(event) => setQuick({ ...quick, destination: event.target.value })} /></label>
            <label>Adultos<input type="number" min={1} className="input" value={quick.adults} onChange={(event) => setQuick({ ...quick, adults: event.target.value })} /></label>
            <button type="button" className="btn" disabled={busy}
              onClick={() => void run(async () => {
                const updated = await patchTripzProposal(conversationId, proposal.revision, {
                  title: quick.title || undefined,
                  client: { name: quick.clientName || undefined },
                  destination: quick.destination || undefined,
                  startDate: quick.startDate || undefined,
                  endDate: quick.endDate || undefined,
                  passengers: { adults: Number(quick.adults) || undefined }
                });
                onProposalChange(updated);
                await refreshPreview();
              })}>Salvar resumo</button>
          </fieldset>

          <fieldset className="grid gap-2 border-t border-[var(--border)] pt-3">
            <legend className="font-semibold">Investimento & pagamento</legend>
            <label>Valor total
              <input className="input" inputMode="decimal" value={investment} onChange={(event) => setInvestment(event.target.value)} />
            </label>
            <label>Condição de pagamento (1ª entrada)
              <input className="input" value={paymentLabel} onChange={(event) => setPaymentLabel(event.target.value)} />
            </label>
            <button type="button" className="btn" disabled={busy}
              onClick={() => void patchEditorial({
                commercial: {
                  ...(editorial(proposal.state).commercial ?? {}),
                  ...(investment ? { total: Number(investment.replace(",", ".")) || investment } : {}),
                  paymentEntries: paymentLabel ? [{ label: "Pagamento", value: paymentLabel }] : []
                }
              })}>Salvar investimento</button>
          </fieldset>

          {assignments.length ? (
            <fieldset className="grid gap-2 border-t border-[var(--border)] pt-3">
              <legend className="font-semibold">Fotos ({assignments.length})</legend>
              {assignments.map((assignment, index) => (
                <div key={`${assignment.targetId ?? assignment.mediaId ?? index}-${index}`} className="grid gap-1 rounded border border-[var(--border)] p-2">
                  <span className="font-medium">{assignment.role ?? "foto"}{assignment.targetId ? ` · ${assignment.targetId}` : ""}</span>
                  <label className="grid gap-1">
                    <span className="text-[11px] text-[var(--text-secondary)]">mediaId (anexo)</span>
                    <input className="input" defaultValue={assignment.mediaId ?? ""} onBlur={(event) => {
                      const nextMediaId = event.target.value.trim();
                      if (nextMediaId && nextMediaId !== assignment.mediaId) void replaceAssignmentPhoto(index, nextMediaId);
                    }} />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[11px] text-[var(--text-secondary)]">Trocar por URL</span>
                    <input className="input" placeholder="https://…" onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        const url = event.currentTarget.value.trim();
                        if (url) void run(async () => {
                          const media = await tripzMediaFromUrl(conversationId, { url, category: assignment.role ?? "other" });
                          await replaceAssignmentPhoto(index, media.mediaId);
                        });
                        event.currentTarget.value = "";
                      }
                    }} />
                  </label>
                  <label className="grid gap-1">
                    <span className="text-[11px] text-[var(--text-secondary)]">Upload local</span>
                    <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void run(async () => {
                        const attachment = await uploadTripzAttachment(conversationId, file);
                        await replaceAssignmentPhoto(index, attachment.id);
                      });
                      event.target.value = "";
                    }} />
                  </label>
                </div>
              ))}
            </fieldset>
          ) : null}

          <fieldset className="grid gap-2 border-t border-[var(--border)] pt-3">
            <legend className="font-semibold">Pedir alteração à IA</legend>
            <textarea className="input min-h-16" placeholder="Ex.: troque somente a foto da capa por uma mais ensolarada"
              value={instruction} onChange={(event) => setInstruction(event.target.value)} />
            <button type="button" className="btn" disabled={busy || !instruction.trim()}
              onClick={() => void run(async () => {
                const result = await sendTripzMessage(conversationId, { content: instruction.trim(), attachmentIds: [] });
                setInstruction("");
                if (result.proposal) onProposalChange(result.proposal);
                await refreshPreview();
                await refreshMeta();
              })}>Enviar pedido</button>
          </fieldset>

          {validation ? (
            <fieldset className="border-t border-[var(--border)] pt-3">
              <legend className="font-semibold">Validação</legend>
              {validation.issues.length ? (
                <ul className="mt-1 space-y-1">
                  {validation.issues.map((issue) => (
                    <li key={issue.code} className={`flex gap-1 ${issue.severity === "critical" ? "text-[var(--warning-text)]" : "text-[var(--text-secondary)]"}`}>
                      <WarningCircle size={12} weight="duotone" aria-hidden="true" />
                      <span>{issue.message}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1 flex gap-1 text-[var(--success-text)]"><CheckCircle size={12} weight="duotone" aria-hidden="true" /> Sem inconsistências</p>
              )}
              {validation.missingInformation.filter((field) => field.required).length ? (
                <p className="mt-2 text-[11px] text-[var(--warning-text)]">
                  Faltam dados obrigatórios: {validation.missingInformation.filter((field) => field.required).map((field) => field.label).join(", ")}
                </p>
              ) : null}
            </fieldset>
          ) : null}

          {error ? <p className="text-[var(--warning-text)]" role="alert">{error}</p> : null}
        </div>
      </aside>
    </div>
  );
}
