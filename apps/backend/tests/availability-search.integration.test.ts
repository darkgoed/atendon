import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { createSchedulingToolExecutor } from "../src/modules/ai-router/tool-executor.js";
import { buscarDisponibilidade } from "../src/modules/scheduling/service.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId = "";
const closerMemberIds: string[] = [];
const closerUserIds: string[] = [];
const AGENDA = "reunioes-comerciais";
// Quinta-feira; a agenda opera de segunda a sábado, como a de produção.
const THURSDAY = "2030-01-10";
const FRIDAY = "2030-01-11";

// Um agendamento ativo por lead é uma invariante do schema, então cada slot
// ocupado precisa do seu próprio lead.
async function occupy(date: string, times: string[]): Promise<void> {
  for (const time of times) {
    for (const closerMemberId of closerMemberIds) {
      const lead = await pool.query<{ id: string }>(
        `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,assigned_member_id)
         VALUES($1,$2,'Ocupante','whatsapp','agendado',$3) RETURNING id`,
        [tenantId, `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`, closerMemberId]
      );
      await pool.query(
        `INSERT INTO scheduling_appointments(
           tenant_id,lead_id,unit_id,start_at,end_at,status,assigned_member_id,assigned_at
         ) VALUES(
           $1,$2,$3,$4::timestamptz,$4::timestamptz + interval '60 minutes','confirmado',$5,now()
         )`,
        [tenantId, lead.rows[0].id, AGENDA, `${date}T${time}:00-03:00`, closerMemberId]
      );
    }
  }
}

beforeAll(async () => {
  const tenant = await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','America/Sao_Paulo') RETURNING id",
    [`Availability ${randomUUID()}`]
  );
  tenantId = tenant.rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureWorkspaceDefaultRoles(client, tenantId);
    for (const [index, availability] of ["available", "available", "available", "unavailable"].entries()) {
      const user = await client.query<{ id: string }>(
        "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
        [`availability-closer-${index}-${randomUUID()}@test.local`]
      );
      closerUserIds.push(user.rows[0].id);
      const member = await client.query<{ id: string }>(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now()
         FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
         RETURNING id`,
        [tenantId, user.rows[0].id]
      );
      await client.query(
        `INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,availability_status)
         VALUES($1,$2,$3)`,
        [tenantId, member.rows[0].id, availability]
      );
      if (availability === "available") closerMemberIds.push(member.rows[0].id);
    }
    await client.query(
      `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity)
       VALUES($1,$2,'Reuniões comerciais','09:00','19:30',ARRAY[1,2,3,4,5,6]::smallint[],60,1)`,
      [tenantId, AGENDA]
    );
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
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [closerUserIds]);
  await pool.end();
});

describe("buscarDisponibilidade", () => {
  const now = new Date(`${THURSDAY}T08:00:00-03:00`);

  it("offers real morning slots when the requested day has them", async () => {
    const result = await buscarDisponibilidade(tenantId, AGENDA, THURSDAY, { periodo: "manha", now });
    expect(result).toMatchObject({
      data: THURSDAY,
      data_solicitada: THURSDAY,
      timezone: "America/Sao_Paulo",
      periodo_solicitado: "manha",
      periodo_atendido: true
    });
    expect(result.horarios.map((slot) => slot.hora)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("never offers a slot earlier than the current moment", async () => {
    const result = await buscarDisponibilidade(tenantId, AGENDA, THURSDAY, {
      periodo: "manha",
      now: new Date(`${THURSDAY}T10:30:00-03:00`)
    });
    expect(result.horarios.map((slot) => slot.hora)).toEqual(["11:00"]);
    expect(result.horarios.every((slot) => new Date(slot.start) > new Date(`${THURSDAY}T10:30:00-03:00`))).toBe(true);
  });

  it("honours the minimum lead time on top of the current moment", async () => {
    // 10:15 + 60 min de antecedência descarta o slot das 11:00 do próprio dia.
    const sameDay = await buscarDisponibilidade(tenantId, AGENDA, THURSDAY, {
      periodo: "manha",
      now: new Date(`${THURSDAY}T10:15:00-03:00`),
      minimumLeadTimeMinutes: 60,
      searchDays: 1
    });
    expect(sameDay.periodo_atendido).toBe(false);
    expect(sameDay.horarios.map((slot) => slot.hora)).not.toContain("11:00");
    expect(sameDay.horarios.every((slot) =>
      new Date(slot.start).getTime() > new Date(`${THURSDAY}T11:15:00-03:00`).getTime())).toBe(true);

    const nextDays = await buscarDisponibilidade(tenantId, AGENDA, THURSDAY, {
      periodo: "manha",
      now: new Date(`${THURSDAY}T10:15:00-03:00`),
      minimumLeadTimeMinutes: 60
    });
    expect(nextDays).toMatchObject({ data: FRIDAY, periodo_atendido: true });
    expect(nextDays.horarios[0].hora).toBe("09:00");
  });

  it("advances to the next day when the requested period is fully booked", async () => {
    // Reproduz o incidente real: 09h, 10h e 11h ocupadas, cliente pediu manhã.
    await occupy(THURSDAY, ["09:00", "10:00", "11:00"]);
    const result = await buscarDisponibilidade(tenantId, AGENDA, THURSDAY, { periodo: "manha", now });
    expect(result).toMatchObject({
      data: FRIDAY,
      data_solicitada: THURSDAY,
      periodo_solicitado: "manha",
      periodo_atendido: true
    });
    expect(result.horarios.map((slot) => slot.hora)).toEqual(["09:00", "10:00", "11:00"]);
    expect(result.horarios.every((slot) => slot.start.startsWith(FRIDAY))).toBe(true);
  });

  it("falls back to concrete slots from another period instead of returning nothing", async () => {
    // Toda a manhã da janela pesquisada ocupada: o atendimento precisa de algo real.
    for (let day = 0; day < 3; day += 1) {
      const date = new Date(`${THURSDAY}T12:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() + day);
      await occupy(date.toISOString().slice(0, 10), ["09:00", "10:00", "11:00"]);
    }
    const result = await buscarDisponibilidade(tenantId, AGENDA, THURSDAY, {
      periodo: "manha",
      now,
      searchDays: 3
    });
    expect(result.periodo_atendido).toBe(false);
    expect(result.horarios.length).toBeGreaterThan(0);
    expect(result.horarios.every((slot) => Number(slot.hora.slice(0, 2)) >= 12)).toBe(true);
  });

  it("reports no availability at all without inventing slots", async () => {
    const sunday = "2030-01-13";
    const result = await buscarDisponibilidade(tenantId, AGENDA, sunday, { periodo: "manha", searchDays: 1, now });
    expect(result).toMatchObject({ data: sunday, periodo_atendido: false, horarios: [] });
  });
});

describe("verificar_horarios_reuniao tool contract", () => {
  it("returns a small, unambiguous payload with local times and ISO starts", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, "5511900000000", undefined, {
      schedulingPeriodPreference: "manha"
    } as never);
    const payload = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      data: "2030-02-04"
    })));
    expect(payload).toMatchObject({
      agenda_id: AGENDA,
      timezone: "America/Sao_Paulo",
      duration_min: 60,
      periodo_solicitado: "manha",
      periodo_atendido: true
    });
    expect(payload.horarios.length).toBeLessThanOrEqual(3);
    expect(payload.horarios[0]).toMatchObject({
      hora: "09:00",
      vagas: 3,
      capacidade: 3
    });
    expect(payload.instrucao_capacidade).toContain("vagas");
    expect(payload.horarios[0].start).toMatch(/^2030-02-04T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(payload.erro).toBeUndefined();
  });

  it("forces the system-detected period over the argument chosen by the model", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, "5511900000001", undefined, {
      schedulingPeriodPreference: "tarde"
    } as never);
    const payload = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      data: "2030-02-04",
      periodo: "manha"
    })));
    expect(payload.periodo_solicitado).toBe("tarde");
    expect(payload.horarios.every((slot: { hora: string }) => Number(slot.hora.slice(0, 2)) >= 12)).toBe(true);
  });

  it("ignores a period invented by the model when the contact did not choose one", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, "5511900000002", undefined, {
      schedulingPeriodPreferenceResolved: true
    } as never);
    const payload = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      data: "2030-02-04",
      periodo: "tarde"
    })));

    expect(payload.periodo_solicitado).toBeUndefined();
    expect(payload.data).toBe("2030-02-04");
    expect(payload.horarios.map((slot: { hora: string }) => slot.hora)).toEqual(["09:00", "10:00", "11:00"]);
  });

  it("carries a returned slot through selection into a persisted appointment", async () => {
    const leadPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    await pool.query(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Escolha real','whatsapp','qualificado',4)`,
      [tenantId, leadPhone]
    );
    const executeTool = createSchedulingToolExecutor(tenantId, leadPhone, undefined, {
      schedulingPeriodPreference: "manha"
    } as never);

    const availability = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      data: "2030-03-04"
    })));
    expect(availability.periodo_atendido).toBe(true);
    const chosen = availability.horarios[1];
    expect(chosen).toMatchObject({ vagas: 3, capacidade: 3 });

    const booked = JSON.parse(await executeTool("agendar_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      start: chosen.start
    })));
    expect(booked.agendamento).toMatchObject({ status: "confirmado", start: chosen.start });

    const rivalPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    await pool.query(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Conflito','whatsapp','qualificado',3)`,
      [tenantId, rivalPhone]
    );
    const rivalExecutor = createSchedulingToolExecutor(tenantId, rivalPhone);

    // A agenda está configurada com capacidade 1, mas há três closers ativos.
    // Por isso o mesmo horário continua livre para um segundo atendimento.
    const after = JSON.parse(await rivalExecutor("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      data: "2030-03-04"
    })));
    expect(after.horarios.map((slot: { hora: string }) => slot.hora)).toContain(chosen.hora);
    expect(after.horarios.find((slot: { hora: string }) => slot.hora === chosen.hora)).toMatchObject({
      vagas: 2,
      capacidade: 3
    });

    // O segundo lead ocupa outro closer, apesar da capacidade fixa da agenda ser 1.
    const rival = JSON.parse(await rivalExecutor(
      "agendar_reuniao",
      JSON.stringify({ agenda_id: AGENDA, start: chosen.start })
    ));
    expect(rival.agendamento).toMatchObject({ status: "confirmado", start: chosen.start });
    expect(rival.agendamento.responsavel.member_id).not.toBe(booked.agendamento.responsavel.member_id);

    // O terceiro lead ainda encontra o último closer livre.
    const thirdPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    await pool.query(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Terceiro closer','whatsapp','qualificado',3)`,
      [tenantId, thirdPhone]
    );
    const thirdExecutor = createSchedulingToolExecutor(tenantId, thirdPhone);
    const afterSecond = JSON.parse(await thirdExecutor("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      data: "2030-03-04"
    })));
    expect(afterSecond.horarios.map((slot: { hora: string }) => slot.hora)).toContain(chosen.hora);
    expect(afterSecond.horarios.find((slot: { hora: string }) => slot.hora === chosen.hora)).toMatchObject({
      vagas: 1,
      capacidade: 3
    });

    const third = JSON.parse(await thirdExecutor(
      "agendar_reuniao",
      JSON.stringify({ agenda_id: AGENDA, start: chosen.start })
    ));
    expect(third.agendamento).toMatchObject({ status: "confirmado", start: chosen.start });
    expect(new Set([
      booked.agendamento.responsavel.member_id,
      rival.agendamento.responsavel.member_id,
      third.agendamento.responsavel.member_id
    ]).size).toBe(3);

    // O quarto lead não passa: os três closers ativos já estão ocupados.
    const fourthPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    await pool.query(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Sem closer livre','whatsapp','qualificado',3)`,
      [tenantId, fourthPhone]
    );
    const fourthExecutor = createSchedulingToolExecutor(tenantId, fourthPhone);
    const full = JSON.parse(await fourthExecutor("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: AGENDA,
      data: "2030-03-04"
    })));
    expect(full.horarios.map((slot: { hora: string }) => slot.hora)).not.toContain(chosen.hora);

    const conflict = JSON.parse(await fourthExecutor(
      "agendar_reuniao",
      JSON.stringify({ agenda_id: AGENDA, start: chosen.start })
    ));
    expect(conflict.erro).toBeTruthy();
    expect(conflict.agendamento).toBeUndefined();
  });

  // Incidente 553497771091: sem a hora local no payload o modelo converteu o ISO
  // em UTC de cabeça e reagendou as 9h escolhidas pelo contato para as 12h.
  it("labels every returned slot with its local time when a specific time was checked", async () => {
    const leadPhone = `5511${Math.floor(10_000_000 + Math.random() * 89_999_999)}`;
    await pool.query(
      `INSERT INTO scheduling_leads(tenant_id,phone,name,source,status,qualification_stars)
       VALUES($1,$2,'Hora local','whatsapp','qualificado',4)`,
      [tenantId, leadPhone]
    );

    const payload = JSON.parse(await createSchedulingToolExecutor(tenantId, leadPhone)(
      "verificar_horarios_reuniao",
      JSON.stringify({ agenda_id: AGENDA, data: THURSDAY, horario_solicitado: "10:00" })
    ));

    expect(payload.horario_solicitado.hora).toBe("10:00");
    expect(payload.horario_solicitado).toMatchObject({ vagas: 0, capacidade: 3 });
    expect(payload.instrucao_capacidade).toContain("closers ainda estão livres");
    for (const slot of [...payload.horarios, ...(payload.horarios_proximos ?? [])]) {
      expect(slot.hora).toMatch(/^\d{2}:\d{2}$/);
      expect(slot.start.startsWith(`${THURSDAY}T`) || slot.start.includes("T")).toBe(true);
    }
  });

  it("reports an unknown agenda as a tool error instead of empty availability", async () => {
    const executeTool = createSchedulingToolExecutor(tenantId, "5511900000002");
    const payload = JSON.parse(await executeTool("verificar_horarios_reuniao", JSON.stringify({
      agenda_id: "agenda-inexistente",
      data: "2030-02-04"
    })));
    expect(payload.erro).toBeTruthy();
    expect(payload.horarios).toBeUndefined();
  });
});
