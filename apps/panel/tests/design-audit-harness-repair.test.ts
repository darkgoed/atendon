// Contrato das fixtures do design-audit (Visão geral, /uso), dos headings com HelpHint e do
// classificador de controles em contêiner visualmente oculto. Sem servidor: payload() é o mesmo
// roteador que o harness usa para interceptar /api e /backend.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { chromium } from "playwright";
import { ROUTE_CONTRACTS, type RouteContract } from "../scripts/design-audit/contracts.mjs";
import { geometrySelfTestVectors } from "../scripts/design-audit/geometry.mjs";
// @ts-expect-error Módulo ESM só de runtime, sem .d.mts.
import { SETTINGS_OPTIONAL_CONTRACTS } from "../scripts/design-audit/optionalcontracts-settings.mjs";
// @ts-expect-error Módulo ESM só de runtime, sem .d.mts.
import { ROOT_ROUTE_CONTRACTS } from "../scripts/design-audit/contracts-root.mjs";
// @ts-expect-error O runner é ESM só de runtime.
import { measure, payload } from "../scripts/design-audit.mjs";

type Json = Record<string, unknown>;
type Numbers = Record<string, number>;

const read = (file: string) => readFileSync(resolve(process.cwd(), file), "utf8");
const body = (path: string, route: string): Json => payload(path, "GET", false, route)?.body;
const widget = (key: string): Json => body(`/dashboard/widgets/${key}`, "/").data as Json;
// Mesma fórmula de rate() em backend/src/modules/dashboard/service.ts.
const rate = (part: number, total: number) => (total ? Math.round((part / total) * 1000) / 10 : 0);
const unique = (values: Iterable<string>) => [...new Set(values)];
// Mesma precedência de loadDomainContracts() no runner: base < settings < root.
const effective: Record<string, RouteContract> = { ...ROUTE_CONTRACTS, ...SETTINGS_OPTIONAL_CONTRACTS, ...ROOT_ROUTE_CONTRACTS };

describe("fixtures da Visão geral (/)", () => {
  it("entrega o contrato degradado de capacidades de mensageria para o editor de fluxo", () => {
    const { sessions } = body("/me/messaging-capabilities", "/fluxos/[id]") as { sessions: Array<{ session_id: string; capabilities: Record<string, boolean> }> };
    expect(sessions.length).toBeGreaterThan(0);
    for (const session of sessions) {
      expect(session.session_id).toBeTruthy();
      expect(session.capabilities).toEqual({ reactions: false, forward_media: false, interactive: false });
    }
  });
  it("responde o catálogo de equipes usado pelo filtro de conversas", () => {
    const { teams } = body("/organization/teams", "/conversas") as { teams: Array<{ id: string; name: string; member_count: number; active_member_count: number }> };
    expect(teams.length).toBeGreaterThan(0);
    for (const team of teams) {
      expect(team.id).toBeTruthy();
      expect(team.name).toBeTruthy();
      expect(team.active_member_count).toBeLessThanOrEqual(team.member_count);
    }
  });
  it("entrega minutos numéricos e ocorrências recorrentes com instantes válidos", () => {
    const conversations = body("/conversations", "/conversas").conversations as Json[];
    expect(conversations.length).toBeGreaterThan(0);
    for (const row of conversations) expect(Number.isFinite(row.waiting_minutes)).toBe(true);
    const blocks = body("/scheduling/attendants/me/recurring-time-blocks", "/agenda").blocks as Json[];
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(Number.isNaN(Date.parse(String(block.start)))).toBe(false);
      expect(Date.parse(String(block.end))).toBeGreaterThan(Date.parse(String(block.start)));
      expect(block.rule_id).toBeTruthy();
    }
  });
  const source = read("components/dashboard-reference-overview.tsx");
  const keys = unique([...source.matchAll(/widgetOf<[^>]+>\("([a-z_]+)"\)/g)].map((match) => match[1]));

  it("responde toda chave de widget que o componente consulta", () => {
    expect(keys.length).toBeGreaterThanOrEqual(20);
    expect(source).toContain("/dashboard?include=widgets&");
    const bundle = body("/dashboard", "/").widgets as Record<string, Json>;
    for (const key of keys) {
      const answer = payload(`/dashboard/widgets/${key}`, "GET", false, "/");
      expect(answer?.body?.key, key).toBe(key);
      expect(answer?.body?.data, key).toBeTruthy();
      expect(bundle[key], key).toEqual(answer?.body);
    }
  });

  it("não inventa payload para chave sem fixture", () => {
    for (const key of ["chave_inexistente", "constructor", "__proto__"]) {
      expect(payload(`/dashboard/widgets/${key}`, "GET", false, "/"), key).toBeUndefined();
    }
  });

  it("entrega a forma que cada seção desreferencia", () => {
    const handoffs = widget("handoffs") as { total: number; items: Array<{ id: string; waiting_minutes: number }> };
    expect(handoffs.items.length).toBeGreaterThan(0);
    expect(handoffs.items.length).toBeLessThanOrEqual(5); // LIMIT 5 da query
    expect(handoffs.total).toBeGreaterThanOrEqual(handoffs.items.length);
    for (const item of handoffs.items) expect(typeof item.waiting_minutes).toBe("number");

    const { operations } = widget("operations_summary") as { operations: Json };
    expect(Object.keys(operations).sort()).toEqual(["average_first_response_minutes", "handoffs", "inbound_messages", "open_conversations", "overdue_follow_ups", "unassigned_leads"]);
    expect(Object.keys(widget("open_conversations")).sort()).toEqual(["ai_open", "open", "resolved_today"]);
    const whatsapp = widget("whatsapp_connection") as Numbers;
    expect(whatsapp.connected).toBeLessThanOrEqual(whatsapp.total);

    const agenda = widget("today_agenda") as { items: Array<{ id: string; start_at: string }>; period: { timezone: string } };
    expect(agenda.items.length).toBeGreaterThan(0);
    for (const item of agenda.items) expect(Number.isNaN(Date.parse(item.start_at))).toBe(false);
    expect(typeof agenda.period.timezone).toBe("string");

    const alerts = (widget("recent_alerts") as { items: Array<{ id: string; message: string; created_at: string }> }).items;
    expect(alerts.length).toBeGreaterThan(0);
    for (const alert of alerts) expect([typeof alert.id, typeof alert.message, typeof alert.created_at]).toEqual(["string", "string", "string"]);

    const stages = (widget("pipeline") as { stages: Array<{ count: number }> }).stages;
    expect(stages.length).toBeGreaterThan(0);
    for (const stage of stages) expect(typeof stage.count).toBe("number");

    const { members } = widget("team_load") as { members: Array<{ member_id: string; completed: number; no_show: number; sales: number; sold_value: number; closing_rate: number }> };
    expect(members.length).toBeGreaterThan(0);
    for (const member of members) expect([typeof member.completed, typeof member.no_show, typeof member.sales, typeof member.sold_value, typeof member.closing_rate]).toEqual(["number", "number", "number", "number", "number"]);

    // Mesmas chaves do último return de loadWidgetData (dashboard-widgets/routes.ts).
    expect(Object.keys(widget("commercial_metrics")).sort()).toEqual(["commercial_metrics", "funnel", "metrics", "period", "result", "sdr_metrics", "series"]);
    const { result, funnel } = widget("commercial_metrics") as { result: Numbers; funnel: Numbers };
    for (const field of ["new_contacts", "appointments", "calls", "sales", "sold_value", "average_ticket", "due_meetings", "no_show"]) expect(typeof result[field], field).toBe("number");
    for (const field of ["lead_to_appointment", "appointment_to_attendance", "call_to_sale", "lead_to_sale", "no_show_rate"]) expect(typeof funnel[field], field).toBe("number");
  });

  it("mantém denominadores e taxas coerentes entre os widgets", () => {
    const { result, funnel } = widget("commercial_metrics") as { result: Numbers; funnel: Numbers };
    expect(funnel).toEqual({
      lead_to_appointment: rate(result.appointments, result.new_contacts),
      appointment_to_attendance: rate(result.calls, result.due_meetings),
      call_to_sale: rate(result.sales, result.calls),
      lead_to_sale: rate(result.sales, result.new_contacts),
      no_show_rate: rate(result.no_show, result.due_meetings)
    });
    // conversion_rate = vendas ÷ conversas iniciadas (não vendas ÷ contatos, que é lead_to_sale).
    expect((widget("conversion_rate") as Numbers).value).toBe(rate(result.sales, (widget("conversations_started") as Numbers).value));
    expect((widget("attendance_rate") as Numbers).value).toBe(rate(result.calls, result.due_meetings));
    expect(result.average_ticket).toBe(result.sold_value / result.sales);

    const { members } = widget("team_load") as { members: Array<Record<"completed" | "no_show" | "sales" | "sold_value" | "closing_rate", number>> };
    const teamTotal = (field: "completed" | "no_show" | "sales" | "sold_value") => members.reduce((sum, member) => sum + member[field], 0);
    expect(teamTotal("sold_value")).toBe(result.sold_value);
    expect(teamTotal("sales")).toBe(result.sales);
    expect(teamTotal("completed")).toBe(result.calls);
    expect(teamTotal("no_show")).toBe(result.no_show);
    for (const member of members) expect(member.closing_rate).toBe(rate(member.sales, member.completed));

    const sum = (list: string[]) => list.reduce((total, key) => total + (widget(key) as Numbers).value, 0);
    expect(sum(["leads_paid_traffic", "leads_referral", "leads_organic", "leads_other_sources"])).toBe((widget("new_leads") as Numbers).value);
    expect(sum(["sales_paid_traffic", "sales_referral", "sales_organic"])).toBeLessThanOrEqual(result.sales);
    const { operations } = widget("operations_summary") as { operations: Numbers };
    expect(operations.handoffs).toBe((widget("handoffs") as Numbers).total);
    expect(operations.open_conversations).toBe((widget("open_conversations") as Numbers).open);
  });
});

describe("fixtures de /uso e /configuracoes/uso", () => {
  const usoPaths = unique([...read("app/uso/uso-content.tsx").matchAll(/["`](\/billing\/[a-z][a-z/-]*)(?=["`?])/g)].map((match) => match[1]));
  const backendPacks = read("../backend/src/billing/credit-packs.ts");
  // Lê a constante do backend: string entre aspas (SKU) ou inteiro com separador `_` (créditos, centavos).
  const backendPack = (name: string) => {
    const raw = backendPacks.match(new RegExp(`${name} = ("[^"]+"|[\\d_]+)`))?.[1] ?? "";
    return raw.startsWith('"') ? raw.slice(1, -1) : Number(raw.replaceAll("_", ""));
  };

  it("responde todo GET que a tela dispara no carregamento, nas duas rotas", () => {
    expect(usoPaths).toEqual(expect.arrayContaining(["/billing/usage-dashboard", "/billing/history", "/billing/usage-credit", "/billing/ai-credit-packs/balance", "/billing/ai-usage", "/billing/ai-credit-packs", "/billing/ai-credit-packs/pix-automatic"]));
    for (const route of ["/uso", "/configuracoes/uso"]) {
      for (const path of usoPaths) expect(payload(path, "GET", false, route)?.body, `${route} ${path}`).toBeTruthy();
    }
  });

  it("usa o SKU e o preço do backend", () => {
    const { sku } = body("/billing/ai-credit-packs", "/uso") as { sku: { sku: string; credits: number; priceCents: number; currency: string } };
    expect(sku).toEqual({ sku: backendPack("AI_CREDIT_PACK_SKU"), credits: backendPack("AI_CREDIT_PACK_CREDITS"), priceCents: backendPack("AI_CREDIT_PACK_PRICE_CENTS"), currency: "BRL" });
    expect((body("/billing/ai-credit-packs/pix-automatic", "/uso") as { sku: unknown }).sku).toEqual(sku);
  });

  it("mantém franquia, saldo de pacotes e consumo coerentes", () => {
    const dashboard = (body("/billing/usage-dashboard", "/uso") as { dashboard: Numbers & { usageUnit: string } }).dashboard;
    expect(dashboard.totalAvailable).toBe(dashboard.includedLimit + dashboard.rolloverGranted + dashboard.bonusGranted);
    expect(dashboard.totalUsed).toBe(dashboard.includedUsage + dashboard.rolloverUsage + dashboard.bonusUsage);
    expect(dashboard.usedPercentBps).toBe(Math.floor((dashboard.totalUsed * 10_000) / dashboard.totalAvailable));
    expect(dashboard.usageUnit).toBe("CREDIT");

    const { balance } = body("/billing/ai-credit-packs/balance", "/uso") as { balance: Numbers & { grants: Array<{ active: boolean; amount: number; consumedAmount: number; remaining: number }> } };
    expect(balance.availableCredits).toBe(balance.grants.filter((grant) => grant.active).reduce((sum, grant) => sum + grant.remaining, 0));
    expect(balance.grantedCredits).toBe(balance.grants.reduce((sum, grant) => sum + grant.amount, 0));
    expect(balance.consumedCredits).toBe(balance.grants.reduce((sum, grant) => sum + grant.consumedAmount, 0));
    // Pacote comprado no ciclo já está contado no bônus da franquia (texto da própria tela).
    expect(dashboard.bonusGranted).toBe(balance.grantedCredits);
    expect(dashboard.bonusUsage).toBe(balance.consumedCredits);

    const report = body("/billing/ai-usage", "/uso") as { summary: { calls: Numbers; turns: Numbers }; buckets: Array<Record<string, number | string>> };
    const bucketTotal = (field: string) => report.buckets.reduce((sum, bucket) => sum + (bucket[field] as number), 0);
    expect(report.summary.calls.count).toBe(bucketTotal("calls"));
    for (const field of ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "reasoningTokens"]) expect(report.summary.calls[field], field).toBe(bucketTotal(field));
    expect(report.summary.calls.costUsd).toBeCloseTo(bucketTotal("costUsd"), 2);
    expect(report.summary.turns.normalizedCredits).toBe(dashboard.totalUsed);

    const { history } = body("/billing/history", "/uso") as { history: Array<{ amount_cents: string; line_items: Array<{ amount_cents: number }> }> };
    expect(history.length).toBeGreaterThan(0);
    for (const invoice of history) expect(invoice.line_items.reduce((sum, line) => sum + line.amount_cents, 0)).toBe(Number(invoice.amount_cents));
  });
});

describe("contratos de heading com HelpHint", () => {
  const accepts = (route: string, text: string) => new RegExp(`^(?:${effective[route].heading})$`, "i").test(text);

  it.each([["/contatos/campos", "Campos personalizados", "Campos personalizados"], ["/contatos/lixeira", "Lixeira 1", "Lixeira"]])("%s aceita só o título e o sufixo do próprio HelpHint", (route, title, helpTitle) => {
    expect(accepts(route, title)).toBe(true);
    expect(accepts(route, `${title} ?`)).toBe(true);
    expect(accepts(route, `${title} ? Ajuda: ${helpTitle}`)).toBe(true);
    for (const wrong of [`${title} extra`, `Meu ${title}`, `${title} ??`, `Ajuda: ${title}`, `${title} ? Ajuda: Outro título`, ""]) expect(accepts(route, wrong), wrong).toBe(false);
  });

  it("/pos-venda aceita só o título e o sufixo do HelpHint da própria carteira, sem contágio nas rotas vizinhas", () => {
    const title = "Carteira de pós-venda", help = "Ajuda: o que é a carteira";
    for (const ok of [title, `${title} ?`, `${title} ? ${help}`]) expect(accepts("/pos-venda", ok), ok).toBe(true);
    for (const wrong of [`${title} extra`, `Meu ${title}`, `${title} ??`, help, `${title} ? Ajuda: ${title}`, `${title} ? Ajuda: Outro título`, "Carteira", ""]) expect(accepts("/pos-venda", wrong), wrong).toBe(false);
    for (const [route, exact] of [["/pos-venda/cobranca", "Cobranças de crediário"], ["/pos-venda/configurar", "Configurar checklist"]] as const) {
      expect(accepts(route, exact), route).toBe(true);
      expect(accepts(route, `${exact} ?`), route).toBe(false);
    }
    expect(ROUTE_CONTRACTS["/pos-venda"].heading, "contracts.mjs e o override de settings não podem divergir").toBe(effective["/pos-venda"].heading);
  });

  it("os contratos efetivos de /uso e /configuracoes/uso exigem o marker da tela real", () => {
    for (const route of ["/uso", "/configuracoes/uso"]) {
      expect(effective[route].heading, route).toBe("Uso");
      expect(effective[route].marker, route).toBe("Total usado|Histórico mensal");
    }
  });
});

describe("controles em contêiner visualmente oculto", () => {
  it("cobre a assinatura completa nos vetores de geometria", () => {
    expect(geometrySelfTestVectors.map((vector) => vector.name)).toEqual(expect.arrayContaining([
      "sr-only ancestor hides its control on purpose",
      "1px container without zero clip keeps failing",
      "1px zero-clip box in normal flow keeps failing",
      "large zero-clip card keeps failing",
      "fixed control clipped by a transformed sr-only ancestor is exempted",
      "fixed control inside a transformed box below the sr-only ancestor is clipped by it",
      "fixed control whose containing block sits above the sr-only ancestor escapes it",
      "fixed control escaping a sr-only ancestor is not exempted",
      "fixed control trapped by an outer sr-only ancestor through a transformed box is exempted"
    ]));
  });

  it("só exclui position:fixed do gate quando um containing block o prende no contêiner oculto, num browser real", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await page.setContent(`
      <style>
        body { margin: 0; }
        .sr { position: absolute; top: 100px; left: 10px; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        /* transform vira containing block de position:fixed: o botão fica preso na caixa de 1px. */
        .trapped { transform: translateZ(0); }
        .pinned { position: fixed; top: 300px; left: 10px; }
      </style>
      <h1>Fixture</h1>
      <div class="sr"><button id="fixed-escapes" class="pinned" type="button">Fixo escapa</button></div>
      <div class="sr trapped"><button id="fixed-trapped" class="pinned" type="button">Fixo preso</button></div>
      <div class="sr"><button id="in-flow" type="button">Em fluxo</button></div>
    `);
    try {
      const result = await measure(page, "dark", { heading: "Fixture", state: "empty" });
      const selectors = (list: Array<{ selector: string }>) => list.map((item) => item.selector).sort();
      const hidden = selectors(result.metrics.visuallyHiddenControls), clipped = selectors(result.metrics.clippedButtonDetails);
      // Fixed sem containing block não é excluído: segue no gate normal, que o reprova (no Chromium o clip zerado também esconde o fixed solto).
      // Só o fixed preso por transform e o botão em fluxo contam como oculto de verdade.
      expect(hidden).toEqual(["#fixed-trapped", "#in-flow"]);
      expect(clipped).toContain("#fixed-escapes");
      expect(clipped).not.toContain("#fixed-trapped");
    } finally {
      await browser.close();
    }
  }, 30_000);

  it("separa o thead .sr-only do botão cortado de verdade, num browser real", async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
    await page.setContent(`
      <style>
        body { margin: 0; }
        /* Mesmo padrão de .leads-table thead (leads.css, ≤900px) e .sr-only (base.css). */
        .hidden-thead { position: absolute; top: 100px; left: 10px; width: 1px; height: 1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        /* Contêiner colapsado por bug de layout: mesma caixa, sem clip zerado. */
        .collapsed { position: absolute; top: 200px; left: 10px; width: 1px; height: 1px; overflow: hidden; }
      </style>
      <h1>Fixture</h1>
      <button id="visible" type="button">Visível</button>
      <table><thead class="hidden-thead"><tr><th>Etapa <button id="in-sr-only" type="button">?</button></th></tr></thead><tbody><tr><td>Linha</td></tr></tbody></table>
      <div class="collapsed"><button id="in-collapsed" type="button">Colapsado</button></div>
    `);
    try {
      const result = await measure(page, "dark", { heading: "Fixture", state: "empty" });
      const selectors = (list: Array<{ selector: string }>) => list.map((item) => item.selector);
      const clipped = selectors(result.metrics.clippedButtonDetails);
      const hidden = selectors(result.metrics.visuallyHiddenControls);
      expect(hidden).toEqual(["#in-sr-only"]);
      expect(clipped).toContain("#in-collapsed");
      expect(clipped).not.toContain("#in-sr-only");
      expect(clipped).not.toContain("#visible");
      expect(result.metrics.clippedButtons).toBe(true);
    } finally {
      await browser.close();
    }
  }, 30_000);
});
