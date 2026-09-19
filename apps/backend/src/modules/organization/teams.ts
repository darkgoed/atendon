import type { PoolClient } from "pg";
import { db } from "../../db/client.js";
import { httpError, withTransaction } from "../scheduling/service.js";
import { pickTeamRoundRobinMember } from "../assignments/service.js";

/**
 * B6 Times (specs/active/v7-port-crm-whatsapp.md, ONDA 2).
 *
 * Estrutura mínima de equipes: CRUD de times do workspace, vínculo de membros
 * (`workspace_members.team_id`) e atribuição de conversa por equipe
 * (`conversations.assigned_team_id`). Permissão de gestão REUSA a key de
 * membros (`members.update`) — nenhuma key nova foi criada.
 *
 * O contrato para o worker de fluxos (action `assign_to` com `team_id`) é
 * `assignConversationToTeam` + `pickTeamRoundRobinMember`: dentro da transação
 * do executor, escolher membro pelo round-robin filtrado pela equipe e
 * gravar `assigned_team_id`. Nenhum executor paralelo de disponibilidade —
 * o round-robin é a EXTENSÃO do existente em assignments/service.ts.
 */

export type TeamActor = {
  userId: string | null;
  actorScope?: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

export type TeamView = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  member_count: number;
  active_member_count: number;
};

async function insertAudit(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  actor: TeamActor,
  action: string,
  resourceId: string,
  metadata: Record<string, unknown>
) {
  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent)
     VALUES($1,$2,$3,$4,'team',$5,$6,$7,$8)`,
    [
      actor.userId,
      tenantId,
      actor.actorScope ?? "workspace",
      action,
      resourceId,
      metadata,
      actor.ipAddress ?? null,
      actor.userAgent ?? null
    ]
  );
}

function teamMapper(row: {
  id: string;
  name: string;
  created_at: string | Date;
  updated_at: string | Date;
  member_count: string | number;
  active_member_count: string | number;
}): TeamView {
  return {
    id: row.id,
    name: row.name,
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
    member_count: Number(row.member_count),
    active_member_count: Number(row.active_member_count)
  };
}

export async function listTeams(tenantId: string): Promise<TeamView[]> {
  const result = await db.query<{
    id: string;
    name: string;
    created_at: string | Date;
    updated_at: string | Date;
    member_count: string;
    active_member_count: string;
  }>(
    `SELECT team.id,team.name,team.created_at,team.updated_at,
            count(member.id)::text member_count,
            count(member.id) FILTER (WHERE member.status='active')::text active_member_count
     FROM teams team
     LEFT JOIN workspace_members member
       ON member.workspace_id=team.tenant_id AND member.team_id=team.id
     WHERE team.tenant_id=$1
     GROUP BY team.id,team.tenant_id,team.name,team.created_at,team.updated_at
     ORDER BY lower(team.name),team.id`,
    [tenantId]
  );
  return result.rows.map(teamMapper);
}

export async function createTeam(
  tenantId: string,
  actor: TeamActor & { userId: string },
  input: { name: string }
): Promise<TeamView> {
  try {
    return await withTransaction(async (client) => {
      const result = await client.query<{ id: string; name: string; created_at: Date; updated_at: Date }>(
        `INSERT INTO teams(tenant_id,name,created_by_user_id)
         VALUES($1,$2,$3)
         RETURNING id,name,created_at,updated_at`,
        [tenantId, input.name, actor.userId]
      );
      await insertAudit(client,tenantId,actor,"team.created",result.rows[0].id,{ name: input.name });
      return teamMapper({ ...result.rows[0], member_count: "0", active_member_count: "0" });
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      throw httpError(409, "Já existe uma equipe com esse nome");
    }
    throw error;
  }
}

export async function updateTeam(
  tenantId: string,
  teamId: string,
  actor: TeamActor & { userId: string },
  input: { name: string }
): Promise<TeamView> {
  try {
    return await withTransaction(async (client) => {
      const updated = await client.query<{ id: string; name: string; created_at: Date; updated_at: Date }>(
        `UPDATE teams
         SET name=$3,updated_at=now()
         WHERE tenant_id=$1 AND id=$2
         RETURNING id,name,created_at,updated_at`,
        [tenantId, teamId, input.name]
      );
      if (!updated.rows[0]) throw httpError(404, "Equipe não encontrada");
      await insertAudit(client,tenantId,actor,"team.updated",teamId,{ name: input.name });
      const counts = await client.query<{ member_count: string; active_member_count: string }>(
        `SELECT count(*)::text member_count,
                count(*) FILTER (WHERE status='active')::text active_member_count
         FROM workspace_members
         WHERE workspace_id=$1 AND team_id=$2`,
        [tenantId, teamId]
      );
      return teamMapper({ ...updated.rows[0], ...counts.rows[0] });
    });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "23505") {
      throw httpError(409, "Já existe uma equipe com esse nome");
    }
    throw error;
  }
}

export async function deleteTeam(
  tenantId: string,
  teamId: string,
  actor: TeamActor & { userId: string },
  input: { detach_members: boolean }
): Promise<{ ok: true }> {
  return withTransaction(async (client) => {
    // Locks os membros vinculados antes da contagem — a desassociação precisa
    // enxergar o mesmo conjunto que vai limpar.
    const members = await client.query<{ id: string }>(
      `SELECT id FROM workspace_members
       WHERE workspace_id=$1 AND team_id=$2
       FOR UPDATE`,
      [tenantId, teamId]
    );
    if (members.rows.length && !input.detach_members) {
      throw Object.assign(
        new Error("Equipe possui membros vinculados; confirme a desassociação para excluir"),
        { statusCode: 409, code: "TEAM_HAS_MEMBERS" }
      );
    }
    if (members.rows.length) {
      await client.query(
        `UPDATE workspace_members
         SET team_id=NULL,updated_at=now()
         WHERE workspace_id=$1 AND team_id=$2`,
        [tenantId, teamId]
      );
    }
    const deleted = await client.query<{ id: string; name: string }>(
      `DELETE FROM teams
       WHERE tenant_id=$1 AND id=$2
       RETURNING id,name`,
      [tenantId, teamId]
    );
    if (!deleted.rows[0]) throw httpError(404, "Equipe não encontrada");
    await insertAudit(client,tenantId,actor,"team.deleted",teamId,{
      name: deleted.rows[0].name,
      detached_members: members.rows.length
    });
    return { ok: true as const };
  });
}

export async function teamExists(client: Pick<PoolClient, "query">, tenantId: string, teamId: string): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM teams WHERE tenant_id=$1 AND id=$2",
    [tenantId, teamId]
  );
  return Boolean(result.rows[0]);
}

/**
 * Atribuição de conversa a uma equipe. Roda dentro da transação do chamador
 * (endpoint de assign / executor de fluxo). Limpa o responsável individual:
 * a conversa passa a pertencer à equipe até alguém assumir (claim), que é o
 * comportamento do donor. Selecionar um membro do time já na atribuição é
 * papel do chamador via `pickTeamRoundRobinMember`.
 */
export async function assignConversationToTeam(
  client: PoolClient,
  input: {
    tenantId: string;
    conversationId: string;
    teamId: string | null;
    actor: TeamActor;
    previousUserId?: string | null;
    assignedUserId?: string | null;
  }
): Promise<{ assigned_team_id: string | null }> {
  const conversation = await client.query<{ assigned_team_id: string | null; assigned_user_id: string | null }>(
    `SELECT assigned_team_id,assigned_user_id
     FROM conversations
     WHERE tenant_id=$1 AND id=$2
     FOR UPDATE`,
    [input.tenantId, input.conversationId]
  );
  const current = conversation.rows[0];
  if (!current) throw httpError(404, "Conversa não encontrada");
  if (input.teamId) {
    const team = await client.query<{ id: string }>(
      "SELECT id FROM teams WHERE tenant_id=$1 AND id=$2",
      [input.tenantId, input.teamId]
    );
    if (!team.rows[0]) throw httpError(400, "Equipe não encontrada neste workspace");
  }
  await client.query(
    `UPDATE conversations
     SET assigned_team_id=$3
     WHERE tenant_id=$1 AND id=$2`,
    [input.tenantId, input.conversationId, input.teamId]
  );
  await client.query(
    `INSERT INTO audit_logs(
       actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
     ) VALUES($1,$2,$3,$4,'conversation',$5,$6,$7,$8)`,
    [
      input.actor.userId,
      input.tenantId,
      input.actor.actorScope ?? "workspace",
      input.teamId ? "conversation.team_assigned" : "conversation.team_unassigned",
      input.conversationId,
      {
        team_anterior_id: current.assigned_team_id,
        team_novo_id: input.teamId,
        responsavel_anterior_user_id: input.previousUserId ?? current.assigned_user_id,
        responsavel_novo_user_id: input.assignedUserId ?? null
      },
      input.actor.ipAddress ?? null,
      input.actor.userAgent ?? null
    ]
  );
  return { assigned_team_id: input.teamId };
}

/**
 * Round-robin COM filtro de equipe sobre o pool existente
 * (assignments/service.ts) — nunca um sistema paralelo de disponibilidade.
 * Exportado para: endpoint de assign (patch do app.ts) e para o contrato do
 * worker de fluxos (action assign_to com team_id).
 */
export async function pickTeamRoundRobin(
  client: PoolClient,
  tenantId: string,
  teamId: string
): Promise<{ memberId: string; userId: string; email: string } | null> {
  return pickTeamRoundRobinMember(client, tenantId, teamId);
}
