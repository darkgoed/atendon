import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { createSchedulingToolExecutor, normalizeModelSearchResult } from "../src/modules/ai-router/tool-executor.js";
import { assertFutureAppointmentStart, createAppointment, verificarHorarios } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId = ""; const phone = "5511999990000";
let closerUserId = "";

beforeAll(async () => {
  const tenant = await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`ToolExec ${randomUUID()}`]);
  tenantId = tenant.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    closerUserId = (await client.query<{ id: string }>(
      "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
      [`tool-executor-closer-${randomUUID()}@test.local`]
    )).rows[0].id;
    const closerMemberId = (await client.query<{ id: string }>(
      `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
       SELECT $1,$2,id,'active',now()
       FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
       RETURNING id`,
      [tenantId, closerUserId]
    )).rows[0].id;
    await client.query(
      "INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)",
      [tenantId, closerMemberId]
    );
    await client.query("INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'financiamento','Financiamento')", [tenantId]);
    await client.query("INSERT INTO scheduling_partners(tenant_id,id,name,priority_order,proposal_link) VALUES($1,'newave','Newave',1,'https://example.test/newave')", [tenantId]);
    await client.query("INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity) VALUES($1,'restinga','Restinga','09:00','18:00',ARRAY[1,2,3,4,5]::smallint[],60,1)", [tenantId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});
afterAll(async () => {
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=$1", [closerUserId]);
  await pool.end();
});

describe("scheduling tool executor", () => {
  it("normalizes ambiguous model search output conservatively", () => {
    expect(normalizeModelSearchResult("encontrado")).toBe("encontrado");
    expect(normalizeModelSearchResult("Não foi encontrado em fontes confiáveis.")).toBe("não encontrado");
    expect(normalizeModelSearchResult("Sem resultados oficiais, apenas rumores.")).toBe("não encontrado");
    expect(normalizeModelSearchResult("Não há confirmação oficial desse modelo.")).toBe("não encontrado");
    expect(normalizeModelSearchResult("talvez seja um vazamento")).toBe("não encontrado");
  });

  it("books the exact verified customer-selected time even if the model copies another slot", async () => {
    const selectedPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Seleção exata','whatsapp','qualificado',4) RETURNING id`,
      [tenantId, selectedPhone]
    );
    const availabilityObserved = vi.fn();
    const executeTool = createSchedulingToolExecutor(tenantId, selectedPhone, undefined, {
      schedulingIntent: { kind: "direct_schedule", time: "16:00" },
      onMeetingAvailabilityChecked: availabilityObserved
    } as never);
    const availability = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: "restinga",
      data: "2030-01-08",
      horario_solicitado: "16:00"
    })));
    expect(availability.horario_solicitado.disponivel).toBe(true);

    const booked = JSON.parse(await executeTool("agendar_reuniao", JSON.stringify({
      agenda_id: "restinga",
      start: "2030-01-08T13:00:00.000Z"
    })));
    expect(booked.agendamento.start).toBe(availability.horario_solicitado.start);
    expect(booked.agendamento.start).toContain("T16:00:00");
    await pool.query("DELETE FROM scheduling_appointments WHERE lead_id=$1 AND tenant_id=$2", [lead.rows[0].id, tenantId]);
    await pool.query("DELETE FROM scheduling_leads WHERE id=$1", [lead.rows[0].id]);
  });

  it("commits a direct meeting selection as soon as availability confirms it", async () => {
    const selectedPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Seleção direta','whatsapp','qualificado',4) RETURNING id`,
      [tenantId, selectedPhone]
    );
    const journalInputs: Array<{ toolName: string; callOrdinal: number }> = [];
    const transactionalOutcomes = vi.fn();
    const executeTool = createSchedulingToolExecutor(tenantId, selectedPhone, undefined, {
      conversationId: randomUUID(),
      inboundExternalId: `inbound-${randomUUID()}`,
      aiTurnId: randomUUID(),
      journal: async (input, execute) => {
        journalInputs.push({ toolName: input.toolName, callOrdinal: input.callOrdinal });
        return {
          journalId: randomUUID(),
          status: "succeeded" as const,
          resultText: await execute(),
          occurredAt: new Date().toISOString()
        };
      },
      enabledToolNames: ["verificar_horarios_reuniao", "agendar_reuniao"],
      schedulingIntent: { kind: "direct_schedule", time: "16:00" },
      directSchedulingAction: "agendar_reuniao",
      onTransactionalOutcome: transactionalOutcomes
    });

    const result = JSON.parse(await executeTool(
      "verificar_horarios_reuniao",
      JSON.stringify({
        agenda_id: "restinga",
        data: "2030-01-08",
        horario_solicitado: "16:00"
      }),
      { providerCallId: "availability-1", ordinal: 0 }
    ));

    expect(result.agendamento).toMatchObject({
      status: "confirmado",
      start: "2030-01-08T16:00:00.000Z"
    });
    expect(journalInputs).toEqual([
      { toolName: "verificar_horarios_reuniao", callOrdinal: 0 },
      { toolName: "agendar_reuniao", callOrdinal: 1_000_000 }
    ]);
    expect(transactionalOutcomes).toHaveBeenCalledWith(expect.objectContaining({
      status: "succeeded",
      action: "schedule_meeting"
    }));

    const repeated = JSON.parse(await executeTool(
      "agendar_reuniao",
      JSON.stringify({ agenda_id: "restinga", start: "2030-01-08T13:00:00.000Z" }),
      { providerCallId: "model-repeated-action", ordinal: 1 }
    ));
    expect(repeated.agendamento.id).toBe(result.agendamento.id);
    expect(journalInputs).toHaveLength(2);

    await pool.query("DELETE FROM scheduling_appointments WHERE lead_id=$1 AND tenant_id=$2", [lead.rows[0].id, tenantId]);
    await pool.query("DELETE FROM scheduling_leads WHERE id=$1", [lead.rows[0].id]);
  });

  it("commits a direct time change through the real rescheduling action", async () => {
    const selectedPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Reagendamento direto','whatsapp','agendado',4) RETURNING id`,
      [tenantId, selectedPhone]
    );
    const active = await createAppointment(tenantId, {
      lead_id: lead.rows[0].id,
      unidade_id: "restinga",
      start: "2030-01-09T11:00:00.000Z"
    });
    const tools: string[] = [];
    const executeTool = createSchedulingToolExecutor(tenantId, selectedPhone, undefined, {
      conversationId: randomUUID(),
      inboundExternalId: `inbound-${randomUUID()}`,
      aiTurnId: randomUUID(),
      journal: async (input, execute) => {
        tools.push(input.toolName);
        return {
          journalId: randomUUID(),
          status: "succeeded" as const,
          resultText: await execute(),
          occurredAt: new Date().toISOString()
        };
      },
      enabledToolNames: ["verificar_horarios_reuniao", "reagendar_reuniao"],
      schedulingIntent: { kind: "direct_schedule", time: "16:00" },
      directSchedulingAction: "reagendar_reuniao"
    });

    const result = JSON.parse(await executeTool(
      "verificar_horarios_reuniao",
      JSON.stringify({ agenda_id: "restinga", data: "2030-01-09", horario_solicitado: "16:00" }),
      { providerCallId: "availability-reschedule", ordinal: 0 }
    ));

    expect(tools).toEqual(["verificar_horarios_reuniao", "reagendar_reuniao"]);
    expect(result.agendamento).toMatchObject({
      id: active.id,
      status: "reagendado",
      start: "2030-01-09T16:00:00.000Z"
    });

    await pool.query("DELETE FROM scheduling_appointments WHERE lead_id=$1 AND tenant_id=$2", [lead.rows[0].id, tenantId]);
    await pool.query("DELETE FROM scheduling_leads WHERE id=$1", [lead.rows[0].id]);
  });

  it("lists tenant configuration through the read tools", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone);
    expect(JSON.parse(await executeTool("consultar_categorias", "{}"))).toEqual({ categorias: [{ id: "financiamento", tenant: tenantId, nome: "Financiamento", ativa: true }] });
    expect(JSON.parse(await executeTool("consultar_parceiros", "{}")).parceiros).toHaveLength(1);
    expect(JSON.parse(await executeTool("consultar_unidades", "{}")).unidades).toHaveLength(1);
  });

  it("excludes slots that have already started from AI availability", async () => {
    const now = new Date("2030-01-07T16:30:00.000Z");
    const allSlots = await verificarHorarios(tenantId, "restinga", "2030-01-07", { now });
    const upcomingSlots = await verificarHorarios(tenantId, "restinga", "2030-01-07", {
      excludeStartedSlots: true,
      now
    });

    expect(upcomingSlots.horarios.length).toBeGreaterThan(0);
    expect(upcomingSlots.horarios.length).toBeLessThan(allSlots.horarios.length);
    expect(upcomingSlots.horarios.every((slot) => new Date(slot.start).getTime() > now.getTime())).toBe(true);
  });

  it("applies a safe lead margin to AI availability and appointment starts", async () => {
    const now = new Date("2030-01-07T15:30:00.000Z");
    const minimumLeadTimeMinutes = 45;
    const availability = await verificarHorarios(tenantId, "restinga", "2030-01-07", {
      excludeStartedSlots: true,
      now,
      minimumLeadTimeMinutes
    });

    expect(availability.horarios.length).toBeGreaterThan(0);
    expect(availability.horarios.every((slot) =>
      new Date(slot.start).getTime() > now.getTime() + minimumLeadTimeMinutes * 60_000
    )).toBe(true);
    expect(() => assertFutureAppointmentStart(
      new Date("2030-01-07T16:00:00.000Z"),
      now,
      minimumLeadTimeMinutes
    )).toThrow(/45 minutos de antecedência/);
    expect(() => assertFutureAppointmentStart(
      new Date("2030-01-07T17:00:00.000Z"),
      now,
      minimumLeadTimeMinutes
    )).not.toThrow();
  });

  it("checks a requested broken-minute fit inside business hours", async () => {
    const requested = await verificarHorarios(tenantId, "restinga", "2030-01-07", {
      requestedTime: "12:40",
      excludeStartedSlots: true,
      now: new Date("2030-01-07T12:36:00.000Z")
    });
    const tooLate = await verificarHorarios(tenantId, "restinga", "2030-01-07", {
      requestedTime: "17:40",
      excludeStartedSlots: true,
      now: new Date("2030-01-07T12:36:00.000Z")
    });

    expect(requested.horarios).toEqual([{
      start: "2030-01-07T12:40:00.000Z",
      end: "2030-01-07T13:40:00.000Z",
      vagas: 1,
      capacidade: 1
    }]);
    expect(requested.horario_solicitado).toMatchObject({ disponivel: true });
    expect(tooLate.horarios).toEqual([]);
    expect(tooLate.horario_solicitado).toMatchObject({ disponivel: false });
    expect(tooLate.horarios_proximos).toHaveLength(3);
  });

  it("fits 12h40 through 13h40 at the fixed Newave clock in America/Sao_Paulo", async () => {
    const workspace = await pool.query<{ id: string }>(
      "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','America/Sao_Paulo') RETURNING id",
      [`Newave clock ${randomUUID()}`]
    );
    const fixedTenantId = workspace.rows[0].id;
    try {
      await pool.query(
        `INSERT INTO scheduling_units(
           tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
         ) VALUES($1,'reunioes','Reuniões','09:00','19:00',ARRAY[1,2,3,4,5]::smallint[],60,1)`,
        [fixedTenantId]
      );
      const lead = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,source)
         VALUES($1,$2,'whatsapp') RETURNING id`,
        [fixedTenantId, `5511${Date.now().toString().slice(-8)}`]
      );
      const availability = await verificarHorarios(fixedTenantId, "reunioes", "2026-07-23", {
        requestedTime: "12:40",
        excludeStartedSlots: true,
        now: new Date("2026-07-23T15:36:00.000Z")
      });
      expect(availability.horarios).toEqual([{
        start: "2026-07-23T15:40:00.000Z",
        end: "2026-07-23T16:40:00.000Z",
        vagas: 1,
        capacidade: 1
      }]);
      const appointment = await createAppointment(fixedTenantId, {
        lead_id: lead.rows[0].id,
        unidade_id: "reunioes",
        start: availability.horarios[0]!.start
      }, { now: new Date("2026-07-23T15:36:00.000Z") });
      expect(new Date(appointment.start as unknown as string).toISOString()).toBe("2026-07-23T15:40:00.000Z");
      expect(new Date(appointment.end as unknown as string).toISOString()).toBe("2026-07-23T16:40:00.000Z");
    } finally {
      await pool.query("DELETE FROM tenants WHERE id=$1", [fixedTenantId]);
    }
  });

  it("instructs the model to fall back when no partner is registered", async () => {
    const emptyTenant = await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`ToolExec vazio ${randomUUID()}`]);
    try {
      const executeTool = createSchedulingToolExecutor(emptyTenant.rows[0].id, phone);
      const result = JSON.parse(await executeTool("consultar_parceiros", "{}"));
      expect(result.parceiros).toEqual([]);
      expect(result.instrucao).toMatch(/Nunca prometa enviar um link/);
    } finally {
      await pool.query("DELETE FROM tenants WHERE id=$1", [emptyTenant.rows[0].id]);
    }
  });

  it("returns a clear error when acting on a lead that has not been registered yet", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, "5511888880000");
    const result = JSON.parse(await executeTool("agendar_visita", JSON.stringify({ unidade_id: "restinga", start: "2030-01-07T09:00:00.000Z" })));
    expect(result.erro).toMatch(/chame registrar_lead primeiro/);
  });

  it.each([
    ["qualificar_lead", {
      estrelas: 3,
      respostas: {},
      resumo: "Ainda em avaliação.",
      justificativa: "Contexto parcial."
    }],
    ["agendar_reuniao", {
      agenda_id: "restinga",
      start: "2030-01-07T11:00:00.000Z"
    }]
  ])("requires registrar_lead before %s", async (toolName, argumentsObject) => {
    const executeTool = createSchedulingToolExecutor(tenantId, `5511${randomUUID().replaceAll("-", "").slice(0, 8)}`);
    const result = JSON.parse(await executeTool(toolName, JSON.stringify(argumentsObject)));
    expect(result.erro).toMatch(/chame registrar_lead primeiro/);
  });

  it("rejects a tool that is unexpected for the canonical state before execution", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone, undefined, {
      conversationId: "conversation-state-gate",
      inboundExternalId: "inbound-state-gate",
      aiTurnId: randomUUID(),
      journal: async (_input, execute) => execute(),
      enabledToolNames: ["agendar_reuniao"],
      canonicalState: "awaiting_confirmation"
    });

    const result = JSON.parse(await executeTool("agendar_reuniao", JSON.stringify({
      agenda_id: "restinga",
      start: "2031-01-06T09:00:00.000Z"
    })));

    expect(result.erro).toMatch(/incompatível com o estado awaiting_confirmation/);
  });

  it("rechecks persisted qualification and blocks a stale repeated qualification", async () => {
    const qualifiedPhone = `5511${randomUUID().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`;
    await pool.query(
      `INSERT INTO scheduling_leads(
         tenant_id,phone,source,status,qualification_stars,qualification_answers,
         qualification_summary,qualification_reason,qualification_evaluated_at
       ) VALUES($1,$2,'whatsapp','qualificado',4,'{}','Qualificado','Contexto suficiente',now())`,
      [tenantId, qualifiedPhone]
    );
    const executeTool = createSchedulingToolExecutor(tenantId, qualifiedPhone, undefined, {
      conversationId: "conversation-stale-qualification",
      inboundExternalId: "inbound-stale-qualification",
      aiTurnId: randomUUID(),
      journal: async (_input, execute) => execute(),
      enabledToolNames: ["qualificar_lead"],
      canonicalState: "qualification"
    });

    const result = JSON.parse(await executeTool("qualificar_lead", JSON.stringify({
      estrelas: 5,
      respostas: {},
      resumo: "Tentativa repetida",
      justificativa: "Não deve sobrescrever"
    })));

    expect(result.erro).toMatch(/já foi concluída/);
    const persisted = await pool.query<{ qualification_stars: number; qualification_summary: string }>(
      "SELECT qualification_stars,qualification_summary FROM scheduling_leads WHERE tenant_id=$1 AND phone=$2",
      [tenantId, qualifiedPhone]
    );
    expect(persisted.rows[0]).toMatchObject({
      qualification_stars: 4,
      qualification_summary: "Qualificado"
    });
  });

  it("rechecks persisted appointments and blocks duplicate creation from stale booking state", async () => {
    const bookedPhone = `5511${randomUUID().replace(/\D/g, "").padEnd(8, "0").slice(0, 8)}`;
    const lead = await pool.query<{ id: string }>(
      `INSERT INTO scheduling_leads(
         tenant_id,phone,source,status,qualification_stars,qualification_answers,
         qualification_summary,qualification_reason,qualification_evaluated_at
       ) VALUES($1,$2,'whatsapp','qualificado',4,'{}','Qualificado','Contexto suficiente',now())
       RETURNING id`,
      [tenantId, bookedPhone]
    );
    const active = await createAppointment(tenantId, {
      lead_id: lead.rows[0].id,
      unidade_id: "restinga",
      start: "2031-01-06T09:00:00.000Z"
    });
    const executeTool = createSchedulingToolExecutor(tenantId, bookedPhone, undefined, {
      conversationId: "conversation-stale-booking",
      inboundExternalId: "inbound-stale-booking",
      aiTurnId: randomUUID(),
      journal: async (_input, execute) => execute(),
      enabledToolNames: ["agendar_visita"],
      canonicalState: "booking"
    });

    const result = JSON.parse(await executeTool("agendar_visita", JSON.stringify({
      unidade_id: "restinga",
      start: "2031-01-06T11:00:00.000Z"
    })));

    expect(result.erro).toMatch(/Já existe um compromisso ativo/);
    const appointments = await pool.query<{ id: string }>(
      `SELECT id FROM scheduling_appointments
       WHERE tenant_id=$1 AND lead_id=$2 AND status IN ('confirmado','reagendado')`,
      [tenantId, lead.rows[0].id]
    );
    expect(appointments.rows.map((row) => row.id)).toEqual([active.id]);
  });

  it("registers a lead by the conversation phone, without the model supplying it, then schedules and cancels a visit", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone);
    const registered = JSON.parse(await executeTool("registrar_lead", JSON.stringify({
      nome: "Arthur Müller", categoria_interesse_id: "financiamento", unidade_id: "restinga"
    })));
    expect(registered.lead).toMatchObject({ telefone: phone, nome: "Arthur Müller", origem: "whatsapp" });

    const horarios = JSON.parse(await executeTool("verificar_horarios", JSON.stringify({ unidade_id: "restinga", data: "2030-01-07" })));
    expect(horarios.horarios.length).toBeGreaterThan(0);

    const scheduled = JSON.parse(await executeTool("agendar_visita", JSON.stringify({ unidade_id: "restinga", start: "2030-01-07T09:00:00.000Z" })));
    expect(scheduled.agendamento).toMatchObject({ unidade_id: "restinga", status: "confirmado" });

    const conflict = JSON.parse(await executeTool("agendar_visita", JSON.stringify({ unidade_id: "restinga", start: "2030-01-07T09:00:00.000Z" })));
    if (conflict.agendamento) {
      expect(conflict.agendamento.id).toBe(scheduled.agendamento.id);
    } else {
      expect(conflict.erro).toBeDefined();
    }

    const cancelled = JSON.parse(await executeTool("cancelar_visita", "{}"));
    expect(cancelled.agendamento).toMatchObject({ id: scheduled.agendamento.id, status: "cancelado" });

    const transferred = JSON.parse(await executeTool("transferir_atendente", JSON.stringify({ motivo: "Cliente pediu atendente" })));
    expect(transferred.erro).toMatch(/pedido explícito do contato/i);
  });

  it("registers the lead while discarding empty text and optional references invented by the model", async () => {
    const inventedReferencePhone = `5511${Date.now().toString().slice(-8)}`;
    const executeTool = createSchedulingToolExecutor(tenantId, inventedReferencePhone);

    const registered = JSON.parse(await executeTool("registrar_lead", JSON.stringify({
      nome: "   ",
      categoria_interesse_id: "categoria-inventada",
      unidade_id: "unidade-inventada",
      parceiro_id: "parceiro-inventado",
      origem: ""
    })));

    expect(registered.erro).toBeUndefined();
    expect(registered.lead).toMatchObject({
      telefone: inventedReferencePhone,
      nome: null,
      categoria_interesse_id: null,
      unidade_id: null,
      parceiro_id: null,
      origem: "whatsapp"
    });
  });

  it("delegates pesquisar_modelo to the injected web search", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone, async () => "encontrado");
    const result = JSON.parse(await executeTool("pesquisar_modelo", JSON.stringify({ modelo: "Samsung Galaxy S26 Pro" })));
    expect(result.resultado).toBe("encontrado");
    expect(result.instrucao).toMatch(/nunca repasse ao cliente/);
  });

  it("instructs the model not to praise a model that search did not confirm", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone, async () => "Não foi encontrado em fontes confiáveis");
    const result = JSON.parse(await executeTool("pesquisar_modelo", JSON.stringify({ modelo: "iPhone 18 Pro Max" })));
    expect(result.resultado).toBe("não encontrado");
    expect(result.instrucao).toMatch(/não elogie/);
    expect(result.instrucao).toMatch(/boa escolha/);
  });

  it("degrades gracefully when pesquisar_modelo has no search available", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone);
    const result = JSON.parse(await executeTool("pesquisar_modelo", JSON.stringify({ modelo: "Samsung Galaxy S26 Pro" })));
    expect(result.erro).toMatch(/não valide nem elogie/);
  });

  it("uses contextual web search only through the injected Newave helper", async () => {
    const searchBusinessContext = vi.fn().mockResolvedValue("Plano Mútuo MEDC é a correspondência provável.");
    const executeTool = createSchedulingToolExecutor(tenantId, phone, undefined, {
      conversationId: randomUUID(),
      inboundExternalId: `inbound-${randomUUID()}`,
      aiTurnId: randomUUID(),
      journal: async (_input, execute) => execute(),
      enabledToolNames: ["pesquisar_contexto"],
      searchBusinessContext
    });
    const result = JSON.parse(await executeTool("pesquisar_contexto", JSON.stringify({ termo: "plano mutu magic" })));
    expect(searchBusinessContext).toHaveBeenCalledWith("plano mutu magic");
    expect(result.contexto).toContain("Plano Mútuo MEDC");
    expect(result.instrucao).toMatch(/interno/i);
  });

  it("skips identical lead registrations but permits a relevant update", async () => {
    const journal = vi.fn()
      .mockResolvedValueOnce(JSON.stringify({
        lead: {
          id: "lead-existing",
          nome: "Ana Souza",
          categoria_interesse_id: null,
          unidade_id: null,
          parceiro_id: null,
          status: "qualificado",
          origem: "whatsapp",
          origem_facebook: {}
        }
      }));
    const executeTool = createSchedulingToolExecutor(tenantId, phone, undefined, {
      conversationId: randomUUID(),
      inboundExternalId: `inbound-${randomUUID()}`,
      aiTurnId: randomUUID(),
      journal,
      enabledToolNames: ["registrar_lead"],
      existingLead: {
        id: "lead-existing",
        name: "Ana Souza",
        source: "whatsapp",
        status: "em_atendimento",
        facebookAttribution: {}
      }
    });

    const duplicate = JSON.parse(await executeTool(
      "registrar_lead",
      JSON.stringify({ nome: "  ana souza  " }),
      { ordinal: 0, providerCallId: "duplicate" }
    ));
    expect(duplicate).toMatchObject({ alterado: false, deduplicado: true });
    expect(journal).not.toHaveBeenCalled();

    await executeTool(
      "registrar_lead",
      JSON.stringify({ nome: "Ana Souza", status: "qualificado" }),
      { ordinal: 1, providerCallId: "update" }
    );
    expect(journal).toHaveBeenCalledOnce();

    await executeTool(
      "registrar_lead",
      JSON.stringify({ nome: "Ana Souza", status: "qualificado" }),
      { ordinal: 2, providerCallId: "same-update" }
    );
    expect(journal).toHaveBeenCalledOnce();
  });

  it("reports an unknown tool name without throwing", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone);
    expect(JSON.parse(await executeTool("nao_existe", "{}"))).toEqual({ erro: "Ferramenta desconhecida: nao_existe" });
  });

  it("aborts a transactional turn when the journal itself cannot persist", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, phone, undefined, {
      conversationId: randomUUID(),
      inboundExternalId: `inbound-${randomUUID()}`,
      aiTurnId: randomUUID(),
      journal: vi.fn().mockRejectedValue(new Error("journal unavailable")),
      enabledToolNames: ["cancelar_visita"]
    });

    await expect(executeTool(
      "cancelar_visita",
      "{}",
      { ordinal: 0, providerCallId: "journal-down" }
    )).rejects.toThrow("journal unavailable");
  });

  it("enforces enabled tools and lets every qualified lead schedule a meeting", async () => {
    const newavePhone = `5541${Date.now().toString().slice(-8)}`;
    const executeTool = createSchedulingToolExecutor(tenantId, newavePhone, undefined, {
      conversationId: randomUUID(),
      inboundExternalId: `inbound-${randomUUID()}`,
      aiTurnId: randomUUID(),
      journal: async (_input, execute) => execute(),
      enabledToolNames: ["registrar_lead", "qualificar_lead", "consultar_agendas", "verificar_horarios_reuniao", "agendar_reuniao", "reagendar_reuniao", "cancelar_reuniao", "transferir_atendente"],
      facebookAttribution: { provider: "meta", channel: "facebook", source_id: "ad-tool" }
    });
    expect(JSON.parse(await executeTool("pesquisar_modelo", JSON.stringify({ modelo: "iPhone 18" }))).erro)
      .toMatch(/não habilitada/);
    const registered = JSON.parse(await executeTool("registrar_lead", JSON.stringify({ nome: "Lead Newave" })));
    expect(registered.lead).toMatchObject({ origem: "facebook", origem_facebook: { source_id: "ad-tool" } });

    const low = JSON.parse(await executeTool("qualificar_lead", JSON.stringify({
      estrelas: 2,
      respostas: {
        nicho: "resposta longa e livre sobre uma ótica",
        instagram: "",
        possibilidade_investimento: "   "
      },
      resumo: "Ainda há dúvidas importantes.",
      justificativa: "A equipe humana deve avaliar uma oferta alternativa."
    })));
    expect(low).toMatchObject({ pode_agendar_reuniao: true, requer_decisao_humana: false });
    expect(low.instrucao).toMatch(/independentemente da nota/);
    expect(JSON.parse(await executeTool("consultar_agendas", "{}")).agendas).toHaveLength(1);
    const suggestions = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: "restinga",
      data: "2030-01-07",
      horario_solicitado: null
    })));
    expect(suggestions.erro).toBeUndefined();
    expect(suggestions.duration_min).toBe(60);
    expect(suggestions.horarios.length).toBeGreaterThan(0);
    const requested = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: "restinga",
      data: "2030-01-07",
      horario_solicitado: "11:40"
    })));
    expect(requested.horarios).toEqual([expect.objectContaining({
      start: "2030-01-07T11:40:00.000Z",
      end: "2030-01-07T12:40:00.000Z"
    })]);
    expect(requested.duration_min).toBe(60);
    const meeting = JSON.parse(await executeTool("agendar_reuniao", JSON.stringify({ agenda_id: "restinga", start: requested.horarios[0].start })));
    expect(meeting.agendamento).toMatchObject({
      status: "confirmado",
      unidade_id: "restinga",
      start: "2030-01-07T11:40:00.000Z",
      end: "2030-01-07T12:40:00.000Z",
      duration_min: 60
    });
    // Um start que a agenda não devolveu neste turno é recusado: era assim que o
    // modelo reservava um horário diferente do combinado com o contato.
    const invented = JSON.parse(await executeTool("reagendar_reuniao", JSON.stringify({ start: "2030-01-07T15:40:00.000Z" })));
    expect(invented.erro).toMatch(/não está entre os que a agenda devolveu/);
    const target = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: "restinga",
      data: "2030-01-07",
      horario_solicitado: "12:40"
    })));
    expect(target.horario_solicitado).toMatchObject({ disponivel: true });
    const moved = JSON.parse(await executeTool("reagendar_reuniao", JSON.stringify({ start: target.horario_solicitado.start })));
    expect(moved.agendamento).toMatchObject({ id: meeting.agendamento.id, status: "reagendado" });
    const cancelled = JSON.parse(await executeTool("cancelar_reuniao", "{}"));
    expect(cancelled.agendamento).toMatchObject({ id: meeting.agendamento.id, status: "cancelado" });

    const transferred = JSON.parse(await executeTool("transferir_atendente", JSON.stringify({ motivo: "Revisão manual necessária" })));
    expect(transferred.erro).toMatch(/pedido explícito do contato/i);
  });

  it("propagates a non-default configured slot duration through availability and reservation", async () => {
    await pool.query(
      "UPDATE scheduling_units SET slot_duration_min=30 WHERE tenant_id=$1 AND id='restinga'",
      [tenantId]
    );
    const phone = `5531${Date.now().toString().slice(-8)}`;
    const onMeetingAvailabilityChecked = vi.fn();
    const executeTool = createSchedulingToolExecutor(tenantId, phone, undefined, {
      conversationId: randomUUID(),
      inboundExternalId: `inbound-duration-${randomUUID()}`,
      aiTurnId: randomUUID(),
      journal: async (_input, execute) => execute(),
      enabledToolNames: [
        "registrar_lead",
        "qualificar_lead",
        "verificar_horarios_reuniao",
        "agendar_reuniao",
        "cancelar_reuniao"
      ],
      onMeetingAvailabilityChecked
    });
    await executeTool("registrar_lead", JSON.stringify({ nome: "Lead duração" }));
    await executeTool("qualificar_lead", JSON.stringify({
      estrelas: 3,
      respostas: { nicho: "varejo" },
      resumo: "Lead apto para reunião.",
      justificativa: "Solicitou uma conversa."
    }));

    const availability = JSON.parse(await executeTool(
      "verificar_horarios_reuniao",
      JSON.stringify({
        agenda_id: "restinga",
        data: "2030-01-08",
        horario_solicitado: "11:40"
      })
    ));
    expect(availability).toMatchObject({
      duration_min: 30,
      horarios: [{
        start: "2030-01-08T11:40:00.000Z",
        end: "2030-01-08T12:10:00.000Z"
      }]
    });
    expect(onMeetingAvailabilityChecked).toHaveBeenCalledWith(expect.objectContaining({
      requestedTime: "11:40",
      available: true,
      durationMinutes: 30
    }));

    const meeting = JSON.parse(await executeTool(
      "agendar_reuniao",
      JSON.stringify({ agenda_id: "restinga", start: availability.horarios[0].start })
    ));
    expect(meeting.agendamento).toMatchObject({
      start: "2030-01-08T11:40:00.000Z",
      end: "2030-01-08T12:10:00.000Z",
      duration_min: 30
    });
    await executeTool("cancelar_reuniao", "{}");
  });
});
