"use client";

import {
  ArrowCounterClockwise,
  CheckCircle,
  Flask,
  Gauge,
  GitDiff,
  MagnifyingGlass,
  ShieldWarning,
  Sparkle,
  TestTube,
  XCircle,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ModalDialog } from "@/components/modal-dialog";
import { api } from "@/lib/api";
import {
  canPublishImprovementProposal,
  hasValidImprovementConfirmation,
  requiredImprovementConfirmation,
} from "@/lib/ai-improvement-ui";

type Tab = "overview" | "issues" | "proposals" | "cases" | "versions";
type Summary = {
  summary: {
    evaluations: number;
    overall_score: string;
    critical_failures: number;
    confirmed: number;
    rejected: number;
  };
  dimensions: Array<{ dimension: string; score: string }>;
  violations: Array<{ code: string; severity: string; count: number }>;
  trend: Array<{ day: string; overall_score: string; evaluations: number }>;
  operations: {
    handoffs: number;
    handoff_rate_percent: string | null;
    handoff_reasons: Record<string, number>;
    tool_errors: number;
    tool_limits: number;
    ai_errors: number;
    quality_signals: number;
    unversioned_agent_messages: number;
  };
  usage: Array<{
    purpose: string;
    calls: number;
    tokens: string;
    cost_usd: string;
  }>;
  version_metrics: Array<{
    version_id: string;
    evaluations: number;
    overall_score: string;
    critical_failures: number;
  }>;
  lifecycle: {
    generated: number;
    rejected: number;
    published: number;
    reverted: number;
    reverted_rate_percent: string | null;
    detection_to_confirmation_hours: string | null;
    detection_to_publication_hours: string | null;
  };
};
type Evaluation = {
  id: string;
  conversation_id: string;
  overall_score: number;
  has_critical_failure: boolean;
  summary: string;
  status: string;
  trigger: string;
  created_at: string;
  violations?: Array<{ code: string; severity: string }>;
};
type EvaluationDetail = {
  evaluation: Omit<Evaluation, "violations"> & {
    scores: Record<
      string,
      { score: number; rationale: string; evidenceMessageIds: string[] }
    >;
    violations: Array<{
      code: string;
      dimension: string;
      severity: string;
      confidence: number;
      detail: string;
      evidenceMessageIds: string[];
    }>;
  };
  evidence: Array<{
    id: string;
    sender: string;
    excerpt: string;
    created_at: string;
  }>;
};
type Proposal = {
  id: string;
  title: string;
  rationale: string;
  status: string;
  target_issue_codes: string[];
  baseline_version_number: number;
  candidate_version_number: number;
  latest_run_status?: string;
  created_at: string;
};
type RegressionCase = {
  id: string;
  name: string;
  description: string;
  severity: string;
  is_active: boolean;
  scenario: unknown;
  expected_behavior: unknown;
};
type Version = {
  id: string;
  version_number: number;
  source: string;
  status: string;
  ai_model: string;
  created_at: string;
  created_by_user_id?: string | null;
};
type EvaluatorSettings = {
  evaluator_model: string | null;
  ai_evaluations_enabled: boolean;
  ai_proposals_enabled: boolean;
  ai_publication_enabled: boolean;
};
type ProposalDetail = {
  proposal: Proposal & {
    expected_impact: Record<string, unknown>;
    evidence_evaluation_ids: string[];
    baseline_version: Record<string, unknown>;
    candidate_version: Record<string, unknown>;
  };
  runs: Array<{
    id: string;
    status: string;
    aggregate_metrics: unknown;
    estimated_cost_usd: string;
    case_count: number;
  }>;
  caseResults: Array<{
    id: string;
    case_name: string;
    severity: string;
    passed: boolean;
    baseline_score: number;
    candidate_score: number;
    failure_reasons: string[];
  }>;
};
type CandidateDraft = {
  proposalId: string;
  systemPrompt: string;
  aiModel: string;
  temperature: number;
  maxTokens: number;
  reasoningEffort: "low" | "medium" | "high";
  enabledTools: string[];
  note: string;
};
type VersionDiff = { diff?: Record<string, unknown> };

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Visão geral" },
  { id: "issues", label: "Problemas" },
  { id: "proposals", label: "Propostas" },
  { id: "cases", label: "Casos de teste" },
  { id: "versions", label: "Versões" },
];
const dimensionLabels: Record<string, string> = {
  correctness: "Correção",
  task_completion: "Conclusão",
  continuity: "Continuidade",
  communication: "Comunicação",
  security_privacy: "Segurança",
  tool_usage: "Ferramentas",
  handoff: "Handoff",
};
const emptyCaseDraft = () => ({
  name: "",
  description: "",
  severity: "high",
  scenario: JSON.stringify(
    {
      history: [],
      targetMessage: "",
      fixedTime: new Date().toISOString(),
      context: {},
    },
    null,
    2,
  ),
  expectedBehavior: JSON.stringify(
    {
      required: [],
      forbidden: [],
      targetDimensions: ["continuity"],
      simulatedTools: [],
    },
    null,
    2,
  ),
});

export function ImprovementConsole() {
  const [tab, setTab] = useState<Tab>("overview");
  const [summary, setSummary] = useState<Summary>();
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [evaluationTotal, setEvaluationTotal] = useState(0);
  const [evaluationLoading, setEvaluationLoading] = useState(false);
  const [evaluationDetail, setEvaluationDetail] = useState<EvaluationDetail>();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [cases, setCases] = useState<RegressionCase[]>([]);
  const [versions, setVersions] = useState<Version[]>([]);
  const [settings, setSettings] = useState<EvaluatorSettings>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [issueFilter, setIssueFilter] = useState("");
  const [evaluationPage, setEvaluationPage] = useState(0);
  const [dialog, setDialog] = useState<{
    kind: "review" | "reject" | "publish" | "rollback";
    id: string;
    title: string;
  } | null>(null);
  const [dialogNote, setDialogNote] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [diff, setDiff] = useState<VersionDiff>();
  const [diffTarget, setDiffTarget] = useState("");
  const [diffAgainst, setDiffAgainst] = useState("");
  const [caseForm, setCaseForm] = useState(false);
  const [editingCaseId, setEditingCaseId] = useState("");
  const [caseDraft, setCaseDraft] = useState(emptyCaseDraft);
  const [casePreview, setCasePreview] = useState<unknown>();
  const [proposalDetail, setProposalDetail] = useState<ProposalDetail>();
  const [candidateDraft, setCandidateDraft] = useState<CandidateDraft>();
  const [availableTools, setAvailableTools] = useState<string[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [
        quality,
        proposalData,
        caseData,
        versionData,
        settingsData,
        agentData,
      ] = await Promise.all([
        api<Summary>("/agent/quality/summary"),
        api<{ proposals: Proposal[] }>("/agent/improvement-proposals"),
        api<{ cases: RegressionCase[] }>("/agent/regression-cases"),
        api<{ versions: Version[] }>("/agent/versions"),
        api<{ settings: EvaluatorSettings }>("/agent/evaluator-settings"),
        api<{ available_tools: string[] }>("/agent"),
      ]);
      setSummary(quality);
      setProposals(proposalData.proposals);
      setCases(caseData.cases);
      setVersions(versionData.versions);
      setSettings(settingsData.settings);
      setAvailableTools(agentData.available_tools ?? []);
      setDiffTarget(versionData.versions[0]?.id ?? "");
      setDiffAgainst(versionData.versions[1]?.id ?? "");
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível carregar a melhoria contínua",
      );
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (caseForm && !editingCaseId) {
      setCaseDraft(emptyCaseDraft());
      setCasePreview(undefined);
    }
  }, [caseForm, editingCaseId]);

  const loadEvaluations = useCallback(async () => {
    setEvaluationLoading(true);
    try {
      const query = new URLSearchParams({
        limit: "20",
        offset: String(evaluationPage * 20),
      });
      if (statusFilter) query.set("status", statusFilter);
      if (issueFilter) query.set("issue", issueFilter);
      const data = await api<{ evaluations: Evaluation[]; total: number }>(
        `/agent/evaluations?${query}`,
      );
      setEvaluations(data.evaluations);
      setEvaluationTotal(data.total);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível carregar as avaliações",
      );
    } finally {
      setEvaluationLoading(false);
    }
  }, [evaluationPage, issueFilter, statusFilter]);
  useEffect(() => {
    void loadEvaluations();
  }, [loadEvaluations]);

  const evaluationPageCount = Math.max(1, Math.ceil(evaluationTotal / 20));
  const issueCodes = useMemo(
    () =>
      Array.from(
        new Set([
          ...(summary?.violations.map((item) => item.code) ?? []),
          ...evaluations.flatMap(
            (item) => item.violations?.map((v) => v.code) ?? [],
          ),
        ]),
      ).sort(),
    [evaluations, summary?.violations],
  );
  const activeVersion = versions.find((version) => version.status === "active");
  const latestTrend = summary?.trend.at(-1);
  const totalCost =
    summary?.usage.reduce((total, item) => total + Number(item.cost_usd), 0) ??
    0;

  async function action(
    key: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    setBusy(key);
    setError("");
    try {
      await operation();
      await Promise.all([load(), loadEvaluations()]);
      return true;
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "A ação não foi concluída",
      );
      return false;
    } finally {
      setBusy("");
    }
  }
  async function saveSettings() {
    if (!settings) return;
    await action("settings", () =>
      api("/agent/evaluator-settings", {
        method: "PUT",
        body: JSON.stringify({
          evaluatorModel: settings.evaluator_model || null,
          automaticEnabled: settings.ai_evaluations_enabled,
          proposalsEnabled: settings.ai_proposals_enabled,
          publicationEnabled: settings.ai_publication_enabled,
        }),
      }),
    );
  }
  async function generateProposal(evaluationId: string) {
    await action(`generate:${evaluationId}`, () =>
      api("/agent/improvement-proposals/generate", {
        method: "POST",
        body: JSON.stringify({ evaluationId }),
      }),
    );
  }
  async function runProposal(id: string) {
    await action(`test:${id}`, () =>
      api(`/agent/improvement-proposals/${id}/test`, {
        method: "POST",
        body: "{}",
      }),
    );
  }
  async function inspectProposal(id: string) {
    if (proposalDetail?.proposal.id === id) {
      setProposalDetail(undefined);
      return;
    }
    await action(`detail:${id}`, async () =>
      setProposalDetail(
        await api<ProposalDetail>(`/agent/improvement-proposals/${id}`),
      ),
    );
  }
  async function inspectEvaluation(id: string) {
    if (evaluationDetail?.evaluation.id === id) {
      setEvaluationDetail(undefined);
      return;
    }
    setBusy(`evaluation:${id}`);
    setError("");
    try {
      setEvaluationDetail(
        await api<EvaluationDetail>(`/agent/evaluations/${id}`),
      );
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível carregar as evidências",
      );
    } finally {
      setBusy("");
    }
  }
  async function preparePublication(id: string) {
    setBusy(`publish-review:${id}`);
    setError("");
    try {
      const detail =
        proposalDetail?.proposal.id === id
          ? proposalDetail
          : await api<ProposalDetail>(`/agent/improvement-proposals/${id}`);
      setProposalDetail(detail);
      setDialog({ kind: "publish", id, title: "Publicar candidata" });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Não foi possível preparar a publicação",
      );
    } finally {
      setBusy("");
    }
  }
  async function toggleCase(item: RegressionCase) {
    await action(`case:${item.id}`, () =>
      api(`/agent/regression-cases/${item.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !item.is_active }),
      }),
    );
  }
  async function showDiff() {
    if (!diffTarget || !diffAgainst) return;
    await action("diff", async () =>
      setDiff(
        await api<VersionDiff>(`/agent/versions/${diffTarget}/diff?against=${diffAgainst}`),
      ),
    );
  }
  function casePayload() {
    return {
      name: caseDraft.name,
      description: caseDraft.description,
      severity: caseDraft.severity,
      scenario: JSON.parse(caseDraft.scenario),
      expectedBehavior: JSON.parse(caseDraft.expectedBehavior),
    };
  }
  async function previewCase() {
    await action("case-preview", async () =>
      setCasePreview(
        (
          await api<{ case: unknown }>("/agent/regression-cases/preview", {
            method: "POST",
            body: JSON.stringify(casePayload()),
          })
        ).case,
      ),
    );
  }
  async function createCase() {
    if (!casePreview) return;
    const path = editingCaseId
      ? `/agent/regression-cases/${editingCaseId}`
      : "/agent/regression-cases";
    const saved = await action("case-create", () =>
      api(path, {
        method: editingCaseId ? "PUT" : "POST",
        body: JSON.stringify(casePreview),
      }),
    );
    if (!saved) return;
    setCasePreview(undefined);
    setCaseForm(false);
    setEditingCaseId("");
  }
  function editCase(item: RegressionCase) {
    setEditingCaseId(item.id);
    setCaseDraft({
      name: item.name,
      description: item.description,
      severity: item.severity,
      scenario: JSON.stringify(item.scenario, null, 2),
      expectedBehavior: JSON.stringify(item.expected_behavior, null, 2),
    });
    setCasePreview(undefined);
    setCaseForm(true);
  }
  function editCandidate(detail: ProposalDetail) {
    const candidate = detail.proposal.candidate_version;
    const params = (candidate.model_params ?? {}) as Record<string, unknown>;
    setCandidateDraft({
      proposalId: detail.proposal.id,
      systemPrompt: String(candidate.system_prompt ?? ""),
      aiModel: String(candidate.ai_model ?? ""),
      temperature: Number(params.temperature ?? 0),
      maxTokens: Number(params.max_tokens ?? 512),
      reasoningEffort: ["low", "medium", "high"].includes(String(params.reasoning_effort))
        ? String(params.reasoning_effort) as CandidateDraft["reasoningEffort"]
        : "medium",
      enabledTools: Array.isArray(candidate.enabled_tools)
        ? candidate.enabled_tools.map(String)
        : [],
      note: "",
    });
  }
  async function saveCandidate() {
    if (!candidateDraft) return;
    const saved = await action(`candidate:${candidateDraft.proposalId}`, () =>
      api(
        `/agent/improvement-proposals/${candidateDraft.proposalId}/candidate`,
        {
          method: "PUT",
          body: JSON.stringify({
            systemPrompt: candidateDraft.systemPrompt,
            aiModel: candidateDraft.aiModel,
            modelParams: {
              temperature: candidateDraft.temperature,
              max_tokens: candidateDraft.maxTokens,
              reasoning_effort: candidateDraft.reasoningEffort,
            },
            enabledTools: candidateDraft.enabledTools,
            note: candidateDraft.note,
          }),
        },
      ),
    );
    if (!saved) return;
    setCandidateDraft(undefined);
    setProposalDetail(undefined);
  }
  async function submitDialog() {
    if (!dialog) return;
    const current = dialog;
    setDialog(null);
    if (current.kind === "review")
      await action(`review:${current.id}`, () =>
        api(`/agent/evaluations/${current.id}/review`, {
          method: "POST",
          body: JSON.stringify({
            decision: confirmation === "CONFIRMAR" ? "confirm" : "reject",
            note: dialogNote,
          }),
        }),
      );
    if (current.kind === "reject")
      await action(`reject:${current.id}`, () =>
        api(`/agent/improvement-proposals/${current.id}/reject`, {
          method: "POST",
          body: JSON.stringify({ note: dialogNote }),
        }),
      );
    if (current.kind === "publish")
      await action(`publish:${current.id}`, () =>
        api(`/agent/improvement-proposals/${current.id}/publish`, {
          method: "POST",
          body: JSON.stringify({ confirmation }),
        }),
      );
    if (current.kind === "rollback")
      await action(`rollback:${current.id}`, () =>
        api(`/agent/versions/${current.id}/rollback`, {
          method: "POST",
          body: JSON.stringify({ reason: dialogNote, confirmation }),
        }),
      );
    setDialogNote("");
    setConfirmation("");
  }

  if (loading)
    return (
      <div className="grid gap-5">
        <div className="skeleton h-24" />
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[1.6fr_.8fr]">
          <div className="skeleton h-80" />
          <div className="skeleton h-80" />
        </div>
      </div>
    );
  return (
    <div className="improvement-page">
      <header className="pagehead improvement-head">
        <div>
          <span className="improvement-kicker">CICLO SUPERVISIONADO</span>
          <h1>Melhoria contínua</h1>
          <p>
            A plataforma encontra falhas e prepara mudanças. Você decide o que
            chega à produção.
          </p>
        </div>
        <div className="improvement-version">
          <span className="dot" />
          <div>
            <small>VERSÃO ATIVA</small>
            <strong>v{activeVersion?.version_number ?? "—"}</strong>
            <span>{activeVersion?.ai_model ?? "Sem versão resolvida"}</span>
          </div>
        </div>
      </header>
      {error ? (
        <div className="improvement-error" role="alert">
          <ShieldWarning size={18} />
          <span>{error}</span>
          <button onClick={() => void load()}>Tentar novamente</button>
        </div>
      ) : null}
      <nav
        className="section-tabs improvement-tabs"
        aria-label="Seções da melhoria contínua"
      >
        {tabs.map((item) => (
          <button
            key={item.id}
            className={tab === item.id ? "active" : ""}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === "issues" &&
            evaluations.filter((e) => e.status === "automatic").length ? (
              <b>
                {evaluations.filter((e) => e.status === "automatic").length}
              </b>
            ) : null}
          </button>
        ))}
      </nav>
      {tab === "overview" ? (
        <section className="improvement-overview">
          <div className="improvement-score">
            <span>NOTA GERAL · 30 DIAS</span>
            <strong>
              {Number(summary?.summary.overall_score ?? 0).toFixed(1)}
            </strong>
            <p>
              {latestTrend
                ? `${latestTrend.evaluations} avaliações em ${new Date(`${latestTrend.day}T12:00:00Z`).toLocaleDateString("pt-BR")}`
                : "Ainda não há avaliações no período"}
            </p>
          </div>
          <div className="improvement-metrics">
            <Metric
              label="Avaliações"
              value={summary?.summary.evaluations ?? 0}
            />
            <Metric
              label="Falhas críticas"
              value={summary?.summary.critical_failures ?? 0}
              warning
            />
            <Metric
              label={`Handoffs · ${summary?.operations.handoff_rate_percent ?? 0}%`}
              value={summary?.operations.handoffs ?? 0}
            />
            <Metric
              label="Erros IA / ferramenta"
              value={
                (summary?.operations.ai_errors ?? 0) +
                (summary?.operations.tool_errors ?? 0)
              }
              warning
            />
            <Metric
              label="Limites de ferramenta"
              value={summary?.operations.tool_limits ?? 0}
              warning
            />
            <Metric
              label="Sinais de qualidade"
              value={summary?.operations.quality_signals ?? 0}
              warning
            />
            <Metric label="Custo IA" value={`US$ ${totalCost.toFixed(2)}`} />
          </div>
          <div className="improvement-dimensions">
            <div className="cardtitle">
              Dimensões da rubrica <span className="mono">v1</span>
            </div>
            {summary?.dimensions.length ? (
              summary.dimensions.map((item) => (
                <div className="dimension-row" key={item.dimension}>
                  <span>
                    {dimensionLabels[item.dimension] ?? item.dimension}
                  </span>
                  <div>
                    <i
                      style={{
                        transform: `scaleX(${Number(item.score) / 100})`,
                      }}
                    />
                  </div>
                  <b>{Number(item.score).toFixed(0)}</b>
                </div>
              ))
            ) : (
              <Empty
                title="Sem notas ainda"
                text="Execute uma avaliação manual para inaugurar a linha de base."
              />
            )}
            {summary?.trend.length ? (
              <div
                className="quality-trend"
                aria-label="Tendência diária da nota geral"
              >
                {summary.trend.map((item) => (
                  <div
                    key={item.day}
                    title={`${item.day}: ${Number(item.overall_score).toFixed(1)}`}
                  >
                    <i
                      style={{
                        transform: `scaleY(${Number(item.overall_score) / 100})`,
                      }}
                    />
                    <span>{item.day.slice(5)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="lifecycle-line mono">
              <span>
                detecção → confirmação{" "}
                {summary?.lifecycle.detection_to_confirmation_hours ?? "—"}h
              </span>
              <span>
                detecção → publicação{" "}
                {summary?.lifecycle.detection_to_publication_hours ?? "—"}h
              </span>
              <span>publicadas {summary?.lifecycle.published ?? 0}</span>
              <span>revertidas {summary?.lifecycle.reverted ?? 0}</span>
              {Object.entries(summary?.operations.handoff_reasons ?? {}).map(
                ([reason, count]) => (
                  <span key={reason}>
                    handoff {reason}: {count}
                  </span>
                ),
              )}
            </div>
          </div>
          <aside className="improvement-controls">
            <div className="cardtitle">Avaliador independente</div>
            <label className="field">
              <span className="label">Modelo de avaliação</span>
              <input
                className="input mono text-xs"
                value={settings?.evaluator_model ?? ""}
                placeholder="openai/gpt-5-mini"
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? { ...current, evaluator_model: event.target.value }
                      : current,
                  )
                }
              />
              <small>Temperatura zero, sem acesso a ferramentas.</small>
            </label>
            <label className="improvement-switch">
              <span>
                <strong>Avaliações automáticas</strong>
                <small>Handoffs, erros e conversas fechadas.</small>
              </span>
              <input
                type="checkbox"
                checked={settings?.ai_evaluations_enabled ?? false}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          ai_evaluations_enabled: event.target.checked,
                        }
                      : current,
                  )
                }
              />
            </label>
            <label className="improvement-switch">
              <span>
                <strong>Geração de propostas</strong>
                <small>Libera candidatas sem alterar produção.</small>
              </span>
              <input
                type="checkbox"
                checked={settings?.ai_proposals_enabled ?? false}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          ai_proposals_enabled: event.target.checked,
                          ai_publication_enabled: event.target.checked
                            ? current.ai_publication_enabled
                            : false,
                        }
                      : current,
                  )
                }
              />
            </label>
            <label className="improvement-switch">
              <span>
                <strong>Publicação manual</strong>
                <small>Última etapa do rollout supervisionado.</small>
              </span>
              <input
                type="checkbox"
                checked={settings?.ai_publication_enabled ?? false}
                disabled={!settings?.ai_proposals_enabled}
                onChange={(event) =>
                  setSettings((current) =>
                    current
                      ? {
                          ...current,
                          ai_publication_enabled: event.target.checked,
                        }
                      : current,
                  )
                }
              />
            </label>
            <button
              className="btn primary active:scale-[.98]"
              disabled={busy === "settings" || !settings?.evaluator_model}
              onClick={() => void saveSettings()}
            >
              {busy === "settings" ? "Salvando…" : "Salvar avaliador"}
            </button>
            <p className="sub">
              O atendimento continua funcionando mesmo se este subsistema
              estiver desligado.
            </p>
          </aside>
        </section>
      ) : null}
      {tab === "issues" ? (
        <section className="improvement-section">
          <div className="improvement-toolbar">
            <div>
              <h2>Problemas encontrados</h2>
              <p>
                Abra as evidências antes de confirmar ou rejeitar um achado.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                className="input w-auto"
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setEvaluationPage(0);
                  setEvaluationDetail(undefined);
                }}
              >
                <option value="">Todos os estados</option>
                <option value="automatic">Aguardando revisão</option>
                <option value="confirmed">Confirmados</option>
                <option value="rejected">Rejeitados</option>
              </select>
              <select
                className="input w-auto"
                value={issueFilter}
                onChange={(e) => {
                  setIssueFilter(e.target.value);
                  setEvaluationPage(0);
                  setEvaluationDetail(undefined);
                }}
              >
                <option value="">Todos os códigos</option>
                {issueCodes.map((code) => (
                  <option key={code}>{code}</option>
                ))}
              </select>
            </div>
          </div>
          {evaluationLoading && !evaluations.length ? (
            <div className="grid gap-2">
              <div className="skeleton h-24" />
              <div className="skeleton h-24" />
            </div>
          ) : evaluations.length ? (
            <>
              <div className="improvement-list">
                {evaluations.map((item) => (
                  <article key={item.id} className="evaluation-row">
                    <div
                      className={`score-orb ${item.has_critical_failure ? "critical" : ""}`}
                    >
                      {item.overall_score}
                    </div>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Status value={item.status} />
                        <span className="mono text-[10px] text-[var(--faint)]">
                          {item.trigger}
                        </span>
                      </div>
                      <p>{item.summary}</p>
                      <div className="issue-tags">
                        {item.violations?.slice(0, 4).map((v) => (
                          <span key={v.code}>{v.code}</span>
                        ))}
                      </div>
                    </div>
                    <div className="evaluation-actions">
                      <button
                        className="btn"
                        disabled={busy === `evaluation:${item.id}`}
                        onClick={() => void inspectEvaluation(item.id)}
                      >
                        <MagnifyingGlass size={15} />
                        {evaluationDetail?.evaluation.id === item.id
                          ? "Fechar"
                          : "Evidências"}
                      </button>
                      {item.status === "automatic" ? (
                        <>
                          <button
                            className="btn"
                            onClick={() => {
                              setDialog({
                                kind: "review",
                                id: item.id,
                                title: "Revisar avaliação",
                              });
                              setConfirmation("CONFIRMAR");
                            }}
                          >
                            <CheckCircle size={15} />
                            Confirmar
                          </button>
                          <button
                            className="btn warn"
                            onClick={() => {
                              setDialog({
                                kind: "review",
                                id: item.id,
                                title: "Rejeitar avaliação",
                              });
                              setConfirmation("REJEITAR");
                            }}
                          >
                            <XCircle size={15} />
                            Rejeitar
                          </button>
                        </>
                      ) : null}
                      {item.status === "confirmed" ? (
                        <button
                          className="btn primary"
                          disabled={busy === `generate:${item.id}`}
                          onClick={() => void generateProposal(item.id)}
                        >
                          <Sparkle size={15} />
                          Gerar proposta
                        </button>
                      ) : null}
                    </div>
                    {evaluationDetail?.evaluation.id === item.id ? (
                      <EvaluationEvidence detail={evaluationDetail} />
                    ) : null}
                  </article>
                ))}
              </div>
              <div className="evaluation-pagination">
                <button
                  className="btn"
                  disabled={evaluationPage === 0 || evaluationLoading}
                  onClick={() => {
                    setEvaluationPage((page) => page - 1);
                    setEvaluationDetail(undefined);
                  }}
                >
                  Anterior
                </button>
                <span className="mono">
                  {evaluationPage + 1} / {evaluationPageCount} ·{" "}
                  {evaluationTotal} avaliações
                </span>
                <button
                  className="btn"
                  disabled={
                    evaluationPage + 1 >= evaluationPageCount ||
                    evaluationLoading
                  }
                  onClick={() => {
                    setEvaluationPage((page) => page + 1);
                    setEvaluationDetail(undefined);
                  }}
                >
                  Próxima
                </button>
              </div>
            </>
          ) : (
            <Empty
              title="Nenhuma avaliação neste filtro"
              text="Ajuste os filtros ou execute uma avaliação manual pela conversa."
            />
          )}
        </section>
      ) : null}
      {tab === "proposals" ? (
        <section className="improvement-section">
          <div className="improvement-toolbar">
            <div>
              <h2>Propostas supervisionadas</h2>
              <p>
                Nenhuma candidata altera produção antes de replay, confirmação e
                publicação ROOT.
              </p>
            </div>
          </div>
          {proposals.length ? (
            <div className="proposal-stack">
              {proposals.map((item, index) => (
                <article
                  className="proposal-row"
                  key={item.id}
                  style={{ animationDelay: `${index * 55}ms` }}
                >
                  <div className="proposal-index mono">
                    {String(item.candidate_version_number).padStart(2, "0")}
                  </div>
                  <div>
                    <Status value={item.status} />
                    <h3>{item.title}</h3>
                    <p>{item.rationale}</p>
                    <div className="issue-tags">
                      {item.target_issue_codes.map((code) => (
                        <span key={code}>{code}</span>
                      ))}
                    </div>
                    <small className="mono">
                      baseline v{item.baseline_version_number} → candidata v
                      {item.candidate_version_number}
                      {item.latest_run_status
                        ? ` · run ${item.latest_run_status}`
                        : ""}
                    </small>
                  </div>
                  <div className="proposal-actions">
                    <button
                      className="btn"
                      disabled={busy === `detail:${item.id}`}
                      onClick={() => void inspectProposal(item.id)}
                    >
                      <GitDiff size={15} />
                      {proposalDetail?.proposal.id === item.id
                        ? "Fechar"
                        : "Inspecionar"}
                    </button>
                    {proposalDetail?.proposal.id === item.id &&
                    ["proposed", "test_failed", "ready"].includes(
                      item.status,
                    ) ? (
                      <button
                        className="btn"
                        onClick={() => editCandidate(proposalDetail)}
                      >
                        Editar candidata
                      </button>
                    ) : null}
                    {["proposed", "test_failed", "ready"].includes(
                      item.status,
                    ) ? (
                      <button
                        className="btn"
                        disabled={busy === `test:${item.id}`}
                        onClick={() => void runProposal(item.id)}
                      >
                        <TestTube size={16} />
                        {busy === `test:${item.id}`
                          ? "Enfileirando…"
                          : "Executar replay"}
                      </button>
                    ) : null}
                    {["proposed", "test_failed", "ready"].includes(
                      item.status,
                    ) ? (
                      <button
                        className="btn warn"
                        onClick={() =>
                          setDialog({
                            kind: "reject",
                            id: item.id,
                            title: "Rejeitar proposta",
                          })
                        }
                      >
                        Rejeitar
                      </button>
                    ) : null}
                    {canPublishImprovementProposal(
                      item.status,
                      settings?.ai_publication_enabled ?? false,
                    ) ? (
                      <button
                        className="btn primary"
                        disabled={busy === `publish-review:${item.id}`}
                        onClick={() => void preparePublication(item.id)}
                      >
                        {busy === `publish-review:${item.id}`
                          ? "Preparando…"
                          : "Publicar"}
                      </button>
                    ) : null}
                  </div>
                  {proposalDetail?.proposal.id === item.id ? (
                    <ProposalInspection detail={proposalDetail} />
                  ) : null}
                  {candidateDraft?.proposalId === item.id ? (
                    <CandidateEditor
                      draft={candidateDraft}
                      availableTools={availableTools}
                      busy={busy === `candidate:${item.id}`}
                      onChange={setCandidateDraft}
                      onCancel={() => setCandidateDraft(undefined)}
                      onSave={() => void saveCandidate()}
                    />
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title="Nenhuma proposta criada"
              text="Confirme um problema primeiro. A geração usa apenas evidências revisadas."
            />
          )}
        </section>
      ) : null}
      {tab === "cases" ? (
        <section className="improvement-section">
          <div className="improvement-toolbar">
            <div>
              <h2>Casos de regressão</h2>
              <p>
                Cenários sanitizados e estáveis; casos desativados continuam no
                histórico dos runs.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="mono text-xs text-[var(--faint)]">
                {cases.filter((item) => item.is_active).length} ATIVOS
              </span>
              <button
                className="btn primary"
                onClick={() => {
                  setEditingCaseId("");
                  setCaseForm((value) => !value);
                  setCasePreview(undefined);
                }}
              >
                Novo caso
              </button>
            </div>
          </div>
          {caseForm ? (
            <div className="case-editor">
              <div className="cardtitle mb-0">
                {editingCaseId ? "Editar caso curado" : "Novo caso curado"}
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <label className="field">
                  <span className="label">Nome</span>
                  <input
                    className="input"
                    value={caseDraft.name}
                    onChange={(e) =>
                      setCaseDraft({ ...caseDraft, name: e.target.value })
                    }
                  />
                </label>
                <label className="field">
                  <span className="label">Severidade</span>
                  <select
                    className="input"
                    value={caseDraft.severity}
                    onChange={(e) =>
                      setCaseDraft({ ...caseDraft, severity: e.target.value })
                    }
                  >
                    <option value="critical">Crítica</option>
                    <option value="high">Alta</option>
                    <option value="medium">Média</option>
                    <option value="low">Baixa</option>
                  </select>
                </label>
              </div>
              <label className="field">
                <span className="label">Descrição</span>
                <input
                  className="input"
                  value={caseDraft.description}
                  onChange={(e) =>
                    setCaseDraft({ ...caseDraft, description: e.target.value })
                  }
                />
              </label>
              <div className="grid gap-4 lg:grid-cols-2">
                <label className="field">
                  <span className="label">Cenário JSON</span>
                  <textarea
                    className="input mono min-h-64 text-xs"
                    value={caseDraft.scenario}
                    onChange={(e) => {
                      setCaseDraft({ ...caseDraft, scenario: e.target.value });
                      setCasePreview(undefined);
                    }}
                  />
                </label>
                <label className="field">
                  <span className="label">Comportamento esperado JSON</span>
                  <textarea
                    className="input mono min-h-64 text-xs"
                    value={caseDraft.expectedBehavior}
                    onChange={(e) => {
                      setCaseDraft({
                        ...caseDraft,
                        expectedBehavior: e.target.value,
                      });
                      setCasePreview(undefined);
                    }}
                  />
                </label>
              </div>
              {casePreview ? (
                <div className="case-preview">
                  <strong>Prévia sanitizada para confirmação</strong>
                  <pre>{JSON.stringify(casePreview, null, 2)}</pre>
                </div>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  className="btn"
                  onClick={() => {
                    setCaseForm(false);
                    setCasePreview(undefined);
                    setEditingCaseId("");
                  }}
                >
                  Cancelar
                </button>
                <button
                  className="btn"
                  disabled={busy === "case-preview"}
                  onClick={() => void previewCase()}
                >
                  {busy === "case-preview"
                    ? "Sanitizando…"
                    : "Pré-visualizar sanitização"}
                </button>
                <button
                  className="btn primary"
                  disabled={!casePreview || busy === "case-create"}
                  onClick={() => void createCase()}
                >
                  {busy === "case-create"
                    ? "Salvando…"
                    : editingCaseId
                      ? "Confirmar atualização"
                      : "Confirmar e criar"}
                </button>
              </div>
            </div>
          ) : null}
          {cases.length ? (
            <div className="case-grid">
              {cases.map((item) => (
                <article
                  key={item.id}
                  className={`case-row ${item.is_active ? "" : "muted"}`}
                >
                  <div>
                    <span className={`severity severity-${item.severity}`}>
                      {item.severity}
                    </span>
                    <h3>{item.name}</h3>
                    <p>{item.description || "Sem descrição adicional."}</p>
                  </div>
                  <div className="case-actions">
                    <button className="btn" onClick={() => editCase(item)}>
                      Editar
                    </button>
                    <button
                      className="btn"
                      disabled={busy === `case:${item.id}`}
                      onClick={() => void toggleCase(item)}
                    >
                      {item.is_active ? "Desativar" : "Ativar"}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : !caseForm ? (
            <Empty
              title="Nenhum caso curado"
              text="Converta avaliações confirmadas em cenários sanitizados antes de testar propostas."
            />
          ) : null}
        </section>
      ) : null}
      {tab === "versions" ? (
        <section className="improvement-section">
          <div className="improvement-toolbar">
            <div>
              <h2>Histórico imutável</h2>
              <p>
                Rollback cria uma nova versão; snapshots anteriores nunca são
                sobrescritos.
              </p>
            </div>
          </div>
          <div className="version-layout">
            <div className="version-list">
              {versions.map((item) => {
                const metric = summary?.version_metrics.find(
                  (value) => value.version_id === item.id,
                );
                return (
                  <article
                    key={item.id}
                    className={item.status === "active" ? "active" : ""}
                  >
                    <div className="version-number">v{item.version_number}</div>
                    <div>
                      <Status value={item.status} />
                      <strong>{item.ai_model}</strong>
                      <small>
                        {item.source} ·{" "}
                        {new Date(item.created_at).toLocaleString("pt-BR")}
                      </small>
                      <small>
                        {metric?.evaluations ?? 0} avaliações · nota{" "}
                        {Number(metric?.overall_score ?? 0).toFixed(1)} ·{" "}
                        {metric?.critical_failures ?? 0} críticas
                      </small>
                    </div>
                    {item.status !== "active" && item.status !== "candidate" ? (
                      <button
                        className="btn"
                        onClick={() =>
                          setDialog({
                            kind: "rollback",
                            id: item.id,
                            title: `Reverter para v${item.version_number}`,
                          })
                        }
                      >
                        <ArrowCounterClockwise size={15} />
                        Rollback
                      </button>
                    ) : null}
                  </article>
                );
              })}
            </div>
            <aside className="diff-panel">
              <div className="cardtitle">
                <span>Comparar versões</span>
                <GitDiff size={18} />
              </div>
              <label className="field">
                <span className="label">Versão alvo</span>
                <select
                  className="input"
                  value={diffTarget}
                  onChange={(e) => setDiffTarget(e.target.value)}
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version_number} · {v.status}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="label">Comparar contra</span>
                <select
                  className="input"
                  value={diffAgainst}
                  onChange={(e) => setDiffAgainst(e.target.value)}
                >
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version_number} · {v.status}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn"
                disabled={
                  !diffTarget ||
                  !diffAgainst ||
                  diffTarget === diffAgainst ||
                  busy === "diff"
                }
                onClick={() => void showDiff()}
              >
                <Flask size={15} />
                Gerar diff
              </button>
              {diff ? (
                <div className="diff-output">
                  {Object.entries(diff.diff ?? {}).map(([field, value]) =>
                    value ? (
                      <div key={field}>
                        <strong>{field}</strong>
                        <pre>{JSON.stringify(value, null, 2)}</pre>
                      </div>
                    ) : null,
                  )}
                </div>
              ) : (
                <p className="sub">
                  Escolha duas versões para inspecionar prompt, modelo,
                  parâmetros e ferramentas.
                </p>
              )}
            </aside>
          </div>
        </section>
      ) : null}
      {dialog ? (
        <ActionDialog
          dialog={dialog}
          proposalDetail={proposalDetail}
          note={dialogNote}
          confirmation={confirmation}
          onNote={setDialogNote}
          onConfirmation={setConfirmation}
          onClose={() => {
            setDialog(null);
            setDialogNote("");
            setConfirmation("");
          }}
          onSubmit={() => void submitDialog()}
        />
      ) : null}
    </div>
  );
}

function Metric({
  label,
  value,
  warning = false,
}: {
  label: string;
  value: number | string;
  warning?: boolean;
}) {
  return (
    <div>
      <span>{label}</span>
      <strong className={warning && Number(value) ? "warning" : ""}>
        {value}
      </strong>
    </div>
  );
}
function EvaluationEvidence({ detail }: { detail: EvaluationDetail }) {
  return (
    <div className="evaluation-evidence">
      <div>
        <strong>Notas e justificativas</strong>
        <div className="evidence-scores">
          {Object.entries(detail.evaluation.scores).map(
            ([dimension, value]) => (
              <div key={dimension}>
                <span>{dimensionLabels[dimension] ?? dimension}</span>
                <b>{value.score}</b>
                <p>{value.rationale}</p>
              </div>
            ),
          )}
        </div>
      </div>
      <div>
        <strong>Mensagens citadas</strong>
        {detail.evidence.length ? (
          <div className="evidence-messages">
            {detail.evidence.map((message) => (
              <blockquote key={message.id}>
                <span className="mono">
                  {message.sender} ·{" "}
                  {new Date(message.created_at).toLocaleString("pt-BR")}
                </span>
                <p>{message.excerpt}</p>
              </blockquote>
            ))}
          </div>
        ) : (
          <p className="sub">
            Nenhum trecho de mensagem foi citado pelo avaliador.
          </p>
        )}
        <strong>Violações</strong>
        <div className="evidence-violations">
          {detail.evaluation.violations.map((item) => (
            <div key={`${item.code}:${item.evidenceMessageIds.join(",")}`}>
              <Status value={item.severity} />
              <span className="mono">
                {item.code} · confiança {(item.confidence * 100).toFixed(0)}%
              </span>
              <p>{item.detail}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function CandidateEditor({
  draft,
  availableTools,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: CandidateDraft;
  availableTools: string[];
  busy: boolean;
  onChange: (draft: CandidateDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const toggleTool = (tool: string) =>
    onChange({
      ...draft,
      enabledTools: draft.enabledTools.includes(tool)
        ? draft.enabledTools.filter((item) => item !== tool)
        : [...draft.enabledTools, tool],
    });
  const valid =
    draft.systemPrompt.trim().length > 0 &&
    draft.aiModel.trim().length > 0 &&
    draft.enabledTools.length > 0 &&
    draft.note.trim().length >= 3 &&
    draft.maxTokens >= 64;
  return (
    <div className="candidate-editor">
      <div className="cardtitle mb-0">Editar snapshot da candidata</div>
      <p className="sub">
        Ao salvar, a candidata atual será rejeitada, uma nova versão imutável
        será criada e o replay começará novamente.
      </p>
      <label className="field">
        <span className="label">Prompt do sistema</span>
        <textarea
          className="input min-h-64 resize-y"
          value={draft.systemPrompt}
          onChange={(event) =>
            onChange({ ...draft, systemPrompt: event.target.value })
          }
        />
      </label>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="field">
          <span className="label">Modelo</span>
          <input
            className="input mono text-xs"
            value={draft.aiModel}
            onChange={(event) =>
              onChange({ ...draft, aiModel: event.target.value })
            }
          />
        </label>
        <label className="field">
          <span className="label">Nível de raciocínio</span>
          <select
            className="input"
            value={draft.reasoningEffort}
            onChange={(event) =>
              onChange({ ...draft, reasoningEffort: event.target.value as CandidateDraft["reasoningEffort"] })
            }
          >
            <option value="low">Baixo</option>
            <option value="medium">Médio</option>
            <option value="high">Alto</option>
          </select>
        </label>
        <label className="field">
          <span className="label">Temperatura</span>
          <input
            className="input mono"
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={draft.temperature}
            onChange={(event) =>
              onChange({ ...draft, temperature: Number(event.target.value) })
            }
          />
        </label>
        <label className="field">
          <span className="label">Máx. tokens</span>
          <input
            className="input mono"
            type="number"
            min="64"
            max="8192"
            step="64"
            value={draft.maxTokens}
            onChange={(event) =>
              onChange({ ...draft, maxTokens: Number(event.target.value) })
            }
          />
        </label>
      </div>
      <fieldset className="candidate-tools">
        <legend className="label">Ferramentas habilitadas</legend>
        <div>
          {availableTools.map((tool) => (
            <label key={tool}>
              <input
                type="checkbox"
                checked={draft.enabledTools.includes(tool)}
                onChange={() => toggleTool(tool)}
              />
              <span className="mono">{tool}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="field">
        <span className="label">Motivo da edição</span>
        <textarea
          className="input min-h-20"
          value={draft.note}
          onChange={(event) => onChange({ ...draft, note: event.target.value })}
        />
        <small>Este motivo entra na trilha de auditoria.</small>
      </label>
      <div className="flex flex-wrap justify-end gap-2">
        <button className="btn" onClick={onCancel}>
          Cancelar
        </button>
        <button
          className="btn primary"
          disabled={!valid || busy}
          onClick={onSave}
        >
          {busy ? "Criando e testando…" : "Criar versão e executar replay"}
        </button>
      </div>
    </div>
  );
}
function ProposalInspection({ detail }: { detail: ProposalDetail }) {
  const baseline = detail.proposal.baseline_version;
  const candidate = detail.proposal.candidate_version;
  const fields = [
    "system_prompt",
    "ai_model",
    "model_params",
    "enabled_tools",
  ] as const;
  return (
    <div className="proposal-inspection">
      <div>
        <strong>Diff da configuração completa</strong>
        {fields.map((field) =>
          JSON.stringify(baseline[field]) !==
          JSON.stringify(candidate[field]) ? (
            <section key={field}>
              <span className="mono">{field}</span>
              <div className="inspection-diff">
                <pre>{JSON.stringify(baseline[field], null, 2)}</pre>
                <pre>{JSON.stringify(candidate[field], null, 2)}</pre>
              </div>
            </section>
          ) : null,
        )}
      </div>
      <div>
        <strong>Impacto e riscos</strong>
        <pre>{JSON.stringify(detail.proposal.expected_impact, null, 2)}</pre>
        <strong>Runs e casos</strong>
        {detail.runs.length ? (
          detail.runs.map((run) => (
            <p key={run.id}>
              <Status value={run.status} /> {run.case_count} casos · US${" "}
              {Number(run.estimated_cost_usd).toFixed(4)}
            </p>
          ))
        ) : (
          <p>Nenhum replay executado.</p>
        )}
        {detail.caseResults.map((result) => (
          <p key={result.id} className="mono">
            {result.passed ? "PASS" : "FAIL"} · {result.case_name} ·{" "}
            {result.baseline_score} → {result.candidate_score}
          </p>
        ))}
      </div>
    </div>
  );
}
function Status({ value }: { value: string }) {
  const good = ["ready", "active", "confirmed", "published", "passed"].includes(
    value,
  );
  const warn = [
    "test_failed",
    "critical",
    "rejected",
    "failed",
    "technical_error",
  ].includes(value);
  return (
    <span className={`status-chip ${good ? "good" : warn ? "warn" : ""}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className="improvement-empty">
      <Gauge size={27} />
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}
function ActionDialog({
  dialog,
  proposalDetail,
  note,
  confirmation,
  onNote,
  onConfirmation,
  onClose,
  onSubmit,
}: {
  dialog: { kind: string; id: string; title: string };
  proposalDetail?: ProposalDetail;
  note: string;
  confirmation: string;
  onNote: (v: string) => void;
  onConfirmation: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const destructive =
    dialog.kind === "publish" || dialog.kind === "rollback"
      ? dialog.kind
      : null;
  const required = destructive
    ? requiredImprovementConfirmation(destructive)
    : dialog.kind === "review"
      ? confirmation
      : "";
  const needsNote = ["review", "reject", "rollback"].includes(dialog.kind);
  const valid =
    (!needsNote || note.trim().length >= 3) &&
    (!destructive ||
      hasValidImprovementConfirmation(destructive, confirmation));
  return (
    <ModalDialog
      className={dialog.kind === "publish" ? "publish-dialog" : ""}
      labelledBy="action-title"
      describedBy="action-description"
      onClose={onClose}
    >
        <h2 id="action-title">{dialog.title}</h2>
        <p id="action-description">
          {dialog.kind === "publish"
            ? "Esta ação troca a configuração ativa em uma transação auditada."
            : dialog.kind === "rollback"
              ? "Uma nova versão será criada a partir do snapshot escolhido."
              : "Registre a justificativa para manter a trilha de decisão."}
        </p>
        {dialog.kind === "publish" &&
        proposalDetail?.proposal.id === dialog.id ? (
          <PublishConfirmationSummary detail={proposalDetail} />
        ) : null}
        {needsNote ? (
          <label className="field">
            <span className="label">Nota ou motivo</span>
            <textarea
              className="input min-h-24"
              value={note}
              onChange={(e) => onNote(e.target.value)}
            />
          </label>
        ) : null}
        {destructive ? (
          <label className="field">
            <span className="label">Digite {required}</span>
            <input
              className="input mono"
              value={confirmation}
              onChange={(e) => onConfirmation(e.target.value)}
            />
          </label>
        ) : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button type="button" className="btn primary" disabled={!valid} onClick={onSubmit}>
            Confirmar ação
          </button>
        </div>
    </ModalDialog>
  );
}
function PublishConfirmationSummary({ detail }: { detail: ProposalDetail }) {
  const latestRun = detail.runs[0];
  const baseline = detail.proposal.baseline_version;
  const candidate = detail.proposal.candidate_version;
  return (
    <div className="publish-summary">
      <div className="issue-tags">
        {detail.proposal.target_issue_codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <p className="mono">
        baseline v{detail.proposal.baseline_version_number} → candidata v
        {detail.proposal.candidate_version_number} · gates{" "}
        {latestRun?.status ?? "sem run"} · US${" "}
        {Number(latestRun?.estimated_cost_usd ?? 0).toFixed(4)}
      </p>
      {["system_prompt", "ai_model", "model_params", "enabled_tools"].map(
        (field) =>
          JSON.stringify(baseline[field]) !==
          JSON.stringify(candidate[field]) ? (
            <section key={field}>
              <strong>{field}</strong>
              <div className="inspection-diff">
                <pre>{JSON.stringify(baseline[field], null, 2)}</pre>
                <pre>{JSON.stringify(candidate[field], null, 2)}</pre>
              </div>
            </section>
          ) : null,
      )}
    </div>
  );
}
