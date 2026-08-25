import { pathToFileURL } from "node:url";
import type { PoolClient } from "pg";
import { db } from "../src/db/client.js";
import {
  enqueueInboundRecovery,
  inboundJobId,
  inboundQueue,
  inboundRecoveryJobId
} from "../src/queue/message-queue.js";
import type { SessionMessage } from "../src/modules/messages/types.js";

const NEWAVE_SLUG = "newave-ia";
const RUNNING_JOB_STATES = new Set(["active", "waiting", "delayed", "prioritized", "waiting-children"]);

export interface RecoveryCliOptions {
  execute: boolean;
  externalMessageIds: string[];
}

export function parseRecoveryCliOptions(argv: string[]): RecoveryCliOptions {
  const execute = argv.includes("--execute");
  const externalMessageIds = argv.flatMap((argument, index) => {
    if (argument === "--external-message-id") return argv[index + 1] ? [argv[index + 1]!] : [];
    if (argument.startsWith("--external-message-id=")) return [argument.slice("--external-message-id=".length)];
    return [];
  }).map((value) => value.trim()).filter(Boolean);
  const unique = [...new Set(externalMessageIds)];
  if (unique.length < 1 || unique.length > 2) {
    throw new Error("Informe um ou dois --external-message-id (o comando roda em dry-run sem --execute)");
  }
  return { execute, externalMessageIds: unique };
}

type CandidateRow = {
  conversation_id: string;
  message_id: string;
  session_id: string;
  contact_phone: string;
  contact_jid: string | null;
  contact_name: string | null;
  content: string;
  external_message_id: string;
  media_type: "audio" | "image" | "document" | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  media_size_bytes: number | null;
  media_is_sticker: boolean;
};

function sessionMessage(tenantId: string, row: CandidateRow): SessionMessage {
  return {
    kind: "contact",
    tenantId,
    sessionId: row.session_id,
    contactPhone: row.contact_phone,
    ...(row.contact_jid ? { contactJid: row.contact_jid } : {}),
    ...(row.contact_name ? { contactName: row.contact_name } : {}),
    externalId: row.external_message_id,
    text: row.content,
    ...(row.media_type ? { mediaType: row.media_type } : {}),
    ...(row.media_mime_type ? { mediaMimeType: row.media_mime_type } : {}),
    ...(row.media_file_name ? { mediaFileName: row.media_file_name } : {}),
    ...(row.media_size_bytes !== null ? { mediaSizeBytes: row.media_size_bytes } : {}),
    ...(row.media_is_sticker ? { mediaIsSticker: true } : {})
  };
}

async function hasRunningJob(message: SessionMessage): Promise<boolean> {
  for (const id of [inboundJobId(message), inboundRecoveryJobId(message)]) {
    const job = await inboundQueue.getJob(id);
    if (job && RUNNING_JOB_STATES.has(await job.getState())) return true;
  }
  return false;
}

async function lockedCandidate(client: PoolClient, tenantId: string, externalId: string) {
  const result = await client.query<CandidateRow>(
    `SELECT conversation.id conversation_id,message.id message_id,
            conversation.session_id,conversation.contact_phone,conversation.contact_jid,
            conversation.contact_name,message.content,message.external_message_id,
            message.media_type,message.media_mime_type,message.media_file_name,
            message.media_size_bytes,message.media_is_sticker
     FROM messages message
     JOIN conversations conversation ON conversation.id=message.conversation_id
     WHERE conversation.tenant_id=$1
       AND message.external_message_id=$2
       AND message.sender='contact'
       AND message.external_message_id IS NOT NULL
       AND conversation.handoff_reason='technical_failure'
       AND conversation.ai_active=false
       AND NOT EXISTS (
         SELECT 1 FROM messages later
         WHERE later.conversation_id=conversation.id
           AND (later.created_at,later.id)>(message.created_at,message.id)
       )
     ORDER BY message.created_at DESC,message.id DESC
     LIMIT 2
     FOR UPDATE OF conversation,message`,
    [tenantId, externalId]
  );
  return result.rows.length === 1 ? result.rows[0] : undefined;
}

export async function recoverNewaveTechnicalHandoffs(options: RecoveryCliOptions) {
  const tenant = await db.query<{ id: string }>("SELECT id FROM tenants WHERE slug=$1", [NEWAVE_SLUG]);
  const tenantId = tenant.rows[0]?.id;
  if (!tenantId) throw new Error("Workspace Newave não encontrado");

  const cases: Array<{ external_message_id: string; status: string; detail?: string }> = [];
  for (const externalId of options.externalMessageIds) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const candidate = await lockedCandidate(client, tenantId, externalId);
      if (!candidate) {
        await client.query("ROLLBACK");
        cases.push({ external_message_id: externalId, status: "skipped", detail: "caso mudou, não é técnico ou já recebeu resposta" });
        continue;
      }
      const message = sessionMessage(tenantId, candidate);
      if (await hasRunningJob(message)) {
        await client.query("ROLLBACK");
        cases.push({ external_message_id: externalId, status: "skipped", detail: "job já está ativo" });
        continue;
      }
      const attempted = await client.query(
        `SELECT 1 FROM audit_logs
         WHERE workspace_id=$1 AND action='conversation.technical_recovery_queued' AND resource_id=$2`,
        [tenantId, candidate.message_id]
      );
      if (attempted.rows[0]) {
        await client.query("ROLLBACK");
        cases.push({ external_message_id: externalId, status: "skipped", detail: "recuperação já executada" });
        continue;
      }
      if (!options.execute) {
        await client.query("ROLLBACK");
        cases.push({ external_message_id: externalId, status: "eligible" });
        continue;
      }

      await client.query(
        `INSERT INTO audit_logs(workspace_id,actor_scope,action,resource_type,resource_id,metadata)
         VALUES($1,'root','conversation.technical_recovery_queued','message',$2,$3)`,
        [tenantId, candidate.message_id, { external_message_id: externalId, operation: "newave_technical_recovery_20260806" }]
      );
      await client.query(
        `UPDATE conversations
         SET ai_active=true,handoff_reason=NULL,handoff_error_code=NULL,status='open',resolved_at=NULL
         WHERE id=$1 AND tenant_id=$2`,
        [candidate.conversation_id, tenantId]
      );
      await client.query(
        "UPDATE messages SET processed_at=NULL,processing_started_at=NULL WHERE id=$1 AND conversation_id=$2",
        [candidate.message_id, candidate.conversation_id]
      );
      // Enqueue while the row locks are held. A concurrent human response must
      // wait and will then disable the IA before this job can answer.
      await enqueueInboundRecovery(message);
      await client.query("COMMIT");
      cases.push({ external_message_id: externalId, status: "queued" });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      cases.push({
        external_message_id: externalId,
        status: "skipped",
        detail: error instanceof Error ? error.message : String(error)
      });
    } finally {
      client.release();
    }
  }
  return {
    workspace: NEWAVE_SLUG,
    dry_run: !options.execute,
    eligible: cases.filter((item) => item.status === "eligible").length,
    queued: cases.filter((item) => item.status === "queued").length,
    skipped: cases.filter((item) => item.status === "skipped").length,
    cases
  };
}

export async function runRecoveryCli(argv: string[]) {
  return recoverNewaveTechnicalHandoffs(parseRecoveryCliOptions(argv));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runRecoveryCli(process.argv.slice(2))
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await inboundQueue.close();
      await db.end();
    });
}
