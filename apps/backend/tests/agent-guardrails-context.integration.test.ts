import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { InstagramRepository } from "../src/modules/instagram/repository.js";
import { MessageRepository } from "../src/modules/messages/repository.js";
import {
  isTripzZuluAgent,
  tripzZuluDetectsOwnerNameReferral,
  tripzZuluRequestsOwnerHandoff
} from "../src/modules/tripz-ai/zulu.js";

// Regressão do B1 do release visual: o TS2339 de `row.guardrails` apontava uma query sem a coluna.
// Calar o compilador com `guardrails?: unknown` deixou os dois SELECT finais (WhatsApp e Instagram)
// sem `agent.guardrails`: o contexto saía sempre `enabled:false` e o encaminhamento do Zulu
// (process-message.ts) deixava de rodar. Aqui o contexto vem do banco, pelos dois canais.
const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
const key = "agent-guardrails-key-000000000000000001";
const suffix = randomUUID();
const guardrails = {
  enabled: true,
  owner_name: "Marcos",
  owner_referral_reply: "Olá! O Marcos está em atendimento, vou transferir o chamado.",
  offers_group_link: "https://chat.whatsapp.com/guardrails-test",
  offers_group_label: "da Tripz"
};
const instagramContactId = `igsid-${suffix}`;
let tenantId = "";
let whatsappSessionId = "";
let instagramSessionId = "";

type Loaded = Awaited<ReturnType<MessageRepository["recordInboundAndLoadContext"]>>;

function expectGuardrailsLoaded(context: Loaded): void {
  expect(context?.guardrails).toEqual({
    enabled: true,
    ownerName: guardrails.owner_name,
    ownerReferralReply: guardrails.owner_referral_reply,
    offersGroupLink: guardrails.offers_group_link,
    offersGroupLabel: guardrails.offers_group_label
  });
  expect(context?.offersGroupLink).toBe(guardrails.offers_group_link);
  // Mesmas funções do process-message: sem guardrails.enabled o encaminhamento do Zulu não dispara.
  const ownerName = context?.guardrails?.ownerName ?? "";
  expect(isTripzZuluAgent(context?.systemPrompt ?? "", true)).toBe(true);
  expect(tripzZuluDetectsOwnerNameReferral("oi, o Marcos me passou seu contato", ownerName)).toBe(true);
  expect(tripzZuluRequestsOwnerHandoff("quero falar com o Marcos", ownerName)).toBe(true);
}

beforeAll(async () => {
  const database = (await pool.query<{ current_database: string }>("SELECT current_database()")).rows[0].current_database;
  // Este arquivo escreve dados: só roda em banco de teste (atendon_test ou o descartável atendon_test_<uuid>).
  if (!/^atendon_test(_[0-9a-f]{32})?$/.test(database)) throw new Error(`banco ${database} fora da lista de testes`);

  tenantId = (await pool.query<{ id: string }>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id", [`Guardrails ${suffix}`])).rows[0].id;
  whatsappSessionId = (await pool.query<{ id: string }>("INSERT INTO whatsapp_sessions(tenant_id,status) VALUES($1,'connected') RETURNING id", [tenantId])).rows[0].id;
  const accountId = `account-${suffix}`;
  const instagram = new InstagramRepository(pool, key);
  instagramSessionId = (await instagram.saveConnection({
    tenantId, label: "Instagram", accountId, accessToken: "token", expiresAt: new Date(Date.now() + 3_600_000)
  })).id;
  // O trigger de bootstrap cria a versão 1 (ativa); guardrails não faz parte do snapshot imutável da versão.
  const agentId = (await pool.query<{ id: string }>(
    `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,is_active)
     VALUES($1,'Zulu','Você é a Zulu, assistente da Tripz Turismo.','test/model',true) RETURNING id`,
    [tenantId]
  )).rows[0].id;
  await pool.query(
    "UPDATE agent_config_versions SET guardrails=$2::jsonb WHERE agent_config_id=$1 AND status='active'",
    [agentId, JSON.stringify(guardrails)]
  );
  // A conversa do Instagram precisa existir antes do inbound (mesmo seed de instagram-followup).
  await instagram.persistEvent(tenantId, instagramSessionId, {
    kind: "message", eventId: `seed:${suffix}`, accountId, providerUserId: instagramContactId,
    timestamp: new Date(), text: "Olá", isEcho: false,
    raw: { sender: { id: instagramContactId }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid: `seed-${suffix}`, text: "Olá" } }
  }, Buffer.from("{}"));
});

afterAll(async () => {
  if (tenantId) await pool.query("DELETE FROM tenants WHERE id=$1", [tenantId]);
  await pool.end();
});

describe("guardrails do agente no contexto do inbound", () => {
  it("WhatsApp: recordInboundAndLoadContext projeta agent.guardrails", async () => {
    const repository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const context = await repository.recordInboundAndLoadContext({
      tenantId, sessionId: whatsappSessionId, contactPhone: `5511${suffix.replace(/\D/g, "").padEnd(9, "6").slice(0, 9)}`,
      text: "oi", externalId: `wa-${suffix}`
    }, { claim: false });
    expectGuardrailsLoaded(context);
  });

  it("Instagram: recordInstagramInboundAndLoadContext projeta agent.guardrails", async () => {
    const repository = new MessageRepository(pool, config, { followUp: async () => "enqueued" });
    const context = await repository.recordInboundAndLoadContext({
      channel: "instagram", tenantId, sessionId: instagramSessionId, contactPhone: `ig:${instagramContactId}`,
      instagramContactId, externalId: `ig-${suffix}`, text: "oi"
    }, { claim: false });
    expectGuardrailsLoaded(context);
  });
});
