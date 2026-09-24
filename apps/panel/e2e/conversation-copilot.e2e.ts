import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

// SPEC R3 (copiloto): aceite em Chromium real. Todo /api e /backend é atendido
// por fixture no navegador — nenhuma chamada chega a backend, provedor de IA ou WhatsApp.
const viewports = [
  { name: "mobile", width: 360, height: 800 },
  { name: "desktop", width: 1440, height: 900 }
] as const;

const conversationA = "10000000-0000-4000-8000-00000000c0a1";
const conversationB = "10000000-0000-4000-8000-00000000c0b2";
const workspace = { id: "30000000-0000-4000-8000-000000000001", name: "Tripz Turismo", slug: "tripz-e2e", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" };
const session = {
  user: { id: "20000000-0000-4000-8000-000000000001", email: "copiloto@example.test", isRoot: false, name: "Operadora Copiloto" },
  activeWorkspace: workspace,
  workspaces: [workspace],
  permissions: ["conversations.read", "conversations.reply"],
  actorScope: "workspace"
};
const firstSuggestion = "Olá, Marina! O pacote para Aruba em março sai por R$ 7.890 por pessoa, com aéreo, hotel e traslados inclusos. Quer que eu reserve?";
const secondSuggestion = "Marina, para março temos Aruba a partir de R$ 7.890 por pessoa, com seguro viagem opcional. Posso enviar as datas disponíveis?";
const confirmText = "Substituir o rascunho atual pela sugestão da IA?";

type CopilotReply = { status: number; body: unknown };

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

function conversation(id: string, contactName: string, lastMessage: string) {
  return {
    id,
    contact_name: contactName,
    contact_phone: "+55 11 98765-4321",
    avatar_url: null,
    ai_active: false,
    handoff_reason: "manually_paused",
    last_message: lastMessage,
    last_message_at: "2026-08-17T16:10:00.000Z",
    assigned_user_id: session.user.id,
    assigned_user_email: session.user.email,
    assigned_user_first_name: "Operadora",
    status: "open",
    waiting_minutes: 7,
    contact_presence: "available",
    contact_presence_updated_at: new Date().toISOString(),
    signature_enabled: null,
    tags: [],
    unread_count: 0,
    last_message_sender: "contact",
    last_message_status: "read"
  };
}

const threads: Record<string, { conversation: ReturnType<typeof conversation>; messages: object[] }> = {
  [conversationA]: {
    conversation: conversation(conversationA, "Marina Ribeiro", "Também quero seguro viagem."),
    messages: [
      { id: "a-1", sender: "contact", content: "Qual o valor do pacote para Aruba em março?", media_type: null, status: "read", created_at: "2026-08-17T16:00:00.000Z" },
      { id: "a-2", sender: "human", sender_name: "Operadora", content: "Vou conferir as tarifas.", media_type: null, status: "read", created_at: "2026-08-17T16:02:00.000Z" },
      { id: "a-3", sender: "contact", content: "Também quero seguro viagem.", media_type: null, status: "read", created_at: "2026-08-17T16:10:00.000Z" }
    ]
  },
  [conversationB]: {
    conversation: conversation(conversationB, "Bruno Tavares", "Obrigado pelo retorno."),
    messages: [
      { id: "b-1", sender: "contact", content: "Obrigado pelo retorno.", media_type: null, status: "read", created_at: "2026-08-17T15:00:00.000Z" }
    ]
  }
};

async function installFixture(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.setItem("atendon_last_seen_version", "e2e");
  });
  const state = {
    copilotReplies: [] as CopilotReply[],
    copilotCalls: [] as Array<{ conversationId: string; body: unknown }>,
    messagePosts: [] as Array<{ conversationId: string; body: unknown; idempotencyKey?: string }>,
    confirmAnswers: [] as boolean[],
    dialogs: [] as Array<{ type: string; message: string }>
  };
  // window.confirm: registra cada diálogo e responde pela fila; diálogo inesperado é cancelado (e aparece em state.dialogs).
  page.on("dialog", (dialog) => {
    state.dialogs.push({ type: dialog.type(), message: dialog.message() });
    return state.confirmAnswers.shift() ? dialog.accept() : dialog.dismiss();
  });

  const handler = async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/(?:api|backend)/, "");
    const method = request.method();
    const conversationRoute = path.match(/^\/conversations\/([^/]+)\/(messages|copilot-suggestion|read)$/);
    const thread = conversationRoute ? threads[conversationRoute[1]] : undefined;

    if (path === "/me") return json(route, session);
    if (path === "/feature-flags") return json(route, { flags: { conversations_delta_v2: false, ai_turn_visibility_v1: false } });
    if (path === "/panel/version") return json(route, { version: "e2e", changelog: [] });
    if (path === "/me/notification-preferences") return json(route, { enabled: false, muted_conversations: [] });
    if (path === "/conversations/unread-counts") return json(route, { human: 0, ai: 0, scheduled: 0, resolved: 0 });
    if (path === "/conversations/assignees") return json(route, { assignees: [{ id: session.user.id, email: session.user.email }] });
    if (path === "/events") return route.fulfill({ status: 204, body: "" });
    if (path === "/conversations" && method === "GET") return json(route, { conversations: Object.values(threads).map((item) => item.conversation) });
    if (conversationRoute && thread) {
      const [, id, action] = conversationRoute;
      if (action === "read") return route.fulfill({ status: 204, body: "" });
      if (action === "messages" && method === "GET") return json(route, thread);
      if (action === "messages" && method === "POST") {
        state.messagePosts.push({ conversationId: id, body: request.postDataJSON(), idempotencyKey: request.headers()["idempotency-key"] });
        return json(route, { id: `sent-${state.messagePosts.length}` }, 201);
      }
      if (action === "copilot-suggestion" && method === "POST") {
        state.copilotCalls.push({ conversationId: id, body: request.postDataJSON() });
        const reply = state.copilotReplies.shift() ?? { status: 500, body: { error: "Chamada ao copiloto não prevista pelo E2E" } };
        return json(route, reply.body, reply.status);
      }
    }
    return json(route, {});
  };

  await page.route("**/api/**", handler);
  await page.route("**/backend/**", handler);
  return state;
}

async function openConversation(page: Page, contactName: string) {
  const back = page.getByRole("button", { name: "Voltar para a lista de conversas" });
  if (await back.isVisible()) await back.click();
  await page.locator(".conversation-list__item", { hasText: contactName }).click();
  await expect(page.locator(".conversation-thread__contact-name")).toHaveText(contactName);
}

async function expectNoOverflow(page: Page) {
  const metrics = await page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(metrics.scroll, `document overflowed by ${metrics.scroll - metrics.client}px`).toBeLessThanOrEqual(metrics.client + 1);
}

// Soft, para um único run relatar todos os controles fora da tela.
async function expectInsideViewport(page: Page, controls: Record<string, Locator>) {
  const { width, height } = page.viewportSize()!;
  for (const [label, control] of Object.entries(controls)) {
    const box = await control.boundingBox();
    expect.soft(box, `${label}: sem caixa renderizada`).not.toBeNull();
    if (!box) continue;
    expect.soft(box.x, `${label}: borda esquerda (${width}px)`).toBeGreaterThanOrEqual(0);
    expect.soft(box.x + box.width, `${label}: borda direita (${width}px)`).toBeLessThanOrEqual(width + 1);
    expect.soft(box.y + box.height, `${label}: borda inferior (${height}px)`).toBeLessThanOrEqual(height + 1);
  }
}

for (const viewport of viewports) {
  test(`copiloto gera só no clique, regenera, aplica sem enviar e mostra 402/403 (${viewport.name})`, async ({ page }, testInfo) => {
    const pageErrors: string[] = [];
    // Chromium registra no console cada fetch 402/403 recebido; são as respostas de erro previstas pelo próprio teste.
    page.on("console", (message) => { if (message.type() === "error" && !/status of 40[23]\b/.test(message.text())) pageErrors.push(message.text()); });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize(viewport);
    const state = await installFixture(page);
    await page.goto(`/conversas?id=${conversationA}`, { waitUntil: "domcontentloaded" });

    const composer = page.locator("form.conversation-composer");
    const draft = composer.getByRole("textbox", { name: "Mensagem" });
    const generate = composer.getByRole("button", { name: "Gerar sugestão da IA" });
    const regenerate = composer.getByRole("button", { name: "Gerar outra sugestão da IA" });
    const chip = composer.getByRole("group", { name: "Sugestão da IA" });
    const useSuggestion = chip.getByRole("button", { name: "Usar sugestão" });
    await expect(page.locator(".conversation-thread").getByText("Qual o valor do pacote para Aruba em março?")).toBeVisible();
    await expect(generate).toBeEnabled();

    // Montagem, digitação e troca de conversa nunca chamam a IA.
    await draft.pressSequentially("Olá, Marina");
    await openConversation(page, "Bruno Tavares");
    await openConversation(page, "Marina Ribeiro");
    await expect(draft).toHaveValue("");
    await page.waitForTimeout(500); // ponytail: janela fixa para provar ausência de chamada em segundo plano; a contagem exata no fim cobre chamadas tardias.
    expect(state.copilotCalls).toEqual([]);
    await expect(chip).toHaveCount(0);

    // Um clique explícito = uma geração; histórico parcial é avisado no chip.
    state.copilotReplies.push({ status: 200, body: { suggestion: firstSuggestion, context_complete: false, messages_used: 2, messages_total: 5 } });
    await generate.click();
    await expect(chip).toContainText(firstSuggestion);
    await expect(chip.getByText("Histórico parcial: a sugestão considerou as 2 mensagens mais recentes de 5.")).toBeVisible();
    expect(state.copilotCalls).toEqual([{ conversationId: conversationA, body: {} }]);
    await expectInsideViewport(page, {
      "chip da sugestão": chip,
      "Usar sugestão": useSuggestion,
      "Descartar sugestão": chip.getByRole("button", { name: "Descartar sugestão" }),
      "Gerar outra sugestão": regenerate,
      "Enviar mensagem": composer.getByRole("button", { name: "Enviar mensagem" })
    });
    await expectNoOverflow(page);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).include("[role='group'][aria-label='Sugestão da IA']").analyze();
    expect(axe.violations.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map(({ target }) => target) }))).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`conversation-copilot-${viewport.name}.png`), animations: "disabled" });

    // Regenerar envia a sugestão anterior e mostra a alternativa.
    state.copilotReplies.push({ status: 200, body: { suggestion: secondSuggestion, context_complete: true, messages_used: 5, messages_total: 5 } });
    await regenerate.click();
    await expect(chip).toContainText(secondSuggestion);
    await expect(chip).not.toContainText(firstSuggestion);
    await expect(chip.getByText(/Histórico parcial/)).toHaveCount(0);
    expect(state.copilotCalls[1]).toEqual({ conversationId: conversationA, body: { previous_suggestion: firstSuggestion } });

    // Rascunho vazio: aplica sem confirmação, fica editável e nada é enviado.
    await useSuggestion.click();
    await expect(draft).toHaveValue(secondSuggestion);
    await expect(draft).toBeFocused();
    await draft.press("End");
    await draft.pressSequentially(" Abraço!");
    await expect(draft).toHaveValue(`${secondSuggestion} Abraço!`);
    expect(state.dialogs).toEqual([]);

    // Rascunho preenchido: exige window.confirm; cancelar preserva, aceitar substitui.
    state.confirmAnswers.push(false);
    await useSuggestion.click();
    await expect.poll(() => state.dialogs.length).toBe(1);
    await expect(draft).toHaveValue(`${secondSuggestion} Abraço!`);
    await draft.fill("Rascunho do operador");
    state.confirmAnswers.push(true);
    await useSuggestion.click();
    await expect(draft).toHaveValue(secondSuggestion);
    expect(state.dialogs).toEqual([{ type: "confirm", message: confirmText }, { type: "confirm", message: confirmText }]);
    await page.waitForTimeout(500); // ponytail: mesma janela fixa — aplicar a sugestão não pode disparar POST /messages.
    expect(state.messagePosts).toEqual([]);

    // O envio acontece só pelo submit existente (mockado).
    await composer.getByRole("button", { name: "Enviar mensagem" }).click();
    await expect.poll(() => state.messagePosts.length).toBe(1);
    expect(state.messagePosts[0]).toMatchObject({ conversationId: conversationA, body: { text: secondSuggestion } });
    expect(state.messagePosts[0].idempotencyKey).toBeTruthy();
    await expect(draft).toHaveValue("");

    // 402/403: erro acionável visível, sugestão válida anterior mantida, nova tentativa liberada.
    for (const [status, error] of [[402, "Limite de interações de IA do plano atingido"], [403, "Permissão insuficiente"]] as const) {
      state.copilotReplies.push({ status, body: { error, ...(status === 402 ? { code: "ai_quota_exceeded" } : {}) } });
      await regenerate.click();
      await expect(page.getByRole("alert").filter({ hasText: error }).first()).toBeVisible();
      await expect(chip).toContainText(secondSuggestion);
      await expect(regenerate).toBeEnabled();
      await expectNoOverflow(page);
    }
    expect(state.copilotCalls.slice(2)).toEqual([
      { conversationId: conversationA, body: { previous_suggestion: secondSuggestion } },
      { conversationId: conversationA, body: { previous_suggestion: secondSuggestion } }
    ]);

    // Trocar de conversa depois da sugestão: nada é levado para a outra conversa nem gerado.
    await openConversation(page, "Bruno Tavares");
    await expect(chip).toHaveCount(0);
    await page.waitForTimeout(300);
    expect(state.copilotCalls).toHaveLength(4);
    expect(state.messagePosts).toHaveLength(1);
    expect(pageErrors).toEqual([]);
  });
}
