"use client";

// R14 — Central de importação de contatos: wizard enxuto de 3 passos
// (Enviar arquivo → Mapear colunas → Revisar/Importar) com o mapa visual em
// FlowConnect. CSV é parseado no cliente (prévia de 5 linhas + mapeamento
// offline); XLSX depende do contrato pendente de preview no backend.
// Submissão fala o contrato real (POST /contact-ops/import, base64 + mapping
// objeto); histórico segue pendente e é omitido sem o endpoint.

import { ArrowClockwise, ArrowLeft, DownloadSimple, UploadSimple, Warning } from "@/components/icons";
import { useEffect, useMemo, useState, type ChangeEvent } from "react";
import { Empty } from "@/components/page-state";
import { FlowConnect } from "@/components/flow-connect";
import { Shell } from "@/components/shell";
import { Badge, Button, HelpHint, IconButton, SaveButton, SaveToast, useSaveFeedback } from "@/components/ui";
import { api } from "@/lib/api";
import { formatPanelDateTime } from "@/lib/format";
import {
  IMPORT_DUPLICATE_OPTIONS,
  IMPORT_ERRORS_FILENAME,
  IMPORT_FIELDS,
  IMPORT_HISTORY_PATH,
  IMPORT_TEMPLATE_FILENAME,
  autoMapColumns,
  buildImportErrorsCsv,
  buildImportTemplateCsv,
  importMappingMissingRequired,
  importResultLines,
  parseCsv,
  previewImportFile,
  submitImport,
  type ImportDuplicatePolicy,
  type ImportHistoryItem,
  type ImportHistoryResponse,
  type ImportMapping,
  type ImportPreview,
  type ImportResult
} from "@/lib/lead-import";
import { usePermission } from "@/lib/use-permission";
import styles from "./importar.module.css";

type ImportStep = "upload" | "map" | "review";

const MAX_VISIBLE_LINES = 50;
const PREVIEW_ROW_LIMIT = 5;

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Falha ao ler o arquivo"));
    reader.readAsText(file, "utf-8");
  });
}

function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function ImportContactsPage() {
  const canImport = usePermission("leads.create");
  const [step, setStep] = useState<ImportStep>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [fileKind, setFileKind] = useState<"csv" | "xlsx" | null>(null);
  const [mapping, setMapping] = useState<ImportMapping>([]);
  const [duplicatePolicy, setDuplicatePolicy] = useState<ImportDuplicatePolicy>("skip");
  const [result, setResult] = useState<ImportResult | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [history, setHistory] = useState<ImportHistoryItem[] | null>(null);
  const save = useSaveFeedback();

  // Histórico só aparece se o backend expuser o endpoint; qualquer falha
  // (inclusive 404/contrato pendente) omite a seção silenciosamente.
  useEffect(() => {
    if (!canImport) return;
    let cancelled = false;
    api<ImportHistoryResponse>(IMPORT_HISTORY_PATH)
      .then((response) => {
        if (!cancelled) setHistory(response.imports ?? []);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [canImport]);

  const missingRequired = useMemo(() => importMappingMissingRequired(mapping), [mapping]);
  const lineCount = preview?.rows.length ?? 0;
  const stepItems = [
    { key: "upload", label: "Enviar arquivo", description: step === "upload" ? "Etapa atual · CSV ou XLSX" : "CSV ou XLSX" },
    { key: "map", label: "Mapear colunas", description: step === "map" ? "Etapa atual · campos do AtendON" : "Campos do AtendON" },
    { key: "review", label: "Revisar e importar", description: step === "review" ? "Etapa atual · conferência" : "Conferência e resultado" }
  ];

  function resetAll() {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setFileKind(null);
    setMapping([]);
    setDuplicatePolicy("skip");
    setResult(null);
    setImporting(false);
    setError("");
    setFeedback("");
  }

  function handleTemplateDownload() {
    downloadFile(IMPORT_TEMPLATE_FILENAME, buildImportTemplateCsv());
    setFeedback(`Template ${IMPORT_TEMPLATE_FILENAME} baixado.`);
  }

  async function handleFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setError("");
    setFeedback("");
    setResult(null);
    const isXlsx = /\.xlsx$/i.test(selected.name) || selected.type.includes("spreadsheet");
    try {
      if (isXlsx) {
        // XLSX: parsing é do backend (contrato pendente). Sem o endpoint a UI
        // falha com instrução clara em vez de quebrar.
        const serverPreview = await previewImportFile(selected, selected.name);
        applyPreview(serverPreview, "xlsx", selected);
      } else {
        const text = await readFileAsText(selected);
        applyPreview(parseCsv(text), "csv", selected);
      }
    } catch (loadError) {
      setPreview(null);
      setFile(null);
      setFileKind(null);
      setStep("upload");
      setError(
        isXlsx
          ? "Não foi possível pré-visualizar o XLSX (o parsing no servidor ainda não está disponível). Enquanto isso, exporte a planilha como CSV e importe o CSV."
          : loadError instanceof Error
            ? loadError.message
            : "Falha ao ler o arquivo"
      );
    } finally {
      event.target.value = "";
    }
  }

  function applyPreview(next: ImportPreview, kind: "csv" | "xlsx", selected: File) {
    if (!next.headers.length) throw new Error("O arquivo não tem cabeçalho para mapear.");
    setFile(selected);
    setFileKind(kind);
    setPreview({ headers: next.headers, rows: next.rows.slice(0, PREVIEW_ROW_LIMIT) });
    setMapping(autoMapColumns(next.headers));
    setResult(null);
    setError("");
    setStep("map");
  }

  function setColumnMapping(columnIndex: number, fieldId: ImportMapping[number]) {
    setMapping((current) => current.map((entry, index) => (index === columnIndex ? fieldId : entry)));
  }

  async function runImport() {
    if (!file || !preview || importing) return;
    setImporting(true);
    setError("");
    setFeedback("");
    try {
      const response = await submitImport({ file, filename: file.name, headers: preview.headers, mapping, onDuplicate: duplicatePolicy });
      setResult(response);
      setFeedback("Importação concluída.");
      save.markDone();
    } catch (importError) {
      setError(
        importError instanceof Error
          ? importError.message
          : "Falha na importação — verifique se o backend de importação já está disponível."
      );
    } finally {
      setImporting(false);
    }
  }

  const resultLines = result ? importResultLines(result) : [];
  const visibleLines = resultLines.slice(0, MAX_VISIBLE_LINES);
  const hiddenLines = resultLines.length - visibleLines.length;

  if (!canImport) {
    return (
      <Shell>
        <div className="lead-detail-page">
          <header><h1>Importar contatos</h1></header>
          <Empty>Você não tem permissão para importar contatos.</Empty>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="leads-page">
        <header className="leads-page__header">
          <div>
            <h1>Importar contatos</h1>
            <p className="sub">Central de importação CSV/XLSX com sinalização de possíveis duplicados.</p>
          </div>
        </header>
        {error ? <p className="error mb-4" role="alert">{error}</p> : null}
        {feedback ? <p className="accent mb-4" role="status" aria-live="polite">{feedback}</p> : null}

        <section className={`card ${styles.flowCard}`} aria-label="Passos da importação">
          <FlowConnect items={stepItems} />
        </section>

        {step === "upload" ? (
          <section className="card" aria-labelledby="upload-step-title">
            <div id="upload-step-title" className="cardtitle">Enviar arquivo</div>
            <p className="sub">
              CSV ou XLSX com uma linha por contato. Baixe o template oficial — ele já traz as
              colunas canônicas e exemplos — e mapeie as suas colunas na próxima etapa.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="field m-0">
                <span className="label">Arquivo CSV ou XLSX</span>
                <input
                  className="input"
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={handleFile}
                  aria-label="Arquivo CSV ou XLSX para importação"
                />
              </label>
              <IconButton label="Baixar template CSV" onClick={handleTemplateDownload}>
                <DownloadSimple size={16} aria-hidden="true" />
              </IconButton>
            </div>
          </section>
        ) : null}

        {step === "map" && preview ? (
          <section className="card" aria-labelledby="map-step-title">
            <div id="map-step-title" className="cardtitle">Mapear colunas</div>
            <p className="sub">
              {file?.name} ({fileKind === "xlsx" ? "XLSX" : "CSV"}) · {lineCount} linha(s) detectada(s) · prévia das {preview.rows.length} primeiras.
              O telefone é obrigatório: é a identidade usada na detecção de duplicados.
            </p>
            <div className={`${styles.mapTable} responsive-table-wrap`}>
              <table className="responsive-table">
                <thead>
                  <tr><th>Coluna do arquivo</th><th>Campo do AtendON</th></tr>
                </thead>
                <tbody>
                  {preview.headers.map((header, columnIndex) => (
                    <tr key={`${header}-${columnIndex}`}>
                      <td data-label="Coluna" className="mono">{header || "(sem nome)"}</td>
                      <td data-label="Campo">
                        <select
                          className="input"
                          value={mapping[columnIndex] ?? ""}
                          onChange={(event) => setColumnMapping(columnIndex, event.target.value as ImportMapping[number])}
                          aria-label={`Campo para a coluna ${header || columnIndex + 1}`}
                        >
                          <option value="">Ignorar coluna</option>
                          {IMPORT_FIELDS.map((field) => {
                            const taken = mapping.some((entry, index) => index !== columnIndex && entry === field.id);
                            return (
                              <option key={field.id} value={field.id} disabled={taken}>
                                {field.label}{field.required ? " (obrigatório)" : ""}{taken ? " — já mapeado" : ""}
                              </option>
                            );
                          })}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="sub">
              Colunas sem destino no AtendON (ex.: unidade, categoria, parceiro e observação do template) serão ignoradas nesta importação.
            </p>
            {preview.rows.length ? (
              <div className={`${styles.previewTable} responsive-table-wrap`}>
                <table className="responsive-table">
                  <thead>
                    <tr>{preview.headers.map((header, index) => <th key={`${header}-${index}`}>{header || `Coluna ${index + 1}`}</th>)}</tr>
                  </thead>
                  <tbody>
                    {preview.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
            <fieldset className={styles.policy}>
              <legend className="label flex flex-wrap items-center gap-1">Duplicados (mesmo telefone) <HelpHint label="Ajuda: Duplicados (mesmo telefone)" title="Duplicados">O que fazer quando uma linha traz um telefone que já existe na base: pular a linha, atualizar o contato existente ou importá-lo marcado como possível duplicado.</HelpHint></legend>
              <div className={styles.policyOptions}>
                {IMPORT_DUPLICATE_OPTIONS.map((option) => (
                  <label key={option.id} className={styles.policyOption}>
                    <input
                      type="radio"
                      name="on_duplicate"
                      value={option.id}
                      checked={duplicatePolicy === option.id}
                      onChange={() => setDuplicatePolicy(option.id)}
                    />
                    <span><strong>{option.label}</strong><small>{option.description}</small></span>
                  </label>
                ))}
              </div>
            </fieldset>
            {missingRequired.length ? (
              <p className="error" role="alert">Mapeie a coluna de {IMPORT_FIELDS.find((field) => missingRequired.includes(field.id))?.label ?? "telefone"}.</p>
            ) : null}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <IconButton label="Voltar" onClick={() => setStep("upload")}><ArrowLeft size={16} aria-hidden="true" /></IconButton>
              <Button tone="primary" disabled={missingRequired.length > 0} onClick={() => setStep("review")}>
                Continuar para revisão
              </Button>
            </div>
          </section>
        ) : null}

        {step === "review" && preview && file ? (
          <section className="card" aria-labelledby="review-step-title">
            <div id="review-step-title" className="cardtitle">Revisar e importar <HelpHint label="Ajuda: Revisar e importar" title="Resultado da importação">Ao terminar, o resultado separa contatos criados, atualizados a partir de telefones já existentes, ignorados pela política de duplicados e marcados como possível duplicado.</HelpHint></div>
            <dl className="mb-4 grid gap-3 text-sm md:grid-cols-2">
              <div><dt className="label">Arquivo</dt><dd className="mono mt-1">{file.name}</dd></div>
              <div><dt className="label">Linhas detectadas</dt><dd className="mt-1">{lineCount}</dd></div>
              <div>
                <dt className="label">Mapeamento</dt>
                <dd className="mt-1">
                  {mapping
                    .map((entry, index) => ({ entry, index }))
                    .filter((item) => item.entry !== "")
                    .map((item) => `${preview.headers[item.index]} → ${IMPORT_FIELDS.find((field) => field.id === item.entry)?.label ?? item.entry}`)
                    .join(" · ") || "Nenhuma coluna mapeada"}
                </dd>
              </div>
              <div>
                <dt className="label">Duplicados</dt>
                <dd className="mt-1">{IMPORT_DUPLICATE_OPTIONS.find((option) => option.id === duplicatePolicy)?.label}</dd>
              </div>
            </dl>
            {!result ? (
              <div className="flex flex-wrap items-center gap-2">
                <IconButton label="Voltar ao mapeamento" onClick={() => setStep("map")}><ArrowLeft size={16} aria-hidden="true" /></IconButton>
                <SaveButton state={importing ? "busy" : save.state} busyLabel="Importando…" doneLabel="Importado" icon={<UploadSimple size={16} aria-hidden="true" />} onClick={() => void runImport()} disabled={importing}>
                  {`Importar ${lineCount} contato(s)`}
                </SaveButton>
              </div>
            ) : (
              <div className="grid gap-4">
                <div className={styles.resultSummary}>
                  <span className="badge badge--success">{result.imported} importado(s)</span>
                  <span className="badge">{result.updated} atualizado(s)</span>
                  <span className="badge">{result.skipped} ignorado(s)</span>
                  <span className="badge badge--warning">{result.duplicates_flagged} possível(is) duplicado(s)</span>
                </div>
                {resultLines.length ? (
                  <div className={styles.resultLines}>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-xs">Erros por linha</strong>
                      <IconButton
                        size="sm"
                        label="Baixar CSV de erros"
                        onClick={() => downloadFile(IMPORT_ERRORS_FILENAME, buildImportErrorsCsv(result))}
                      >
                        <DownloadSimple size={14} aria-hidden="true" />
                      </IconButton>
                    </div>
                    <ul className={styles.resultLineList}>
                      {visibleLines.map((line) => (
                        <li key={line.line} className={styles.resultLine}>
                          <span className="mono">linha {line.line}</span>
                          <Badge tone="danger">erro</Badge>
                          <span className={styles.resultLineMessage}>{line.message || "—"}</span>
                        </li>
                      ))}
                    </ul>
                    {hiddenLines > 0 ? (
                      <p className="sub">
                        … {hiddenLines} linha(s) adicional(is) ocultas — baixe o CSV de erros para ver todas.
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="sub" role="status">Nenhum erro por linha reportado.</p>
                )}
                <IconButton label="Nova importação" onClick={resetAll}><ArrowClockwise size={16} aria-hidden="true" /></IconButton>
              </div>
            )}
          </section>
        ) : null}

        {history !== null ? (
          <section className="card" aria-labelledby="import-history-title">
            <div id="import-history-title" className="cardtitle">Histórico de importações</div>
            {history.length === 0 ? (
              <Empty>Nenhuma importação. Baixe o template CSV acima para começar.</Empty>
            ) : (
              <ul className={styles.historyList}>
                {history.map((item) => (
                  <li key={item.id} className={styles.historyItem}>
                    <Warning aria-hidden="true" className={styles.historyIcon} />
                    <div className="min-w-0">
                      <strong className="block truncate">{item.filename}</strong>
                      <span className="crm-caption">
                        {formatPanelDateTime(item.created_at, { dateStyle: "short", timeStyle: "short" }, "pt-BR")}
                        {item.actor_email ? ` · ${item.actor_email}` : ""}
                      </span>
                    </div>
                    <span className={styles.historyCounts}>
                      {item.imported} importado(s) · {item.updated} atualizado(s) · {item.skipped} ignorado(s) · {item.duplicates_flagged} duplicado(s)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
      <SaveToast show={save.done}>Importação concluída</SaveToast>
    </Shell>
  );
}
