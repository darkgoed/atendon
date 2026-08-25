import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";

export type AssignmentReason =
  | "novo_contato"
  | "lead_criado"
  | "retorno_conversa_encerrada"
  | "reuniao_sem_responsavel"
  | "pool_expandido"
  | "transferencia_manual"
  | "removido_do_pool";

export type AssignmentActor = {
  userId: string | null;
  actorScope?: "root" | "workspace";
  ipAddress?: string;
  userAgent?: string;
};

export type AttendantAssignment = {
  memberId: string;
  userId: string;
  email: string;
  availabilityStatus: "available" | "unavailable";
};

type CaseRows = {
  phone: string;
  leads: Array<{ id: string; assigned_member_id: string | null; status: string }>;
  conversations: Array<{ id: string; assigned_user_id: string | null; status: string }>;
};

const normalizedPhoneSql = (column: string) => `regexp_replace(${column},'\\D','','g')`;

export async function lockAttendantRotation(client: PoolClient, tenantId: string): Promise<void> {
  // Mantém compatibilidade com instâncias anteriores durante atualização gradual.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`closer-round-robin:${tenantId}`]);
  await client.query(
    `INSERT INTO attendant_assignment_cursors(tenant_id)
     VALUES($1)
     ON CONFLICT(tenant_id) DO NOTHING`,
    [tenantId]
  );
  await client.query(
    "SELECT tenant_id FROM attendant_assignment_cursors WHERE tenant_id=$1 FOR UPDATE",
    [tenantId]
  );
}

async function eligibleAttendants(client: PoolClient, tenantId: string): Promise<AttendantAssignment[]> {
  const result = await client.query<AttendantAssignment & { member_id: string; user_id: string; availability_status: "available" | "unavailable" }>(
    `SELECT m.id member_id,m.user_id,u.email,pool.availability_status
     FROM scheduling_google_meet_closers pool
     JOIN workspace_members m
       ON m.id=pool.member_id AND m.workspace_id=pool.tenant_id AND m.status='active'
     JOIN users u ON u.id=m.user_id AND u.status='active'
     WHERE pool.tenant_id=$1
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions permission
         WHERE permission.role_id=m.role_id AND permission.permission_key='leads.read'
       )
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions permission
         WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.read'
       )
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions permission
         WHERE permission.role_id=m.role_id AND permission.permission_key='conversations.reply'
       )
     ORDER BY pool.created_at,m.id`,
    [tenantId]
  );
  return result.rows.map((row) => ({
    memberId: row.member_id,
    userId: row.user_id,
    email: row.email,
    availabilityStatus: row.availability_status
  }));
}

function normalizedAttendantName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function attendantNameAliases(candidate: { name: string | null; email: string }): string[] {
  const fullName = normalizedAttendantName(candidate.name ?? "");
  const emailLocalPart = normalizedAttendantName(candidate.email.split("@", 1)[0] ?? "");
  return [...new Set([
    fullName,
    fullName.split(" ", 1)[0] ?? "",
    emailLocalPart
  ].filter(Boolean))];
}

/**
 * Assigns one conversation to an explicitly named active attendant without
 * moving the linked lead or appointments. Exact full-name matches take
 * precedence; a unique first-name or email-local-part match is accepted as a
 * fallback so operational accounts without a display name still work.
 */
export async function assignConversationToNamedAttendant(
  client: PoolClient,
  input: { tenantId: string; conversationId: string; assigneeName: string }
): Promise<AttendantAssignment | null> {
  const expectedName = normalizedAttendantName(input.assigneeName);
  if (!expectedName) return null;

  const candidates = await client.query<{
    member_id: string;
    user_id: string;
    email: string;
    name: string | null;
    availability_status: "available" | "unavailable";
  }>(
    `SELECT member.id member_id,member.user_id,"user".email,"user".name,pool.availability_status
     FROM scheduling_google_meet_closers pool
     JOIN workspace_members member
       ON member.id=pool.member_id AND member.workspace_id=pool.tenant_id AND member.status='active'
     JOIN users "user" ON "user".id=member.user_id AND "user".status='active'
     WHERE pool.tenant_id=$1
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions permission
         WHERE permission.role_id=member.role_id AND permission.permission_key='conversations.read'
       )
       AND EXISTS (
         SELECT 1 FROM workspace_role_permissions permission
         WHERE permission.role_id=member.role_id AND permission.permission_key='conversations.reply'
       )
     ORDER BY pool.created_at,member.id`,
    [input.tenantId]
  );
  const named = candidates.rows.map((candidate) => ({ candidate, aliases: attendantNameAliases(candidate) }));
  const exact = named.filter(
    (item) => normalizedAttendantName(item.candidate.name ?? "") === expectedName
  );
  const aliases = named.filter((item) => item.aliases.includes(expectedName));
  const selected = exact.length === 1
    ? exact[0]?.candidate
    : exact.length === 0 && aliases.length === 1
      ? aliases[0]?.candidate
      : undefined;
  if (!selected) return null;

  const conversation = await client.query<{ assigned_user_id: string | null }>(
    `SELECT assigned_user_id
     FROM conversations
     WHERE tenant_id=$1 AND id=$2
     FOR UPDATE`,
    [input.tenantId, input.conversationId]
  );
  const current = conversation.rows[0];
  if (!current) return null;
  if (current.assigned_user_id !== selected.user_id) {
    await client.query(
      `UPDATE conversations
       SET assigned_user_id=$3,claimed_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [input.tenantId, input.conversationId, selected.user_id]
    );
    await client.query(
      "SELECT pg_notify('atendon_realtime_changes',$1)",
      [JSON.stringify({
        v: 1,
        type: "case.assignment.changed",
        tenantId: input.tenantId,
        caseId: input.conversationId,
        conversationId: input.conversationId,
        entityId: randomUUID(),
        previousUserId: current.assigned_user_id,
        assignedUserId: selected.user_id
      })]
    );
    await client.query(
      `INSERT INTO audit_logs(
         actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata
       ) VALUES(NULL,$1,'workspace','assignment.owner_referral','conversation',$2,$3)`,
      [
        input.tenantId,
        input.conversationId,
        {
          responsavel_anterior_user_id: current.assigned_user_id,
          responsavel_novo_user_id: selected.user_id,
          motivo: "owner_referral"
        }
      ]
    );
  }
  return {
    memberId: selected.member_id,
    userId: selected.user_id,
    email: selected.email,
    availabilityStatus: selected.availability_status
  };
}

export async function listAvailableAppointmentAttendants(
  client: PoolClient,
  tenantId: string
): Promise<AttendantAssignment[]> {
  return (await eligibleAttendants(client, tenantId))
    .filter((candidate) => candidate.availabilityStatus === "available");
}

export type AppointmentAttendantAssignment = AttendantAssignment & {
  activeAppointments: number;
};

export async function selectAvailableAppointmentAttendant(
  client: PoolClient,
  tenantId: string,
  interval: { start: Date; end: Date },
  options: { excludeMemberIds?: string[]; excludeAppointmentId?: string } = {}
): Promise<AppointmentAttendantAssignment | null> {
  await lockAttendantRotation(client, tenantId);
  const excluded = new Set(options.excludeMemberIds ?? []);
  const eligible = (await listAvailableAppointmentAttendants(client, tenantId))
    .filter((candidate) => !excluded.has(candidate.memberId));
  if (!eligible.length) return null;

  const load = await client.query<{
    member_id: string;
    active_appointments: number;
    overlapping_appointments: number;
    overlapping_blocks: number;
  }>(
    `SELECT candidate.member_id,
            count(appointment.id) FILTER (
              WHERE appointment.status IN ('confirmado','reagendado')
                AND appointment.end_at>now()
                AND ($5::uuid IS NULL OR appointment.id<>$5)
            )::int active_appointments,
            count(appointment.id) FILTER (
              WHERE appointment.status IN ('confirmado','reagendado')
                AND appointment.start_at<$3
                AND appointment.end_at>$2
                AND ($5::uuid IS NULL OR appointment.id<>$5)
            )::int overlapping_appointments,
            (SELECT count(*)::int
             FROM scheduling_attendant_time_blocks block
             WHERE block.tenant_id=$4
               AND block.member_id=candidate.member_id
               AND block.start_at<$3
               AND block.end_at>$2) overlapping_blocks
     FROM unnest($1::uuid[]) candidate(member_id)
     LEFT JOIN scheduling_appointments appointment
       ON appointment.tenant_id=$4 AND appointment.assigned_member_id=candidate.member_id
     GROUP BY candidate.member_id`,
    [eligible.map((candidate) => candidate.memberId), interval.start, interval.end, tenantId, options.excludeAppointmentId ?? null]
  );
  const loadByMember = new Map(load.rows.map((row) => [row.member_id, row]));
  const withoutConflict = eligible.filter(
    (candidate) => (loadByMember.get(candidate.memberId)?.overlapping_appointments ?? 0) === 0
      && (loadByMember.get(candidate.memberId)?.overlapping_blocks ?? 0) === 0
  );
  if (!withoutConflict.length) return null;
  const minimumLoad = Math.min(...withoutConflict.map(
    (candidate) => loadByMember.get(candidate.memberId)?.active_appointments ?? 0
  ));
  const leastLoaded = withoutConflict.filter(
    (candidate) => (loadByMember.get(candidate.memberId)?.active_appointments ?? 0) === minimumLoad
  );
  const cursor = await client.query<{ last_member_id: string | null }>(
    "SELECT last_member_id FROM attendant_assignment_cursors WHERE tenant_id=$1 FOR UPDATE",
    [tenantId]
  );
  const currentIndex = eligible.findIndex(
    (candidate) => candidate.memberId === cursor.rows[0]?.last_member_id
  );
  const rotation = [...eligible.slice(currentIndex + 1), ...eligible.slice(0, currentIndex + 1)];
  const selected = rotation.find(
    (candidate) => leastLoaded.some((item) => item.memberId === candidate.memberId)
  ) ?? leastLoaded[0];
  await client.query(
    `UPDATE attendant_assignment_cursors
     SET last_member_id=$2,updated_at=now()
     WHERE tenant_id=$1`,
    [tenantId, selected.memberId]
  );
  return {
    ...selected,
    activeAppointments: loadByMember.get(selected.memberId)?.active_appointments ?? 0
  };
}

export async function selectNextAttendant(
  client: PoolClient,
  tenantId: string,
  options: { excludeMemberIds?: string[] } = {}
): Promise<AttendantAssignment | null> {
  await lockAttendantRotation(client, tenantId);
  const excluded = new Set(options.excludeMemberIds ?? []);
  const pool = (await eligibleAttendants(client, tenantId)).filter((candidate) => !excluded.has(candidate.memberId));
  if (!pool.length) {
    await client.query(
      "UPDATE attendant_assignment_cursors SET last_member_id=NULL,updated_at=now() WHERE tenant_id=$1",
      [tenantId]
    );
    return null;
  }
  const cursor = await client.query<{ last_member_id: string | null }>(
    "SELECT last_member_id FROM attendant_assignment_cursors WHERE tenant_id=$1 FOR UPDATE",
    [tenantId]
  );
  const currentIndex = pool.findIndex((candidate) => candidate.memberId === cursor.rows[0]?.last_member_id);
  const selected = pool[(currentIndex + 1) % pool.length];
  await client.query(
    `UPDATE attendant_assignment_cursors
     SET last_member_id=$2,updated_at=now()
     WHERE tenant_id=$1`,
    [tenantId, selected.memberId]
  );
  return selected;
}

async function loadCaseRows(
  client: PoolClient,
  tenantId: string,
  selector: { phone: string } | { leadId: string } | { conversationId: string }
): Promise<CaseRows | null> {
  let phone: string | null = null;
  if ("phone" in selector) {
    phone = selector.phone;
  } else if ("leadId" in selector) {
    phone = (await client.query<{ phone: string }>(
      "SELECT phone FROM scheduling_leads WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, selector.leadId]
    )).rows[0]?.phone ?? null;
  } else {
    phone = (await client.query<{ contact_phone: string }>(
      "SELECT contact_phone FROM conversations WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
      [tenantId, selector.conversationId]
    )).rows[0]?.contact_phone ?? null;
  }
  if (!phone) return null;
  const [leads, conversations] = await Promise.all([
    client.query<{ id: string; assigned_member_id: string | null; status: string }>(
      `SELECT id,assigned_member_id,status
       FROM scheduling_leads
       WHERE tenant_id=$1 AND ${normalizedPhoneSql("phone")}=${normalizedPhoneSql("$2")}
       ORDER BY created_at,id
       FOR UPDATE`,
      [tenantId, phone]
    ),
    client.query<{ id: string; assigned_user_id: string | null; status: string }>(
      `SELECT id,assigned_user_id,status
       FROM conversations
       WHERE tenant_id=$1 AND ${normalizedPhoneSql("contact_phone")}=${normalizedPhoneSql("$2")}
       ORDER BY created_at,id
       FOR UPDATE`,
      [tenantId, phone]
    )
  ]);
  return { phone, leads: leads.rows, conversations: conversations.rows };
}

async function eligibleByExistingAssignment(
  client: PoolClient,
  tenantId: string,
  rows: CaseRows
): Promise<AttendantAssignment | null> {
  const attendants = await eligibleAttendants(client, tenantId);
  const preferredAssignments = [
    rows.conversations.find(
      (conversation) => conversation.status === "open" && conversation.assigned_user_id
    )?.assigned_user_id,
    rows.leads.find(
      (lead) => !["fechado", "perdido"].includes(lead.status) && lead.assigned_member_id
    )?.assigned_member_id,
    rows.conversations.find((conversation) => conversation.assigned_user_id)?.assigned_user_id,
    rows.leads.find((lead) => lead.assigned_member_id)?.assigned_member_id
  ];
  for (const assignedId of preferredAssignments) {
    const attendant = attendants.find(
      (candidate) => candidate.userId === assignedId || candidate.memberId === assignedId
    );
    if (attendant) return attendant;
  }
  return null;
}

async function recordAssignment(
  client: PoolClient,
  input: {
    tenantId: string;
    leadId: string;
    previousMemberId: string | null;
    assignment: AttendantAssignment | null;
    reason: AssignmentReason;
    actor?: AssignmentActor;
  }
): Promise<void> {
  if (input.previousMemberId === input.assignment?.memberId) return;
  const details = {
    responsavel_anterior_member_id: input.previousMemberId,
    responsavel_novo_member_id: input.assignment?.memberId ?? null,
    responsavel_novo_user_id: input.assignment?.userId ?? null,
    motivo: input.reason,
    actor_user_id: input.actor?.userId ?? null
  };
  const eventType = input.reason === "retorno_conversa_encerrada"
    ? "responsavel_reatribuido_retorno"
    : input.reason === "transferencia_manual"
      ? "responsavel_transferido"
      : input.reason === "removido_do_pool"
        ? "responsavel_redistribuido"
        : input.reason === "pool_expandido"
          ? "responsavel_redistribuido"
        : "responsavel_atribuido_automaticamente";
  await client.query(
    `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
     VALUES($1,$2,$3,$4)`,
    [input.leadId, input.tenantId, eventType, details]
  );
  await client.query(
    `INSERT INTO audit_logs(
       actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
     ) VALUES($1,$2,$3,$4,'scheduling_lead',$5,$6,$7,$8)`,
    [
      input.actor?.userId ?? null,
      input.tenantId,
      input.actor?.actorScope ?? "workspace",
      `assignment.${input.reason}`,
      input.leadId,
      details,
      input.actor?.ipAddress ?? null,
      input.actor?.userAgent ?? null
    ]
  );
}

async function synchronizeRows(
  client: PoolClient,
  tenantId: string,
  rows: CaseRows,
  assignment: AttendantAssignment | null,
  reason: AssignmentReason,
  actor?: AssignmentActor,
  options: { preserveFinalHistory?: boolean; preserveCaseWhenUnassigned?: boolean } = {}
): Promise<{ leads: number; conversations: number; appointments: number }> {
  const memberId = assignment?.memberId ?? null;
  const userId = assignment?.userId ?? null;
  const preserveCase = assignment === null && options.preserveCaseWhenUnassigned === true;
  let leads = 0;
  const changedLeads: Array<{ id: string; previousMemberId: string | null }> = [];
  for (const lead of preserveCase ? [] : rows.leads) {
    if (options.preserveFinalHistory && ["fechado", "perdido"].includes(lead.status)) continue;
    if (lead.assigned_member_id === memberId) continue;
    await client.query(
      `UPDATE scheduling_leads SET assigned_member_id=$3,
         sdr_member_id=COALESCE(sdr_member_id,$3),updated_at=now()
       WHERE tenant_id=$1 AND id=$2`,
      [tenantId, lead.id, memberId]
    );
    await recordAssignment(client, {
      tenantId,
      leadId: lead.id,
      previousMemberId: lead.assigned_member_id,
      assignment,
      reason,
      actor
    });
    changedLeads.push({ id: lead.id, previousMemberId: lead.assigned_member_id });
    leads += 1;
  }
  const conversationResult = preserveCase ? { rowCount: 0 } : await client.query(
    `UPDATE conversations
     SET assigned_user_id=$3,
         claimed_at=CASE WHEN $3::uuid IS NULL THEN NULL
                         WHEN assigned_user_id IS DISTINCT FROM $3 THEN now()
                         ELSE claimed_at END
     WHERE tenant_id=$1
       AND ${normalizedPhoneSql("contact_phone")}=${normalizedPhoneSql("$2")}
       AND ($4::boolean=false OR status='open')
       AND assigned_user_id IS DISTINCT FROM $3`,
    [tenantId, rows.phone, userId, options.preserveFinalHistory === true]
  );
  for (const conversation of rows.conversations) {
    if (conversation.assigned_user_id === userId) continue;
    if (options.preserveFinalHistory && conversation.status !== "open") continue;
    await client.query(
      "SELECT pg_notify('atendon_realtime_changes',$1)",
      [JSON.stringify({
        v: 1,
        type: "case.assignment.changed",
        tenantId,
        caseId: conversation.id,
        conversationId: conversation.id,
        entityId: randomUUID(),
        previousUserId: conversation.assigned_user_id,
        assignedUserId: userId
      })]
    );
    await client.query(
      `INSERT INTO audit_logs(
         actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
       ) VALUES($1,$2,$3,$4,'conversation',$5,$6,$7,$8)`,
      [
        actor?.userId ?? null,
        tenantId,
        actor?.actorScope ?? "workspace",
        `assignment.${reason}`,
        conversation.id,
        {
          responsavel_anterior_user_id: conversation.assigned_user_id,
          responsavel_novo_user_id: userId,
          motivo: reason
        },
        actor?.ipAddress ?? null,
        actor?.userAgent ?? null
      ]
    );
  }
  if (changedLeads.length) {
    const previousMemberIds = [...new Set(
      changedLeads.flatMap((lead) => lead.previousMemberId ? [lead.previousMemberId] : [])
    )];
    const previousMembers = previousMemberIds.length
      ? await client.query<{ id: string; user_id: string }>(
          `SELECT id,user_id
           FROM workspace_members
           WHERE workspace_id=$1 AND id=ANY($2::uuid[])`,
          [tenantId, previousMemberIds]
        )
      : { rows: [] };
    const previousUserByMemberId = new Map(
      previousMembers.rows.map((member) => [member.id, member.user_id])
    );
    for (const lead of changedLeads) {
      await client.query(
        "SELECT pg_notify('atendon_realtime_changes',$1)",
        [JSON.stringify({
          v: 1,
          type: "case.assignment.changed",
          tenantId,
          caseId: lead.id,
          leadId: lead.id,
          entityId: randomUUID(),
          previousUserId: lead.previousMemberId
            ? previousUserByMemberId.get(lead.previousMemberId) ?? null
            : null,
          assignedUserId: userId
        })]
      );
    }
  }
  const leadIds = rows.leads.map((lead) => lead.id);
  const activeAppointments = leadIds.length
    ? await client.query<{
        id: string;
        lead_id: string;
        assigned_member_id: string | null;
        previous_user_id: string | null;
        lead_name: string | null;
        lead_phone: string;
        start_at: Date;
      }>(
        `SELECT appointment.id,appointment.lead_id,appointment.assigned_member_id,
                previous_member.user_id previous_user_id,
                lead.name lead_name,lead.phone lead_phone,appointment.start_at
         FROM scheduling_appointments appointment
         JOIN scheduling_leads lead
           ON lead.id=appointment.lead_id AND lead.tenant_id=appointment.tenant_id
         LEFT JOIN workspace_members previous_member
           ON previous_member.id=appointment.assigned_member_id
          AND previous_member.workspace_id=appointment.tenant_id
         WHERE appointment.tenant_id=$1
           AND appointment.lead_id=ANY($2::uuid[])
           AND appointment.status IN ('confirmado','reagendado')
           AND appointment.assigned_member_id IS DISTINCT FROM $3`,
        [tenantId, leadIds, memberId]
      )
    : { rows: [] };
  const appointmentResult = leadIds.length
    ? await client.query(
        `UPDATE scheduling_appointments
         SET assigned_member_id=$3,
             assigned_at=CASE WHEN $3::uuid IS NULL THEN NULL ELSE now() END,
             updated_at=now()
         WHERE tenant_id=$1 AND lead_id=ANY($2::uuid[])
           AND status IN ('confirmado','reagendado')
           AND assigned_member_id IS DISTINCT FROM $3`,
        [tenantId, leadIds, memberId]
      )
    : { rowCount: 0 };
  for (const appointment of activeAppointments.rows) {
    const details = {
      lead_id: appointment.lead_id,
      responsavel_anterior_member_id: appointment.assigned_member_id,
      responsavel_novo_member_id: memberId,
      motivo: reason
    };
    await client.query(
      `INSERT INTO audit_logs(
         actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,ip_address,user_agent
       ) VALUES($1,$2,$3,$4,'scheduling_appointment',$5,$6,$7,$8)`,
      [
        actor?.userId ?? null,
        tenantId,
        actor?.actorScope ?? "workspace",
        `assignment.${reason}`,
        appointment.id,
        details,
        actor?.ipAddress ?? null,
        actor?.userAgent ?? null
      ]
    );
    const recipients = [
      ...(userId ? [{ userId, direction: "in" }] : []),
      ...(appointment.previous_user_id && appointment.previous_user_id !== userId
        ? [{ userId: appointment.previous_user_id, direction: "out" }]
        : [])
    ];
    for (const recipient of recipients) {
      const alert = await client.query<{ id: string }>(
        `INSERT INTO system_alerts(tenant_id,message,kind,audience,metadata)
         VALUES($1,$2,'meeting','selected',$3) RETURNING id`,
        [
          tenantId,
          `${recipient.direction === "in" ? "Reunião atribuída" : "Reunião redistribuída"}: ${appointment.lead_name?.trim() || appointment.lead_phone}`,
          { event: `appointment_reassigned_${recipient.direction}`, appointment_id: appointment.id, ...details }
        ]
      );
      await client.query(
        `INSERT INTO system_alert_receipts(alert_id,tenant_id,user_id)
         VALUES($1,$2,$3)
         ON CONFLICT DO NOTHING`,
        [alert.rows[0].id, tenantId, recipient.userId]
      );
    }
  }
  return {
    leads,
    conversations: conversationResult.rowCount ?? 0,
    appointments: appointmentResult.rowCount ?? 0
  };
}

export async function ensureCaseAssignment(
  client: PoolClient,
  input: {
    tenantId: string;
    selector: { phone: string } | { leadId: string } | { conversationId: string };
    reason: Extract<AssignmentReason, "novo_contato" | "lead_criado" | "retorno_conversa_encerrada" | "reuniao_sem_responsavel">;
    forceRotation?: boolean;
    preferredMemberId?: string;
  }
): Promise<AttendantAssignment | null> {
  await lockAttendantRotation(client, input.tenantId);
  const rows = await loadCaseRows(client, input.tenantId, input.selector);
  if (!rows) return null;
  const preferred = input.preferredMemberId
    ? (await eligibleAttendants(client, input.tenantId)).find(
        (candidate) => candidate.memberId === input.preferredMemberId
      ) ?? null
    : null;
  const current = input.forceRotation || input.preferredMemberId
    ? null
    : await eligibleByExistingAssignment(client, input.tenantId, rows);
  const assignment = preferred ?? current ?? await selectNextAttendant(client, input.tenantId);
  await synchronizeRows(client, input.tenantId, rows, assignment, input.reason);
  return assignment;
}

export async function rebalanceUnscheduledAssignments(
  client: PoolClient,
  input: {
    tenantId: string;
    actor: AssignmentActor & { userId: string };
  }
): Promise<{ leads: number; conversations: number; appointments: number }> {
  await lockAttendantRotation(client, input.tenantId);
  const cases = await client.query<{ phone: string }>(
    `WITH active_cases AS (
       SELECT lead.phone
       FROM scheduling_leads lead
       WHERE lead.tenant_id=$1
         AND lead.status NOT IN ('fechado','perdido')
       UNION
       SELECT conversation.contact_phone
       FROM conversations conversation
       WHERE conversation.tenant_id=$1 AND conversation.status='open'
     )
     SELECT min(active_case.phone) phone
     FROM active_cases active_case
     WHERE NOT EXISTS (
       SELECT 1
       FROM scheduling_leads lead
       JOIN scheduling_appointments appointment
         ON appointment.tenant_id=lead.tenant_id AND appointment.lead_id=lead.id
       WHERE lead.tenant_id=$1
         AND ${normalizedPhoneSql("lead.phone")}=${normalizedPhoneSql("active_case.phone")}
         AND appointment.status IN ('confirmado','reagendado')
     )
     GROUP BY ${normalizedPhoneSql("active_case.phone")}
     ORDER BY ${normalizedPhoneSql("active_case.phone")}`,
    [input.tenantId]
  );
  const totals = { leads: 0, conversations: 0, appointments: 0 };
  for (const item of cases.rows) {
    const rows = await loadCaseRows(client, input.tenantId, { phone: item.phone });
    if (!rows) continue;
    const assignment = await selectNextAttendant(client, input.tenantId);
    const changed = await synchronizeRows(
      client,
      input.tenantId,
      rows,
      assignment,
      "pool_expandido",
      input.actor,
      { preserveFinalHistory: true, preserveCaseWhenUnassigned: true }
    );
    totals.leads += changed.leads;
    totals.conversations += changed.conversations;
    totals.appointments += changed.appointments;
  }
  return totals;
}

export async function transferCaseAssignment(
  client: PoolClient,
  input: {
    tenantId: string;
    selector: { leadId: string } | { conversationId: string };
    targetMemberId: string | null;
    actor: AssignmentActor & { userId: string };
    manager: boolean;
    preserveAutomation?: boolean;
  }
): Promise<{ found: boolean; previousUserId: string | null; assignment: AttendantAssignment | null }> {
  await lockAttendantRotation(client, input.tenantId);
  const rows = await loadCaseRows(client, input.tenantId, input.selector);
  if (!rows) return { found: false, previousUserId: null, assignment: null };
  const attendants = await eligibleAttendants(client, input.tenantId);
  const actorAttendant = attendants.find((candidate) => candidate.userId === input.actor.userId);
  const current = await eligibleByExistingAssignment(client, input.tenantId, rows);
  if (!input.manager) {
    if (!actorAttendant || current?.memberId !== actorAttendant.memberId) {
      return { found: false, previousUserId: null, assignment: null };
    }
    if (!input.targetMemberId) {
      throw Object.assign(new Error("Operadores não podem remover o responsável"), { statusCode: 403 });
    }
  }
  const assignment = input.targetMemberId
    ? attendants.find((candidate) => candidate.memberId === input.targetMemberId) ?? null
    : null;
  if (input.targetMemberId && !assignment) {
    throw Object.assign(new Error("Responsável deve ser um atendente ativo do pool"), { statusCode: 400 });
  }
  await synchronizeRows(
    client,
    input.tenantId,
    rows,
    assignment,
    "transferencia_manual",
    input.actor
  );
  if (assignment && !input.preserveAutomation) {
    await client.query(
      `UPDATE conversations
       SET ai_active=false,handoff_reason='manually_paused',handoff_error_code=NULL
       WHERE tenant_id=$1
         AND ${normalizedPhoneSql("contact_phone")}=${normalizedPhoneSql("$2")}
         AND status='open'`,
      [input.tenantId, rows.phone]
    );
    const paused = await client.query<{ lead_id: string }>(
      `UPDATE lead_qualifications qualification
       SET status='pausado',updated_at=now()
       FROM scheduling_leads lead
       WHERE lead.id=qualification.lead_id
         AND lead.tenant_id=qualification.tenant_id
         AND qualification.tenant_id=$1
         AND ${normalizedPhoneSql("lead.phone")}=${normalizedPhoneSql("$2")}
         AND qualification.status='em_andamento'
       RETURNING qualification.lead_id`,
      [input.tenantId, rows.phone]
    );
    for (const pausedLead of paused.rows) {
      await client.query(
        `INSERT INTO scheduling_lead_events(lead_id,tenant_id,event_type,details)
         VALUES($1,$2,'formulario_pausado',$3)`,
        [pausedLead.lead_id, input.tenantId, { motivo: "conversation_assigned" }]
      );
    }
  }
  return { found: true, previousUserId: current?.userId ?? null, assignment };
}

export async function redistributeRemovedAssignments(
  client: PoolClient,
  input: {
    tenantId: string;
    removedMemberIds: string[];
    actor: AssignmentActor & { userId: string };
  }
): Promise<{ leads: number; conversations: number; appointments: number }> {
  if (!input.removedMemberIds.length) return { leads: 0, conversations: 0, appointments: 0 };
  await lockAttendantRotation(client, input.tenantId);
  const cases = await client.query<{ phone: string }>(
    `WITH removed_users AS (
       SELECT user_id
       FROM workspace_members
       WHERE workspace_id=$1 AND id=ANY($2::uuid[])
     ), active_phones AS (
       SELECT lead.phone
       FROM scheduling_leads lead
       WHERE lead.tenant_id=$1
         AND lead.assigned_member_id=ANY($2::uuid[])
         AND lead.status NOT IN ('fechado','perdido')
       UNION
       SELECT conversation.contact_phone
       FROM conversations conversation
       WHERE conversation.tenant_id=$1
         AND conversation.status='open'
         AND conversation.assigned_user_id IN (SELECT user_id FROM removed_users)
     )
     SELECT DISTINCT phone FROM active_phones ORDER BY phone`,
    [input.tenantId, input.removedMemberIds]
  );
  const totals = { leads: 0, conversations: 0, appointments: 0 };
  for (const item of cases.rows) {
    const rows = await loadCaseRows(client, input.tenantId, { phone: item.phone });
    if (!rows) continue;
    const assignment = await selectNextAttendant(client, input.tenantId);
    const changed = await synchronizeRows(
      client,
      input.tenantId,
      rows,
      assignment,
      "removido_do_pool",
      input.actor,
      { preserveFinalHistory: true, preserveCaseWhenUnassigned: true }
    );
    totals.leads += changed.leads;
    totals.conversations += changed.conversations;
    totals.appointments += changed.appointments;
  }
  return totals;
}

export async function memberIdForUser(
  client: PoolClient,
  tenantId: string,
  userId: string
): Promise<string | null> {
  return (await client.query<{ id: string }>(
    `SELECT id FROM workspace_members
     WHERE workspace_id=$1 AND user_id=$2 AND status='active'
     LIMIT 1`,
    [tenantId, userId]
  )).rows[0]?.id ?? null;
}
