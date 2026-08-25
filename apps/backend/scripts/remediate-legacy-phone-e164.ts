import pg from "pg";
import { config } from "../src/config.js";
import { isQuarantinedPhone, normalizePhoneE164 } from "../src/phone.js";

const INCIDENT_ID = "legacy-phone-e164-2026-08-04";
const INVALID_LEAD_IDS = [
  "37918dfa-700e-45bf-b81a-239feda742a5",
  "324f55e4-c08f-4081-833a-bea001e1f386",
  "b5a1c607-0f85-4d99-ab6c-dfe2c6808d33"
] as const;
const INVALID_CONVERSATION_ID = "53fed382-860b-4882-9037-b9c1125e664a";
const KEEPER_LEAD_ID = "3171d153-804e-4dd1-9f5a-654fa051e0a3";
const DUPLICATE_LEAD_ID = "935555a4-5b4e-410b-9ff8-46ea0f9324d4";
const KEEPER_CONVERSATION_ID = "b1281be5-794a-4edd-a368-65bed48ece23";
const DUPLICATE_CONVERSATION_ID = "d51f2665-1f48-4d50-a7a8-fbeb47df89cd";
const SENTINELS = ["+999000000001", "+999000000002", "+999000000003"] as const;

type LeadRow = {
  id: string;
  tenant_id: string;
  phone: string;
  name: string | null;
  source: string;
  status: string;
  unit_id: string | null;
  assigned_member_id: string | null;
  facebook_attribution: unknown;
};

type ConversationRow = {
  id: string;
  tenant_id: string;
  contact_phone: string;
  contact_name: string | null;
  contact_jid: string | null;
  status: string;
  ai_active: boolean;
  handoff_reason: string | null;
};

type ReferenceCount = { key: string; count: number };

function invariant(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Legacy phone remediation precondition failed: ${message}`);
}

function canonicalOrNull(phone: string): string | null {
  try {
    return normalizePhoneE164(phone);
  } catch {
    return null;
  }
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function referenceCounts(client: pg.Client, parentTable: string, parentId: string): Promise<ReferenceCount[]> {
  const references = await client.query<{ schema_name: string; table_name: string; column_name: string }>(
    `SELECT DISTINCT child_namespace.nspname schema_name,child.relname table_name,child_attribute.attname column_name
     FROM pg_constraint constraint_definition
     JOIN pg_class child ON child.oid=constraint_definition.conrelid
     JOIN pg_namespace child_namespace ON child_namespace.oid=child.relnamespace
     JOIN LATERAL unnest(constraint_definition.conkey) WITH ORDINALITY child_key(attnum,position) ON true
     JOIN LATERAL unnest(constraint_definition.confkey) WITH ORDINALITY parent_key(attnum,position)
       ON parent_key.position=child_key.position
     JOIN pg_attribute child_attribute
       ON child_attribute.attrelid=constraint_definition.conrelid AND child_attribute.attnum=child_key.attnum
     JOIN pg_attribute parent_attribute
       ON parent_attribute.attrelid=constraint_definition.confrelid AND parent_attribute.attnum=parent_key.attnum
     WHERE constraint_definition.contype='f'
       AND constraint_definition.confrelid=$1::regclass
       AND parent_attribute.attname='id'
     ORDER BY child_namespace.nspname,child.relname,child_attribute.attname`,
    [parentTable]
  );
  const counts: ReferenceCount[] = [];
  for (const reference of references.rows) {
    const table = `${quoteIdentifier(reference.schema_name)}.${quoteIdentifier(reference.table_name)}`;
    const column = quoteIdentifier(reference.column_name);
    const result = await client.query<{ count: string }>(`SELECT count(*) count FROM ${table} WHERE ${column}=$1`, [parentId]);
    counts.push({
      key: `${reference.schema_name}.${reference.table_name}.${reference.column_name}`,
      count: Number(result.rows[0]?.count ?? 0)
    });
  }
  return counts;
}

function assertReferenceCounts(actual: ReferenceCount[], allowed: ReadonlyMap<string, number>, resource: string): void {
  for (const reference of actual) {
    invariant(
      reference.count === (allowed.get(reference.key) ?? 0),
      `${resource} has an unexpected reference count in ${reference.key}`
    );
  }
  for (const [key, expected] of allowed) {
    invariant(actual.some((reference) => reference.key === key && reference.count === expected), `${resource} is missing ${key}`);
  }
}

async function appointmentStatuses(client: pg.Client, leadId: string): Promise<string[]> {
  const result = await client.query<{ status: string }>(
    "SELECT status FROM scheduling_appointments WHERE lead_id=$1 ORDER BY start_at,id FOR UPDATE",
    [leadId]
  );
  return result.rows.map((row) => row.status).sort();
}

function sameValues(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === [...expected].sort()[index]);
}

async function validateAndRemediate(client: pg.Client): Promise<{ alreadyApplied: boolean }> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [INCIDENT_ID]);
  const previous = await client.query(
    "SELECT 1 FROM audit_logs WHERE action='phone_e164.legacy_remediation' AND resource_id=$1",
    [INCIDENT_ID]
  );
  if (previous.rowCount) {
    const remainingDuplicate = await client.query(
      "SELECT 1 FROM scheduling_leads WHERE id=$1 UNION ALL SELECT 1 FROM conversations WHERE id=$2",
      [DUPLICATE_LEAD_ID, DUPLICATE_CONVERSATION_ID]
    );
    const quarantined = await client.query<{ phone: string }>(
      "SELECT phone FROM scheduling_leads WHERE id=ANY($1::uuid[]) ORDER BY id",
      [INVALID_LEAD_IDS]
    );
    invariant(remainingDuplicate.rowCount === 0, "the incident is audited but the duplicate still exists");
    invariant(quarantined.rowCount === INVALID_LEAD_IDS.length, "the incident is audited but quarantined leads are missing");
    invariant(quarantined.rows.every((row) => isQuarantinedPhone(row.phone)), "the incident is audited but sentinels are missing");
    return { alreadyApplied: true };
  }

  const allLeadIds = [...INVALID_LEAD_IDS, KEEPER_LEAD_ID, DUPLICATE_LEAD_ID];
  const leads = await client.query<LeadRow>("SELECT * FROM scheduling_leads WHERE id=ANY($1::uuid[]) FOR UPDATE", [allLeadIds]);
  invariant(leads.rowCount === allLeadIds.length, "one or more audited leads no longer exist");
  const byLeadId = new Map(leads.rows.map((row) => [row.id, row]));
  const invalidLeads = INVALID_LEAD_IDS.map((id) => byLeadId.get(id));
  invariant(invalidLeads.every(Boolean), "one or more invalid leads could not be locked");
  invariant(invalidLeads.every((lead) => canonicalOrNull(lead!.phone) === null), "an audited invalid phone changed");

  const keeper = byLeadId.get(KEEPER_LEAD_ID)!;
  const duplicate = byLeadId.get(DUPLICATE_LEAD_ID)!;
  const keeperPhone = canonicalOrNull(keeper.phone);
  invariant(keeperPhone !== null && keeperPhone === canonicalOrNull(duplicate.phone), "the audited lead collision changed");
  invariant(keeper.tenant_id === duplicate.tenant_id, "collision leads belong to different workspaces");
  invariant(keeper.unit_id === duplicate.unit_id, "collision leads no longer share a unit");
  invariant(keeper.status === duplicate.status, "collision leads no longer share a status");
  invariant(keeper.assigned_member_id === duplicate.assigned_member_id, "collision leads no longer share an assignee");
  invariant(keeper.source.toLowerCase().includes("facebook"), "the selected keeper is no longer the Facebook lead");
  invariant(Object.keys((keeper.facebook_attribution ?? {}) as object).length > 0, "the selected keeper lost Facebook attribution");

  invariant(sameValues(await appointmentStatuses(client, INVALID_LEAD_IDS[0]), ["cancelado"]), "first invalid lead appointments changed");
  invariant(sameValues(await appointmentStatuses(client, INVALID_LEAD_IDS[1]), ["cancelado"]), "second invalid lead appointments changed");
  invariant(sameValues(await appointmentStatuses(client, INVALID_LEAD_IDS[2]), ["concluido", "no_show"]), "third invalid lead appointments changed");
  invariant(sameValues(await appointmentStatuses(client, KEEPER_LEAD_ID), ["cancelado"]), "keeper appointments changed");
  invariant(sameValues(await appointmentStatuses(client, DUPLICATE_LEAD_ID), ["confirmado"]), "duplicate appointments changed");

  const conversationIds = [INVALID_CONVERSATION_ID, KEEPER_CONVERSATION_ID, DUPLICATE_CONVERSATION_ID];
  const conversations = await client.query<ConversationRow>(
    "SELECT * FROM conversations WHERE id=ANY($1::uuid[]) FOR UPDATE",
    [conversationIds]
  );
  invariant(conversations.rowCount === conversationIds.length, "one or more audited conversations no longer exist");
  const byConversationId = new Map(conversations.rows.map((row) => [row.id, row]));
  const invalidConversation = byConversationId.get(INVALID_CONVERSATION_ID)!;
  const keeperConversation = byConversationId.get(KEEPER_CONVERSATION_ID)!;
  const duplicateConversation = byConversationId.get(DUPLICATE_CONVERSATION_ID)!;
  invariant(invalidConversation.contact_phone === invalidLeads[2]!.phone, "invalid lead and conversation phones diverged");
  invariant(invalidConversation.status === "closed", "invalid conversation is no longer closed");
  invariant(canonicalOrNull(keeperConversation.contact_phone) === keeperPhone, "keeper conversation phone changed");
  invariant(canonicalOrNull(duplicateConversation.contact_phone) === keeperPhone, "duplicate conversation phone changed");

  const keeperMessageCount = await client.query<{ count: string }>("SELECT count(*) count FROM messages WHERE conversation_id=$1", [KEEPER_CONVERSATION_ID]);
  invariant(Number(keeperMessageCount.rows[0]?.count ?? 0) > 0, "the selected keeper conversation has no message history");
  assertReferenceCounts(await referenceCounts(client, "conversations", INVALID_CONVERSATION_ID), new Map([
    ["public.outbound_message_requests.conversation_id", 2]
  ]), "invalid conversation");
  const invalidOutbound = await client.query<{ status: string }>(
    "SELECT status FROM outbound_message_requests WHERE conversation_id=$1 FOR UPDATE",
    [INVALID_CONVERSATION_ID]
  );
  invariant(invalidOutbound.rows.every((row) => row.status === "failed"), "invalid conversation has an active outbound request");
  assertReferenceCounts(await referenceCounts(client, "conversations", DUPLICATE_CONVERSATION_ID), new Map(), "duplicate conversation");
  assertReferenceCounts(await referenceCounts(client, "scheduling_leads", DUPLICATE_LEAD_ID), new Map([
    ["public.scheduling_appointments.lead_id", 1],
    ["public.scheduling_lead_events.lead_id", 7]
  ]), "duplicate lead");

  const sentinelCollision = await client.query(
    `SELECT 1 FROM scheduling_leads WHERE regexp_replace(phone,'\\D','','g')=ANY($1::text[])
     UNION ALL
     SELECT 1 FROM conversations WHERE regexp_replace(contact_phone,'\\D','','g')=ANY($1::text[])`,
    [SENTINELS.map((phone) => phone.replace(/\D/g, ""))]
  );
  invariant(sentinelCollision.rowCount === 0, "one or more quarantine sentinels are already in use");

  await client.query(
    `INSERT INTO audit_logs(actor_user_id,workspace_id,actor_scope,action,resource_type,resource_id,metadata,user_agent)
     VALUES(NULL,$1,'root','phone_e164.legacy_remediation','database',$2,$3,'atendon-remediate-legacy-phone-e164')`,
    [keeper.tenant_id, INCIDENT_ID, {
      reason: "phone values could not be recovered from internal history",
      standard: "ITU-T E.164 reserved country code +999",
      invalid_leads: invalidLeads,
      invalid_conversation: invalidConversation,
      collision: {
        keeper_lead: keeper,
        duplicate_lead: duplicate,
        keeper_conversation: keeperConversation,
        duplicate_conversation: duplicateConversation
      }
    }]
  );

  for (const [index, leadId] of INVALID_LEAD_IDS.entries()) {
    await client.query("UPDATE scheduling_leads SET phone=$2,updated_at=now() WHERE id=$1", [leadId, SENTINELS[index]]);
  }
  await client.query(
    `UPDATE conversations
     SET contact_phone=$2,contact_jid=NULL,ai_active=false
     WHERE id=$1`,
    [INVALID_CONVERSATION_ID, SENTINELS[2]]
  );
  await client.query("DELETE FROM conversations WHERE id=$1", [DUPLICATE_CONVERSATION_ID]);
  await client.query("UPDATE scheduling_appointments SET lead_id=$2,updated_at=now() WHERE lead_id=$1", [DUPLICATE_LEAD_ID, KEEPER_LEAD_ID]);
  await client.query("UPDATE scheduling_lead_events SET lead_id=$2 WHERE lead_id=$1", [DUPLICATE_LEAD_ID, KEEPER_LEAD_ID]);
  await client.query("DELETE FROM scheduling_leads WHERE id=$1", [DUPLICATE_LEAD_ID]);

  const postState = await client.query<{ source: string; tenant_id: string; id: string; phone: string }>(
    `SELECT 'scheduling_leads' source,tenant_id,id,phone FROM scheduling_leads
     UNION ALL SELECT 'conversations',tenant_id,id,contact_phone FROM conversations
     UNION ALL SELECT 'qualification_message_outbox',tenant_id,id,contact_phone FROM qualification_message_outbox
     UNION ALL SELECT 'scheduling_meeting_contact_delivery_outbox',tenant_id,id,contact_phone
       FROM scheduling_meeting_contact_delivery_outbox`
  );
  const seen = new Set<string>();
  for (const row of postState.rows) {
    const canonical = canonicalOrNull(row.phone);
    invariant(canonical !== null, `${row.source} still contains an invalid phone at ${row.id}`);
    if (row.source === "scheduling_leads" || row.source === "conversations") {
      const key = `${row.tenant_id}:${row.source}:${canonical}`;
      invariant(!seen.has(key), `${row.source} still contains a canonical phone collision`);
      seen.add(key);
    }
  }
  return { alreadyApplied: false };
}

const apply = process.argv.includes("--apply");
const client = new pg.Client({ connectionString: config.DATABASE_URL });
try {
  await client.connect();
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  const result = await validateAndRemediate(client);
  if (result.alreadyApplied) {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ ok: true, incident: INCIDENT_ID, already_applied: true }));
  } else if (apply) {
    await client.query("COMMIT");
    console.log(JSON.stringify({ ok: true, incident: INCIDENT_ID, applied: true, quarantined: 3, merged_duplicates: 1 }));
  } else {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ ok: true, incident: INCIDENT_ID, dry_run: true, changes_rolled_back: true }));
  }
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(JSON.stringify({
    ok: false,
    incident: INCIDENT_ID,
    error: error instanceof Error ? error.message : "Legacy phone remediation failed"
  }));
  process.exitCode = 1;
} finally {
  await client.end();
}
