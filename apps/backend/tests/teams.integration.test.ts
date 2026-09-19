import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ensureWorkspaceDefaultRoles } from "../src/auth/rbac.js";
import { config } from "../src/config.js";
import { pickTeamRoundRobinMember } from "../src/modules/assignments/service.js";
import {
  assignConversationToTeam,
  createTeam,
  deleteTeam,
  listTeams,
  updateTeam,
  type TeamActor
} from "../src/modules/organization/teams.js";

// B6 Times: integração dos módulos de equipes contra o banco de teste. Pool
// direto, tenant por arquivo, ensureWorkspaceDefaultRoles, NUNCA registrar
// plugin — o registro das rotas (app.ts) é do orquestrador. O filtro
// `team_id` do GET /scheduling/leads é exercido pelo MESMO predicado SQL
// documentado no routes.ts (subquery workspace_members.team_id).

const pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10 });

let tenantId = "";
let betoUserId = "";
let betoMemberId = "";
let juliaUserId = "";
let juliaMemberId = "";
let carlaUserId = "";
let carlaMemberId = "";
let whatsappSessionId = "";
let phoneSequence = 0;

const actor: TeamActor & { userId: string } = { userId: "", actorScope: "workspace" };
const nextPhone = () => `551197${String(++phoneSequence).padStart(6, "0")}`;

async function inTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createLead(assignedMemberId: string | null): Promise<string> {
  const phone = nextPhone();
  return (await pool.query<{ id: string }>(
    `INSERT INTO scheduling_leads(
       tenant_id,phone,name,interest_category_id,unit_id,status,source,assigned_member_id
     ) VALUES($1,$2,$3,'teams-category','teams-unit','em_atendimento','teams-test',$4)
     RETURNING id`,
    [tenantId, phone, `Lead ${phone}`, assignedMemberId]
  )).rows[0].id;
}

async function createConversation(): Promise<string> {
  const phone = nextPhone();
  return (await pool.query<{ id: string }>(
    `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_name,status)
     VALUES($1,$2,$3,$4,'open') RETURNING id`,
    [tenantId, whatsappSessionId, phone, `Contato ${phone}`]
  )).rows[0].id;
}

async function recentTeamAudit(action: string): Promise<Record<string, unknown> | undefined> {
  return (await pool.query<{ metadata: Record<string, unknown> }>(
    `SELECT metadata FROM audit_logs
     WHERE workspace_id=$1 AND action=$2
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [tenantId, action]
  )).rows[0]?.metadata;
}

beforeAll(async () => {
  tenantId = (await pool.query<{ id: string }>(
    "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC') RETURNING id",
    [`Teams ${randomUUID()}`]
  )).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    whatsappSessionId = (await client.query<{ id: string }>(
      "INSERT INTO whatsapp_sessions(tenant_id,label,is_primary) VALUES($1,'Principal',true) RETURNING id",
      [tenantId]
    )).rows[0].id;
    await ensureWorkspaceDefaultRoles(client, tenantId);
    for (const name of ["Beto Times", "Julia Times", "Carla Times"]) {
      const email = `${name.split(" ")[0].toLowerCase()}-teams-${randomUUID()}@test.local`;
      const userId = (await client.query<{ id: string }>(
        "INSERT INTO users(email,status,name) VALUES($1,'active',$2) RETURNING id",
        [email, name]
      )).rows[0].id;
      const memberId = (await client.query<{ id: string }>(
        `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
         SELECT $1,$2,id,'active',now()
         FROM workspace_roles WHERE workspace_id=$1 AND name='OPERADOR'
         RETURNING id`,
        [tenantId, userId]
      )).rows[0].id;
      if (name.startsWith("Beto")) { betoUserId = userId; betoMemberId = memberId; }
      else if (name.startsWith("Julia")) { juliaUserId = userId; juliaMemberId = memberId; }
      else { carlaUserId = userId; carlaMemberId = memberId; }
    }
    actor.userId = betoUserId;
    // Pool do round-robin: os três entram no pool geral (Beto primeiro).
    await client.query(
      `INSERT INTO scheduling_google_meet_closers(tenant_id,member_id,created_at,availability_status)
       VALUES
         ($1,$2,'2026-01-01T00:00:00Z','available'),
         ($1,$3,'2026-01-02T00:00:00Z','available'),
         ($1,$4,'2026-01-03T00:00:00Z','available')`,
      [tenantId, betoMemberId, juliaMemberId, carlaMemberId]
    );
    await client.query(
      "INSERT INTO attendant_assignment_cursors(tenant_id,last_member_id) VALUES($1,NULL)",
      [tenantId]
    );
    await client.query(
      "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'teams-category','Teams category')",
      [tenantId]
    );
    await client.query(
      `INSERT INTO scheduling_units(
         tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
       ) VALUES($1,'teams-unit','Teams unit','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],30,100)`,
      [tenantId]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
});

beforeEach(async () => {
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=$1", [tenantId]);
  await pool.query("DELETE FROM conversations WHERE tenant_id=$1", [tenantId]);
  await pool.query("DELETE FROM scheduling_leads WHERE tenant_id=$1", [tenantId]);
  // Times por teste: desvincula membros e apaga os times do teste anterior.
  await pool.query("UPDATE workspace_members SET team_id=NULL WHERE workspace_id=$1", [tenantId]);
  await pool.query("DELETE FROM teams WHERE tenant_id=$1", [tenantId]);
  await pool.query(
    `UPDATE attendant_assignment_cursors SET last_member_id=NULL,updated_at=now() WHERE tenant_id=$1`,
    [tenantId]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM audit_logs WHERE workspace_id=$1 OR actor_user_id=ANY($2::uuid[])", [
    tenantId,
    [betoUserId, juliaUserId, carlaUserId]
  ]);
  await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.query("DELETE FROM users WHERE id=ANY($1::uuid[])", [[betoUserId, juliaUserId, carlaUserId]]);
  await pool.end();
});

describe("teams CRUD", () => {
  it("creates, lists with member counts, renames and refuses duplicate names", async () => {
    const alfa = await createTeam(tenantId, actor, { name: "Equipe Alfa" });
    expect(alfa).toMatchObject({ name: "Equipe Alfa", member_count: 0, active_member_count: 0 });

    // Nome duplicado (case-insensitive) colide com UNIQUE(tenant_id, lower(name)).
    await expect(createTeam(tenantId, actor, { name: "equipe alfa" }))
      .rejects.toMatchObject({ statusCode: 409 });

    await pool.query(
      "UPDATE workspace_members SET team_id=$3 WHERE workspace_id=$1 AND id=$2",
      [tenantId, betoMemberId, alfa.id]
    );
    const renamed = await updateTeam(tenantId, alfa.id, actor, { name: "Equipe Alfa Sul" });
    expect(renamed).toMatchObject({ id: alfa.id, name: "Equipe Alfa Sul", member_count: 1, active_member_count: 1 });

    const listed = await listTeams(tenantId);
    expect(listed.map((team) => team.id)).toEqual([alfa.id]);

    expect(await recentTeamAudit("team.created")).toMatchObject({ name: "Equipe Alfa" });
    expect(await recentTeamAudit("team.updated")).toMatchObject({ name: "Equipe Alfa Sul" });
  });

  it("updates and deletes unknown teams with 404", async () => {
    await expect(updateTeam(tenantId, randomUUID(), actor, { name: "Fantasma" }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(deleteTeam(tenantId, randomUUID(), actor, { detach_members: false }))
      .rejects.toMatchObject({ statusCode: 404 });
  });

  it("deletes a team with members only with explicit detachment", async () => {
    const team = await createTeam(tenantId, actor, { name: "Equipe Beta" });
    await pool.query(
      "UPDATE workspace_members SET team_id=$3 WHERE workspace_id=$1 AND id IN ($2,$4)",
      [tenantId, betoMemberId, team.id, juliaMemberId]
    );

    await expect(deleteTeam(tenantId, team.id, actor, { detach_members: false }))
      .rejects.toMatchObject({ statusCode: 409, code: "TEAM_HAS_MEMBERS" });
    // Guarda falhou: time e vínculos permanecem.
    expect((await listTeams(tenantId)).some((entry) => entry.id === team.id)).toBe(true);

    await deleteTeam(tenantId, team.id, actor, { detach_members: true });
    expect((await listTeams(tenantId)).some((entry) => entry.id === team.id)).toBe(false);
    const members = (await pool.query<{ id: string }>(
      "SELECT id FROM workspace_members WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND team_id IS NOT NULL",
      [tenantId, [betoMemberId, juliaMemberId]]
    )).rows;
    expect(members).toEqual([]);
    expect(await recentTeamAudit("team.deleted")).toMatchObject({
      name: "Equipe Beta",
      detached_members: 2
    });
  });
});

describe("conversation team assignment", () => {
  it("assigns and unassigns a team with audit on both directions", async () => {
    const team = await createTeam(tenantId, actor, { name: "Equipe Gama" });
    const conversationId = await createConversation();

    await inTransaction((client) => assignConversationToTeam(client, {
      tenantId,
      conversationId,
      teamId: team.id,
      actor
    }));
    expect((await pool.query<{ assigned_team_id: string | null }>(
      "SELECT assigned_team_id FROM conversations WHERE tenant_id=$1 AND id=$2",
      [tenantId, conversationId]
    )).rows[0].assigned_team_id).toBe(team.id);
    expect(await recentTeamAudit("conversation.team_assigned")).toMatchObject({ team_novo_id: team.id });

    await inTransaction((client) => assignConversationToTeam(client, {
      tenantId,
      conversationId,
      teamId: null,
      actor
    }));
    expect((await pool.query<{ assigned_team_id: string | null }>(
      "SELECT assigned_team_id FROM conversations WHERE tenant_id=$1 AND id=$2",
      [tenantId, conversationId]
    )).rows[0].assigned_team_id).toBeNull();
    expect(await recentTeamAudit("conversation.team_unassigned")).toMatchObject({ team_novo_id: null });
  });

  it("rejects unknown conversations and foreign teams", async () => {
    const team = await createTeam(tenantId, actor, { name: "Equipe Delta" });
    await expect(inTransaction((client) => assignConversationToTeam(client, {
      tenantId,
      conversationId: randomUUID(),
      teamId: team.id,
      actor
    }))).rejects.toMatchObject({ statusCode: 404 });
    const orphanConversation = await createConversation();
    await expect(inTransaction((client) => assignConversationToTeam(client, {
      tenantId,
      conversationId: orphanConversation,
      teamId: randomUUID(),
      actor
    }))).rejects.toMatchObject({ statusCode: 400, message: "Equipe não encontrada neste workspace" });
  });
});

describe("team round robin", () => {
  it("rotates only members of the requested team", async () => {
    const team = await createTeam(tenantId, actor, { name: "Equipe Epsilon" });
    // Beto e Julia na equipe; Carla fica no pool geral, fora da equipe.
    await pool.query(
      "UPDATE workspace_members SET team_id=$3 WHERE workspace_id=$1 AND id=ANY($2::uuid[])",
      [tenantId, [betoMemberId, juliaMemberId], team.id]
    );

    const picks: Array<string | null> = [];
    for (let index = 0; index < 4; index += 1) {
      const pick = await inTransaction((client) => pickTeamRoundRobinMember(client, tenantId, team.id));
      picks.push(pick?.memberId ?? null);
    }
    // Carla nunca é escolhida; rotação alterna só dentro da equipe.
    expect(picks).toEqual([betoMemberId, juliaMemberId, betoMemberId, juliaMemberId]);
  });

  it("returns null for a team without pool members", async () => {
    const team = await createTeam(tenantId, actor, { name: "Equipe Vazia" });
    // Carla É do pool, mas não é desta equipe.
    await pool.query(
      "UPDATE workspace_members SET team_id=$3 WHERE workspace_id=$1 AND id=$2",
      [tenantId, carlaMemberId, team.id]
    );
    // Carla está no pool geral — deve ser elegível pela SUA equipe.
    const carlaPick = await inTransaction((client) => pickTeamRoundRobinMember(client, tenantId, team.id));
    expect(carlaPick).toMatchObject({ memberId: carlaMemberId, userId: carlaUserId });

    const empty = await createTeam(tenantId, actor, { name: "Equipe Sem Ninguém" });
    expect(await inTransaction((client) => pickTeamRoundRobinMember(client, tenantId, empty.id))).toBeNull();
  });
});

describe("scheduling leads team filter", () => {
  it("matches only leads whose individual owner belongs to the team", async () => {
    const team = await createTeam(tenantId, actor, { name: "Equipe Zeta" });
    await pool.query(
      "UPDATE workspace_members SET team_id=$3 WHERE workspace_id=$1 AND id=$2",
      [tenantId, betoMemberId, team.id]
    );
    const betoLead = await createLead(betoMemberId);
    const juliaLead = await createLead(juliaMemberId);
    const unassignedLead = await createLead(null);

    // Mesmo predicado SQL aplicado por GET /scheduling/leads?team_id=…
    // (routes.ts): l.assigned_member_id IN (membros m2 da equipe, por tenant).
    const filtered = (await pool.query<{ id: string }>(
      `SELECT l.id FROM scheduling_leads l
       WHERE l.tenant_id=$1 AND l.deleted_at IS NULL
         AND l.assigned_member_id IN (
           SELECT m2.id FROM workspace_members m2
           WHERE m2.workspace_id=l.tenant_id AND m2.team_id=$2
         )
       ORDER BY l.id`,
      [tenantId, team.id]
    )).rows.map((row) => row.id);
    expect(filtered).toEqual([betoLead]);
    expect(filtered).not.toContain(juliaLead);
    expect(filtered).not.toContain(unassignedLead);
  });
});
