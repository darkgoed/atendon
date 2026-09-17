"use client";

import { Power } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useState } from "react";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { usePermission } from "@/lib/use-permission";
import styles from "../channels-ai.module.css";

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
  scope?: "shared" | "connection";
};

export default function Agent() {
  const canManage = usePermission("agent.manage");
  const [form, setForm] = useState<AgentForm>();


  const [availableTools, setAvailableTools] = useState<string[]>([]);
  const [dirtyState, setDirty] = useState(false);
  const dirty = dirtyState && canManage;
  const [state, setState] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [changingStatus, setChangingStatus] = useState(false);
  // Alvo do prompt: "" = compartilhado por todos os números (padrão).
  const [connections, setConnections] = useState<Array<{ id: string; label: string; is_primary: boolean }>>([]);
  const [target, setTarget] = useState("");
  const [scope, setScope] = useState<"shared" | "connection">("shared");
  const [removingOverride, setRemovingOverride] = useState(false);
  const targetNeedsOverride = Boolean(target && scope === "shared");

  const [stateTone, setStateTone] = useState<"info" | "success" | "error">("info");

  useEffect(() => {
    api<{ connections?: Array<{ id: string; label: string; is_primary: boolean }> }>("/connections")
      .then(({ connections: list }) => setConnections(list ?? []))
      .catch(() => setConnections([]));
  }, []);

  useEffect(() => {
    setLoaded(false);
    api<AgentResponse>(target ? `/agent?session_id=${target}` : "/agent")
      .then(({ agent, available_tools: tools, scope: loadedScope }) => {
        if (!agent) throw new Error("Agente não configurado");
        setAvailableTools(tools ?? []);
        setScope(loadedScope ?? "shared");
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
        setDirty(false);


      })
      .catch((error: unknown) => {
        setStateTone("error");
        setState(error instanceof Error ? error.message : "Erro ao carregar o agente");
      })
      .finally(() => setLoaded(true));
  }, [target]);

  function change(values: Partial<AgentForm>) {
    if (form && canManage) {
      setForm({ ...form, ...values });
      setDirty(true);
    }
  }

  async function save() {
    if (!form || !canManage) return;
    setStateTone("info");
    setState("Salvando…");
    try {
      await api("/agent", {
        method: "PUT",
        body: JSON.stringify({ ...form, sessionId: target || null })
      });
      setForm(form);
      if (target) setScope("connection");

      setDirty(false);
      setStateTone("success");
      setState("Alterações salvas.");
    } catch (error) {
      setStateTone("error");
      setState(error instanceof Error ? error.message : "Erro ao salvar");
    }
  }

  async function toggleAgent() {
    if (!form || changingStatus || !canManage) return;
    const next = !form.isActive;
    if (!next && !window.confirm("Desativar totalmente a IA? Novas mensagens continuarão registradas, mas não receberão resposta automática.")) return;
    setChangingStatus(true);
    setState("");
    try {
      await api("/agent/status", { method: "PATCH", body: JSON.stringify({ isActive: next, sessionId: target || null }) });
      setForm((current) => current ? { ...current, isActive: next } : current);
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

  async function removeOverride() {
    if (!target || !canManage || removingOverride) return;
    if (!window.confirm("Remover o prompt exclusivo deste número? Ele volta a usar o prompt compartilhado.")) return;
    setRemovingOverride(true);
    try {
      await api(`/agent/override/${target}`, { method: "DELETE" });
      setScope("shared");
      setTarget("");
      setStateTone("success");
      setState("Prompt exclusivo removido. O número voltou ao prompt compartilhado.");
    } catch (error) {
      setStateTone("error");
      setState(error instanceof Error ? error.message : "Erro ao remover o prompt exclusivo");
    } finally {
      setRemovingOverride(false);
    }
  }


  return (
    <Shell><div className={`${styles.channelsAiPage} channels-ai-page`}>
      <header className="pagehead">
        <div>
          <h1>Agente principal</h1>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-3">
          {connections.length > 1 ? (
            <label className="flex items-center gap-2 text-sm">
              <span className="label">Prompt de</span>
              <select
                className="input"
                aria-label="Número que usa este prompt"
                value={target}
                onChange={(event) => setTarget(event.target.value)}
              >
                <option value="">Todos os números</option>
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.label}{connection.is_primary ? " (principal)" : ""}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <span className={`mono rounded-full border px-3 py-2 type-caption font-semibold uppercase tracking-[.12em] ${form?.isActive ? "border-[var(--primary-border)] text-[var(--primary-text)]" : "border-[var(--warning-border)] text-[var(--warning-text)]"}`}>
            {form?.isActive ? "IA ligada" : "IA desligada"}
          </span>
          <button type="button" className={`btn active:scale-[.98] ${form?.isActive ? "warn" : "primary"}`} disabled={!canManage || !form || changingStatus || targetNeedsOverride} onClick={toggleAgent}>
            <Power size={16} aria-hidden="true" />
            {changingStatus ? "Alterando…" : form?.isActive ? "Desativar IA" : "Ativar IA"}
          </button>
          <button type="button" className="btn primary active:scale-[.98]" disabled={!canManage || !dirty || !form || form.enabledTools.length === 0} onClick={() => void save()}>
            Salvar alterações
          </button>
        </div>
      </header>

      {target && connections.length > 1 ? (
        <p className="sub mb-4" role="status">
          {scope === "connection"
            ? "Este número tem um prompt exclusivo. Alterações aqui não afetam os demais."
            : "Mostrando o prompt compartilhado. Ao salvar, ele vira um prompt exclusivo deste número. Salve as alterações para criar um prompt exclusivo antes de alterar o status deste número."}
          {scope === "connection" && canManage ? (
            <>
              {" "}
              <button type="button" className="btn warn ml-2" disabled={removingOverride} onClick={() => void removeOverride()}>
                {removingOverride ? "Removendo…" : "Voltar ao prompt compartilhado"}
              </button>
            </>
          ) : null}
        </p>
      ) : null}

      {loaded && form && !canManage ? <p className="sub mb-4" role="status">Acesso somente leitura. As configurações e o estado da IA não podem ser alterados.</p> : null}

      {!loaded ? (
        <div className="skeleton channels-ai-skeleton--large" aria-hidden="true" />
      ) : !form ? (
        <p className="error" role="alert">{state}</p>
      ) : (
        <fieldset className="contents" disabled={!canManage}>
          <div className="agent-layout">
            <section className="agent-main">
              <div className="flex channels-ai-agent-editor flex-col">
                <div className="cardtitle channels-ai-section-title">
                  <span><label htmlFor="agent-system-prompt">Instruções do agente</label> <small className="mono ml-2 type-caption text-[var(--text-muted)]">system_prompt</small></span>
                  <span className="mono type-caption text-[var(--text-muted)]">{form.systemPrompt.length} caracteres</span>
                </div>
                <textarea id="agent-system-prompt" className="input channels-ai-prompt flex-1 resize-none leading-relaxed" value={form.systemPrompt} onChange={(event) => change({ systemPrompt: event.target.value })} />
                <p className="sub mt-3">Proteções contra injeção de prompt, fuga de contexto e exposição de dados continuam ativas automaticamente. O comportamento do atendimento vem do que você escrever aqui.</p>
              </div>
              <div className="line-section grid gap-4">
                <div className="cardtitle channels-ai-section-title">Ferramentas habilitadas</div>
                <p className="sub">O agente só enxerga e executa as ferramentas selecionadas.</p>
                <div className="grid gap-2 md:grid-cols-2">
                  {availableTools.map((tool) => (
                    <label key={tool} className="flex items-center gap-2 rounded border border-[var(--border)] p-3 text-xs">
                      <input type="checkbox" checked={form.enabledTools.includes(tool)} onChange={() => toggleTool(tool)} />
                      <span className="mono">{tool}</span>
                    </label>
                  ))}
                </div>
                <div className="cardtitle channels-ai-section-title">Respostas para mídia</div>
                <Field label="Áudio"><textarea className="input channels-ai-textarea-compact resize-y" value={form.mediaFallbackAudio} onChange={(event) => change({ mediaFallbackAudio: event.target.value })} /></Field>
                <Field label="Imagem"><textarea className="input channels-ai-textarea-compact resize-y" value={form.mediaFallbackImage} onChange={(event) => change({ mediaFallbackImage: event.target.value })} /></Field>
                <Field label="Documento"><textarea className="input channels-ai-textarea-compact resize-y" value={form.mediaFallbackDocument} onChange={(event) => change({ mediaFallbackDocument: event.target.value })} /></Field>
              </div>
            </section>

            <aside className="agent-side">
              <section className="grid gap-4">
                <div className="cardtitle channels-ai-section-title">OpenRouter</div>
                <Field label="Provider"><input className="input mono text-xs" placeholder="anthropic, openai, google..." value={form.openRouterProvider} onChange={(event) => change({ openRouterProvider: event.target.value })} /></Field>
                <Field label="Modelo"><input className="input mono text-xs" value={form.aiModel} onChange={(event) => change({ aiModel: event.target.value })} /></Field>
                <Field label="Chave da API"><input className="input mono text-xs" type="password" autoComplete="new-password" placeholder={form.hasOpenRouterApiKey ? "Chave configurada · digite para substituir" : "sk-or-v1-..."} value={form.openRouterApiKey} onChange={(event) => change({ openRouterApiKey: event.target.value, clearOpenRouterApiKey: false })} /></Field>
                {form.hasOpenRouterApiKey ? (
                  <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                    <input type="checkbox" checked={form.clearOpenRouterApiKey} onChange={(event) => change({ clearOpenRouterApiKey: event.target.checked, openRouterApiKey: "" })} />
                    Remover chave configurada
                  </label>
                ) : null}
                <p className="sub">Informe o slug do provider da OpenRouter. Em branco, mantém o roteamento automático/global.</p>
                <p className="sub">A chave é criptografada no servidor e nunca é retornada ao navegador.</p>
              </section>
              <section className="line-section grid gap-4">
                <div className="cardtitle channels-ai-section-title">Parâmetros</div>
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


    </div></Shell>
  );
}


function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span className="label">{label}</span>{children}</label>;
}
