"use client";

import { Flask, Power } from "@phosphor-icons/react";
import Link from "next/link";
import { type ReactNode, useEffect, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { Shell } from "@/components/shell";
import {
  directPublicationMessage,
  pendingAgentReplay,
  preserveActiveFormAfterQueue,
  queuedCandidateMessage,
  type AgentSaveResponse,
  type PendingAgentReplay
} from "@/lib/agent-candidates";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";

type AgentForm = {
  systemPrompt: string;
  aiModel: string;
  openRouterProvider: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort: "low" | "medium" | "high";
  isActive: boolean;
  openRouterApiKey: string;
  clearOpenRouterApiKey: boolean;
  hasOpenRouterApiKey: boolean;
  mediaFallbackAudio: string;
  mediaFallbackImage: string;
  mediaFallbackDocument: string;
  enabledTools: string[];
};

type AgentResponse = {
  agent: {
    system_prompt: string;
    ai_model: string;
    openrouter_provider?: string | null;
    model_params: { temperature?: number; max_tokens?: number; reasoning_effort?: "low" | "medium" | "high" };
    is_active: boolean;
    has_openrouter_api_key: boolean;
    media_fallback_audio: string;
    media_fallback_image: string;
    media_fallback_document: string;
    enabled_tools?: string[];
  } | null;
  available_tools?: string[];
  evaluator_enabled?: boolean;
  template_status?: {
    available: boolean;
    diverged: boolean;
    candidateVersionId: string | null;
    templateCharacters: number;
  } | null;
};

export default function Agent() {
  const canManage = usePermission("agent.manage");
  const [form, setForm] = useState<AgentForm>();
  const [savedForm, setSavedForm] = useState<AgentForm>();
  const [reviewSave, setReviewSave] = useState(false);
  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [dirtyState, setDirty] = useState(false);
  const dirty = dirtyState && canManage;
  const [state, setState] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  const [templateStatus, setTemplateStatus] = useState<NonNullable<AgentResponse["template_status"]>>();
  const [templateAction, setTemplateAction] = useState("");
  const [pendingReplay, setPendingReplay] = useState<PendingAgentReplay>();
  const [savingCandidate, setSavingCandidate] = useState(false);
  const [evaluatorEnabled, setEvaluatorEnabled] = useState(true);
  const [stateTone, setStateTone] = useState<"info" | "success" | "error">("info");

  useEffect(() => {
    api<AgentResponse>("/agent")
      .then(({ agent, available_tools: tools, template_status: nextTemplateStatus, evaluator_enabled: nextEvaluatorEnabled }) => {
        if (!agent) throw new Error("Agente não configurado");
        setAvailableTools(tools ?? []);
        const loadedForm: AgentForm = {
          systemPrompt: agent.system_prompt,
          aiModel: agent.ai_model,
          openRouterProvider: agent.openrouter_provider ?? "",
          temperature: agent.model_params.temperature ?? 0.4,
          maxTokens: agent.model_params.max_tokens ?? 512,
          reasoningEffort: agent.model_params.reasoning_effort ?? "medium",
          isActive: agent.is_active,
          openRouterApiKey: "",
          clearOpenRouterApiKey: false,
          hasOpenRouterApiKey: agent.has_openrouter_api_key,
          mediaFallbackAudio: agent.media_fallback_audio,
          mediaFallbackImage: agent.media_fallback_image,
          mediaFallbackDocument: agent.media_fallback_document,
          enabledTools: agent.enabled_tools ?? []
        };
        setForm(loadedForm);
        setSavedForm(loadedForm);
        setTemplateStatus(nextTemplateStatus ?? undefined);
        setEvaluatorEnabled(nextEvaluatorEnabled ?? true);
      })
      .catch((error: unknown) => {
        setStateTone("error");
        setState(error instanceof Error ? error.message : "Erro ao carregar o agente");
      })
      .finally(() => setLoaded(true));
  }, []);

  function change(values: Partial<AgentForm>) {
    if (form && canManage) {
      setForm({ ...form, ...values });
      setDirty(true);
    }
  }

  async function save() {
    if (!form || !canManage) return;
    setReviewSave(false);
    setSavingCandidate(true);
    setStateTone("info");
    setState(evaluatorEnabled ? "Criando candidata e iniciando replay…" : "Publicando sem avaliação…");
    try {
      const response = await api<AgentSaveResponse>("/agent", {
        method: "PUT",
        body: JSON.stringify(form)
      });
      if (response.status === "published") {
        setForm(form);
        setSavedForm(form);
        setPendingReplay(undefined);
        setDirty(false);
        setStateTone("success");
        setState(directPublicationMessage("manual"));
        return;
      }
      const activeForm = savedForm
        ? preserveActiveFormAfterQueue(savedForm, form)
        : form;
      setForm(activeForm);
      setSavedForm(activeForm);
      setPendingReplay(pendingAgentReplay(response, "manual"));
      setDirty(false);
      setStateTone("success");
      setState(queuedCandidateMessage("manual"));
    } catch (error) {
      setStateTone("error");
      setState(error instanceof Error ? error.message : "Erro ao salvar");
    } finally {
      setSavingCandidate(false);
    }
  }

  async function toggleAgent() {
    if (!form || changingStatus || !canManage) return;
    const next = !form.isActive;
    if (!next && !window.confirm("Desativar totalmente a IA? Novas mensagens continuarão registradas, mas não receberão resposta automática.")) return;
    setChangingStatus(true);
    setState("");
    try {
      await api("/agent/status", { method: "PATCH", body: JSON.stringify({ isActive: next }) });
      setForm((current) => current ? { ...current, isActive: next } : current);
      setSavedForm((current) => current ? { ...current, isActive: next } : current);
      setStateTone("success");
      setState(next ? "IA ativada" : "IA totalmente desativada");
    } catch (error) {
      setStateTone("error");
      setState(error instanceof Error ? error.message : "Erro ao alterar o status da IA");
    } finally {
      setChangingStatus(false);
    }
  }

  function toggleTool(name: string) {
    if (!form) return;
    change({
      enabledTools: form.enabledTools.includes(name)
        ? form.enabledTools.filter((tool) => tool !== name)
        : [...form.enabledTools, name]
    });
  }

  async function createTemplateCandidateVersion() {
    if (!canManage || templateAction) return;
    setTemplateAction(evaluatorEnabled ? "Criando versão candidata…" : "Publicando template…");
    setState("");
    try {
      const response = await api<AgentSaveResponse>("/agent/template-candidate", { method: "POST" });
      if (response.status === "published") {
        setTemplateStatus((current) => current
          ? { ...current, diverged: false, candidateVersionId: null }
          : current);
        setPendingReplay(undefined);
        setStateTone("success");
        setState(directPublicationMessage("template"));
        return;
      }
      setTemplateStatus((current) => current
        ? { ...current, candidateVersionId: response.candidateVersionId }
        : current);
      setPendingReplay(pendingAgentReplay(response, "template"));
      setStateTone("success");
      setState(queuedCandidateMessage("template"));
    } catch (error) {
      setStateTone("error");
      setState(error instanceof Error ? error.message : "Erro ao criar a versão candidata");
    } finally {
      setTemplateAction("");
    }
  }

  return (
    <Shell>
      <header className="pagehead">
        <div>
          <h1>Agente principal</h1>
          <p>Defina o escopo, o provedor e as respostas automáticas.</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link className="btn" href="/agente/melhorias"><Flask size={16} aria-hidden="true" />Melhoria contínua</Link>
          <span className={`mono rounded-full border px-3 py-2 text-[10px] font-semibold uppercase tracking-[.12em] ${form?.isActive ? "border-[var(--border-ai)] text-[var(--accent-soft)]" : "border-[var(--warn-border)] text-[var(--warn)]"}`}>
            {form?.isActive ? "IA ligada" : "IA desligada"}
          </span>
          <button type="button" className={`btn active:scale-[.98] ${form?.isActive ? "warn" : "primary"}`} disabled={!canManage || !form || changingStatus} onClick={toggleAgent}>
            <Power size={16} aria-hidden="true" />
            {changingStatus ? "Alterando…" : form?.isActive ? "Desativar IA" : "Ativar IA"}
          </button>
          <button type="button" className="btn primary active:scale-[.98]" disabled={!canManage || !dirty || !form || savingCandidate || form.enabledTools.length === 0} onClick={() => setReviewSave(true)}>
            {savingCandidate
              ? evaluatorEnabled ? "Criando candidata…" : "Publicando…"
              : evaluatorEnabled ? "Salvar como candidata" : "Salvar e publicar"}
          </button>
        </div>
      </header>

      {loaded && form && !canManage ? <p className="sub mb-4" role="status">Acesso somente leitura. As configurações e o estado da IA não podem ser alterados.</p> : null}
      {pendingReplay ? <PendingReplayNotice replay={pendingReplay} /> : null}
      {loaded && form && templateStatus?.available && templateStatus.diverged ? (
        <section className="mb-5 flex flex-wrap items-center justify-between gap-4 border border-[var(--warn-border)] bg-[var(--warn-bg)] p-4" role="status">
          <div>
            <strong className="block text-sm text-[var(--heading)]">O template versionado diverge do prompt ativo</strong>
            <p className="sub mt-1 text-xs">
              {evaluatorEnabled
                ? `O template possui ${templateStatus.templateCharacters} caracteres. A ação cria uma candidata e inicia o replay; o prompt ativo permanece inalterado até os gates serem aprovados e a publicação ser confirmada.`
                : `O template possui ${templateStatus.templateCharacters} caracteres e será publicado diretamente enquanto o avaliador estiver desativado.`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!templateStatus.candidateVersionId ? (
              <button type="button" className="btn" disabled={!canManage || Boolean(templateAction)} onClick={() => void createTemplateCandidateVersion()}>
                {templateAction || (evaluatorEnabled ? "Criar candidata e executar replay" : "Publicar template")}
              </button>
            ) : (
              <Link className="btn primary" href="/agente/melhorias">Acompanhar replay</Link>
            )}
          </div>
        </section>
      ) : null}
      {!loaded ? (
        <div className="skeleton h-96" aria-hidden="true" />
      ) : !form ? (
        <p className="error" role="alert">{state}</p>
      ) : (
        <fieldset className="contents" disabled={!canManage}>
          <div className="agent-layout">
            <section className="agent-main">
              <div className="flex min-h-[520px] flex-col">
                <div className="cardtitle">
                  <span><label htmlFor="agent-system-prompt">Instruções do agente</label> <small className="mono ml-2 text-[10px] text-[var(--faint)]">system_prompt</small></span>
                  <span className="mono text-[10px] text-[var(--faint)]">{form.systemPrompt.length} caracteres</span>
                </div>
                <textarea id="agent-system-prompt" className="input min-h-96 flex-1 resize-none leading-relaxed" value={form.systemPrompt} onChange={(event) => change({ systemPrompt: event.target.value })} />
                <p className="sub mt-3">Proteções contra injeção de prompt, fuga de contexto e exposição de dados continuam ativas automaticamente. O comportamento do atendimento vem do que você escrever aqui.</p>
              </div>
              <div className="line-section grid gap-4">
                <div className="cardtitle mb-0">Ferramentas habilitadas</div>
                <p className="sub">O agente só enxerga e executa as ferramentas selecionadas.</p>
                <div className="grid gap-2 md:grid-cols-2">
                  {availableTools.map((tool) => (
                    <label key={tool} className="flex items-center gap-2 rounded border border-[var(--border)] p-3 text-xs">
                      <input type="checkbox" checked={form.enabledTools.includes(tool)} onChange={() => toggleTool(tool)} />
                      <span className="mono">{tool}</span>
                    </label>
                  ))}
                </div>
                <div className="cardtitle mb-0 mt-4">Respostas para mídia</div>
                <Field label="Áudio"><textarea className="input min-h-20 resize-y" value={form.mediaFallbackAudio} onChange={(event) => change({ mediaFallbackAudio: event.target.value })} /></Field>
                <Field label="Imagem"><textarea className="input min-h-20 resize-y" value={form.mediaFallbackImage} onChange={(event) => change({ mediaFallbackImage: event.target.value })} /></Field>
                <Field label="Documento"><textarea className="input min-h-20 resize-y" value={form.mediaFallbackDocument} onChange={(event) => change({ mediaFallbackDocument: event.target.value })} /></Field>
              </div>
            </section>

            <aside className="agent-side">
              <section className="grid gap-4">
                <div className="cardtitle mb-0">OpenRouter</div>
                <Field label="Provider"><input className="input mono text-xs" placeholder="anthropic, openai, google..." value={form.openRouterProvider} onChange={(event) => change({ openRouterProvider: event.target.value })} /></Field>
                <Field label="Modelo"><input className="input mono text-xs" value={form.aiModel} onChange={(event) => change({ aiModel: event.target.value })} /></Field>
                <Field label="Chave da API"><input className="input mono text-xs" type="password" autoComplete="new-password" placeholder={form.hasOpenRouterApiKey ? "Chave configurada · digite para substituir" : "sk-or-v1-..."} value={form.openRouterApiKey} onChange={(event) => change({ openRouterApiKey: event.target.value, clearOpenRouterApiKey: false })} /></Field>
                {form.hasOpenRouterApiKey ? (
                  <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <input type="checkbox" checked={form.clearOpenRouterApiKey} onChange={(event) => change({ clearOpenRouterApiKey: event.target.checked, openRouterApiKey: "" })} />
                    Remover chave configurada
                  </label>
                ) : null}
                <p className="sub">Informe o slug do provider da OpenRouter. Em branco, mantém o roteamento automático/global.</p>
                <p className="sub">A chave é criptografada no servidor e nunca é retornada ao navegador.</p>
              </section>
              <section className="line-section grid gap-5">
                <div className="cardtitle mb-0">Parâmetros</div>
                <Field label="Nível de raciocínio">
                  <select className="input" value={form.reasoningEffort} onChange={(event) => change({ reasoningEffort: event.target.value as AgentForm["reasoningEffort"] })}>
                    <option value="low">Baixo, mais rápido</option>
                    <option value="medium">Médio, recomendado</option>
                    <option value="high">Alto, mais criterioso</option>
                  </select>
                  <small className="sub">Aplicado a modelos compatíveis. Níveis maiores podem aumentar o tempo e o consumo de tokens.</small>
                </Field>
                <label className="field">
                  <span className="flex justify-between"><span>Temperatura</span><b className="mono text-xs accent">{form.temperature.toFixed(1)}</b></span>
                  <input type="range" min="0" max="2" step="0.1" value={form.temperature} onChange={(event) => change({ temperature: Number(event.target.value) })} />
                </label>
                <label className="field">
                  <span className="flex justify-between"><span>Máx. tokens por resposta</span><b className="mono text-xs accent">{form.maxTokens}</b></span>
                  <input type="range" min="64" max="8192" step="64" value={form.maxTokens} onChange={(event) => change({ maxTokens: Number(event.target.value) })} />
                </label>
              </section>
              {state ? <p className={stateTone === "error" ? "error" : stateTone === "success" ? "accent" : "sub"} role="status" aria-live="polite">{state}</p> : null}
            </aside>
          </div>
        </fieldset>
      )}

      {reviewSave && form && savedForm ? (
        <ModalDialog labelledBy="agent-save-review" describedBy="agent-save-description" onClose={() => setReviewSave(false)}>
          <h2 id="agent-save-review">{evaluatorEnabled ? "Criar candidata para replay" : "Publicar sem avaliação"}</h2>
          <p id="agent-save-description">
            {evaluatorEnabled
              ? "Revise o resumo. Ao confirmar, uma candidata imutável será criada e testada; a configuração ativa continuará inalterada até a aprovação e publicação."
              : "Revise o resumo. Ao confirmar, a configuração será publicada diretamente porque o avaliador está temporariamente desativado."}
          </p>
          <div className="diff-output">
            {agentChangeSummary(savedForm, form).map((item) => <div key={item}><strong>{item}</strong></div>)}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setReviewSave(false)}>Voltar</button>
            <button type="button" className="btn primary" onClick={() => void save()}>
              {evaluatorEnabled ? "Criar candidata e iniciar replay" : "Publicar agora"}
            </button>
          </div>
        </ModalDialog>
      ) : null}
    </Shell>
  );
}

function PendingReplayNotice({ replay }: { replay: PendingAgentReplay }) {
  return (
    <section className="mb-5 grid gap-3 border border-[var(--border-ai)] bg-[var(--panel)] p-4 md:grid-cols-[1fr_auto] md:items-center" role="status" aria-live="polite">
      <div>
        <strong className="block text-sm text-[var(--heading)]">Candidata salva; replay pendente</strong>
        <p className="sub mt-1 text-xs">
          {replay.source === "template"
            ? "O prompt ativo continua inalterado."
            : "A configuração ativa continua inalterada."} A candidata só poderá ser publicada depois de passar pelos gates do replay.
        </p>
        <p className="mono mt-2 text-[10px] text-[var(--faint)]">
          candidata {replay.candidateVersionId.slice(0, 8)} · run {replay.runId.slice(0, 8)}
        </p>
      </div>
      <Link className="btn primary active:scale-[.98]" href="/agente/melhorias">Acompanhar replay</Link>
    </section>
  );
}

function agentChangeSummary(before: AgentForm, after: AgentForm): string[] {
  const changes: string[] = [];
  if (before.systemPrompt !== after.systemPrompt) changes.push(`Prompt: ${before.systemPrompt.length} → ${after.systemPrompt.length} caracteres`);
  if (before.aiModel !== after.aiModel) changes.push(`Modelo: ${before.aiModel} → ${after.aiModel}`);
  if (before.openRouterProvider !== after.openRouterProvider) changes.push("Roteamento do provider alterado");
  if (before.temperature !== after.temperature) changes.push(`Temperatura: ${before.temperature} → ${after.temperature}`);
  if (before.reasoningEffort !== after.reasoningEffort) changes.push(`Raciocínio: ${before.reasoningEffort} → ${after.reasoningEffort}`);
  if (before.maxTokens !== after.maxTokens) changes.push(`Máximo de tokens: ${before.maxTokens} → ${after.maxTokens}`);
  if (JSON.stringify([...before.enabledTools].sort()) !== JSON.stringify([...after.enabledTools].sort())) changes.push(`Ferramentas: ${before.enabledTools.length} → ${after.enabledTools.length}`);
  if (before.mediaFallbackAudio !== after.mediaFallbackAudio || before.mediaFallbackImage !== after.mediaFallbackImage || before.mediaFallbackDocument !== after.mediaFallbackDocument) changes.push("Respostas de mídia alteradas");
  if (after.openRouterApiKey || after.clearOpenRouterApiKey) changes.push(after.clearOpenRouterApiKey ? "Chave da API será removida" : "Chave da API será substituída");
  return changes;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span className="label">{label}</span>{children}</label>;
}
