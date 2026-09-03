import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { loadNewavePromptTemplate } from "../src/db/newave-template.js";

const marker = "<!-- NEWAVE_COMMERCIAL_SCRIPT_NO_FOLLOWUP_V1 -->";
const section26Start = "## 26. Follow-up, lembretes e ausência";
const section27 = "## 27. Transferência humana";
const section26Hash = "dcdc4ba7bd13a7c1113c9ac037df0ce33c2459f5060a7c9c5ceca0befa4e7b79";
const migrationPath = fileURLToPath(new URL("../src/db/migrations/0130_newave_sales_script_prompt.sql", import.meta.url));
const normalize = (value: string) => value.replaceAll("\r\n", "\n").trim();

function section(prompt: string, start: string, end?: string) {
  const from = prompt.indexOf(start);
  expect(from, `missing section ${start}`).toBeGreaterThanOrEqual(0);
  const to = end ? prompt.indexOf(end, from) : prompt.length;
  expect(to).toBeGreaterThan(from);
  return prompt.slice(from, to);
}

function newBlock(prompt: string) {
  const markerAt = prompt.indexOf(marker);
  expect(markerAt, "NEWAVE marker must exist before slicing the block").toBeGreaterThanOrEqual(0);
  return prompt.slice(markerAt);
}

const namedSections = [
  {
    title: "Escopo e precedência",
    action: /(?:aplique|seguir|respeite|priorize|prevalece)/i,
    data: /(?:escopo|precedência|regra|contrato)/i,
    transition: /(?:antes de|depois|próxim|transi|encaminh)/i,
  },
  {
    title: "Primeiro contato e formulário",
    action: /(?:acolh|pergunte|colete|apresente|ofereça)/i,
    data: /(?:primeiro contato|formulário|permissão|campo)/i,
    transition: /(?:qualifica|avance|próxim|transi)/i,
  },
  {
    title: "Qualificação adaptativa",
    action: /(?:adapte|pergunte|pule|qualifique|investigue)/i,
    data: /(?:segmento|cidade|familiaridade.*Newave|dor|gargalo|equipe|decisor|momento)/i,
    transition: /(?:com base|se .* então|avance|oportunidade|próxim)/i,
  },
  {
    title: "Oportunidade e projeção",
    action: /(?:calcule|estime|registre|explore|projete)/i,
    data: /(?:oportunidade|projeção|vendas|volume mensal|dados fornecidos|informad)/i,
    transition: /(?:sem garantia|avance|diagnóstico|agend)/i,
  },
  {
    title: "Agendamento e confirmação imediata",
    action: /(?:agende|confirme|retorne|ofereça|chame)/i,
    data: /(?:0|1|2|3)\s+horários?|Google Meet|20\s*(?:a|-|até)\s*40/i,
    transition: /(?:imediat|agendar_reuniao|confirmação|próxim)/i,
  },
  {
    title: "Preço, material, tempo e funcionamento",
    action: /(?:responda|explique|ofereça|trate|pergunte)/i,
    data: /(?:preço|material|falta de tempo|funcionamento)/i,
    transition: /(?:diagnóstico|demonstração|investimento|avance|agend)/i,
  },
  {
    title: "Diagnóstico, demonstração e investimento",
    action: /(?:conduza|demonstre|apresente|explique|avalie)/i,
    data: /(?:diagnóstico|demonstração|investimento|estrutura.*processo financeiro)/i,
    transition: /(?:objeç|proposta|agend|avanço|escolha)/i,
  },
  {
    title: "Objeções e avanço por escolha",
    action: /(?:acolha|responda|explore|ofereça|avance)/i,
    data: /(?:pensar|caro|incerteza|financeir|sócio|proposta|momento)/i,
    transition: /(?:fechamento por escolha|escolha|próxim|encaminh)/i,
  },
  {
    title: "Limite SDR e encaminhamento",
    action: /(?:encaminhe|declare|não formalize|transfira|pare)/i,
    data: /(?:limite SDR|intenção|sem formalizar venda|preparado para fechar)/i,
    transition: /(?:encaminhamento|humano|qualificação inicial|próxim)/i,
  },
];

describe("Newave commercial prompt contract", () => {
  it("preserves section 26 exactly and exposes one marked block", async () => {
    const prompt = await loadNewavePromptTemplate();
    const existing = section(prompt, section26Start, section27);
    expect(Buffer.byteLength(existing, "utf8")).toBe(2736);
    expect(createHash("sha256").update(existing).digest("hex")).toBe(section26Hash);
    const markerAt = prompt.indexOf(marker);
    expect(markerAt, "marker must be present before prefix slicing").toBeGreaterThanOrEqual(0);
    const prefix = prompt.slice(0, markerAt);
    expect(Buffer.byteLength(prefix, "utf8")).toBe(52582);
    expect(createHash("sha256").update(prefix).digest("hex")).toBe("ddac6803e45769016139872bdecdbcdcf92edd58491b76dce026f5f52af35f8e");
    expect(prefix.endsWith("\n")).toBe(true);
    expect(prompt.split(marker).length - 1).toBe(1);
    expect(newBlock(prompt)).toContain(marker);
    expect(existing).toContain("ofereça dois ou três horários reais");
  });

  it("proves each named scenario has action, conditional capability/data, and transition", async () => {
    const block = newBlock(await loadNewavePromptTemplate());
    for (const { title, action, data, transition } of namedSections) {
      const start = `### ${title}`;
      const next = namedSections[namedSections.findIndex(item => item.title === title) + 1]?.title;
      const subsection = section(block, start, next ? `### ${next}` : undefined);
      expect(subsection).toMatch(action);
      expect(subsection).toMatch(data);
      expect(subsection).toMatch(transition);
    }
  });

  it("requires explicit precedence in immediate scheduling without overriding section 26", async () => {
    const prompt = await loadNewavePromptTemplate();
    const block = newBlock(prompt);
    const scheduling = section(block, "### Agendamento e confirmação imediata", "### Preço, material, tempo e funcionamento");
    expect(scheduling).toMatch(/agendamento normal|objeções comerciais/i);
    expect(scheduling).toMatch(/(?:0\s*\/\s*1\s*\/\s*2|matriz[^\n]*0[^\n]*1[^\n]*2)[^\n]*(?:substitu|prevalec)[^\n]*(?:instruções anteriores|regra anterior)[^\n]*(?:dois ou três|2\s*(?:ou|e|\/)\s*3)[^\n]*/i);
    expect(scheduling).toMatch(/mensagens acionadas por eventos do sistema/i);
    expect(section(prompt, section26Start, section27)).toContain("ofereça dois ou três horários reais");
  });

  it("keeps protected operational contracts and excludes follow-up", async () => {
    const block = newBlock(await loadNewavePromptTemplate());
    const commercialText = block.replace(marker, "");
    expect(commercialText).not.toMatch(/menos de dois minutos/i);
    for (const field of ["segmento", "cidade|região", "familiaridade.*soluç(ões|oes).*Newave", "estrutura.*processo financeiro", "fontes atuais.*recursos", "principal dor|gargalo", "equipe", "autonomia|decisor", "momento", "ticket médio", "vendas|volume mensal", "pagamentos|financiamento", "perdas por crédito", "financeiras|recusas"]) expect(block).toMatch(new RegExp(field, "i"));
    for (const contract of [/agendamento normal|objeções(?!.*follow.?up)/i, /0\s+horários?[^\n]*(?:não|nunca)\s+invent/i, /1\s+horário[^\n]*(?:exatamente|somente|apenas)\s+1/i, /2\s+horários[^\n]*(?:exatamente|somente|apenas)\s+2/i, /3\s+horários[^\n]*(?:exatamente|somente|apenas)\s+2/i, /horários? retornados pela ferramenta/i]) expect(block).toMatch(contract);
    for (const item of ["plano", "desconto", "proposta", "contrato", "documenta(?:ção|mentos?)", "treinamento", "implantação"]) expect(block).toMatch(new RegExp(`(?:nunca|não)[^\\n]{0,120}(?:invent|promet)[^\\n]{0,120}${item}|${item}[^\\n]{0,120}(?:nunca|não)[^\\n]{0,120}(?:invent|promet)`, "i"));
    expect(block).toMatch(/(?:teto|limite)[^\n]*(?:duas perguntas comerciais)[^\n]*(?:substituíd|não vigente|não se aplica)/i);
    for (const contract of [/uma pergunta por mensagem/i, /sem rajada/i, /sem interrogatório/i, /pul(?:e|ando) campos conhecidos/i, /informa(?:ção|cao) parcial/i, /sem garantia/i, /confirma(?:r|ção)[^\n]*imediat/i]) expect(block).toMatch(contract);
    for (const excluded of [/dia anterior/i, /30\s*min/i, /24h/i, /3d/i, /pós.?reunião/i, /follow.?up/i, /prazo/i, /cadência/i, /ausência na reunião/i, /seção 26|regra[s]?\s*2.?3/i]) expect(commercialText).not.toMatch(excluded);
  });

  it("rejects human transfer and duplicated intention registration in the commercial block", async () => {
    const block = newBlock(await loadNewavePromptTemplate());
    const commercialText = block.replace(marker, "");
    expect(commercialText).not.toMatch(/transferir_atendente/i);
    expect(commercialText).not.toMatch(/(?:encaminh\w*|transfira\w*)[^\n]{0,160}humano/i);
    expect(commercialText).not.toMatch(/registre a intenção[^\n]*registre a intenção/i);
  });

  it("matches the migration dollar-quoted block exactly after normalization", async () => {
    const promptBlock = newBlock(await loadNewavePromptTemplate());
    const sql = await readFile(migrationPath, "utf8");
    const dollar = sql.match(/\$newave\$([\s\S]*?)\$newave\$/)?.[1] ?? sql.match(/\$\$([\s\S]*?)\$\$/)?.[1];
    expect(dollar, "migration dollar-quoted prompt block").toBeDefined();
    expect(normalize(dollar!)).toBe(normalize(promptBlock));
  });

  describe.sequential("real disposable PostgreSQL publication", () => {
    const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
    const tenantSlug = "newave-ia";
    const cleanup = async () => { await pool.query("DELETE FROM tenants WHERE slug IN ($1,'other-newave-ia')", [tenantSlug]); };
    afterAll(async () => { await pool.end(); });
    it("publishes one config and is idempotent without touching another tenant", async () => {
      await cleanup();
      try {
        const sql = await readFile(migrationPath, "utf8");
        const prompt = await loadNewavePromptTemplate();
        const t = (await pool.query("INSERT INTO tenants(name,slug,status,timezone) VALUES('Newave','newave-ia','active','UTC') RETURNING id")).rows[0].id;
        const other = (await pool.query("INSERT INTO tenants(name,slug,status,timezone) VALUES('Other','other-newave-ia','active','UTC') RETURNING id")).rows[0].id;
        const legacy = "LEGACY SYSTEM PROMPT  \n\n  preserve-this-whitespace  ";
        const expectedBlock = newBlock(prompt);
        const a = (await pool.query("INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active) VALUES($1,'Newave',$2,'model-before',$3,$4,true) RETURNING id", [t, legacy, { temperature: 0.2, mode: "safe" }, '["tool-before"]'])).rows[0].id;
        const b = (await pool.query("INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active) VALUES($1,'Other',$2,'other-model','{}','[]',true) RETURNING id", [other, "OTHER-PROMPT"])).rows[0].id;
        const beforeOther = (await pool.query("SELECT jsonb_build_object('config', (SELECT to_jsonb(c) FROM agent_configs c WHERE c.id=$1), 'versions', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM agent_config_versions v WHERE v.agent_config_id=$1), '[]'::jsonb)) AS snapshot", [b])).rows[0].snapshot;
        await pool.query(sql);
        const after = (await pool.query("SELECT a.*,v.system_prompt AS version_prompt,v.status AS version_status,v.ai_model AS version_ai_model,v.model_params AS version_model_params,v.enabled_tools AS version_enabled_tools FROM agent_configs a JOIN agent_config_versions v ON v.id=a.active_version_id WHERE a.id=$1", [a])).rows[0];
        expect(after.system_prompt).toBe(`${legacy}\n\n${expectedBlock}`);
        expect(after.system_prompt.slice(0, legacy.length)).toBe(legacy);
        expect(after.ai_model).toBe("model-before");
        expect(after.model_params).toEqual({ temperature: 0.2, mode: "safe" });
        expect(after.enabled_tools).toEqual(["tool-before"]);
        expect(after.version_prompt).toBe(after.system_prompt);
        expect(after.version_status).toBe("active");
        expect(after.version_ai_model).toBe("model-before");
        expect(after.version_model_params).toEqual({ temperature: 0.2, mode: "safe" });
        expect(after.version_enabled_tools).toEqual(["tool-before"]);
        expect(after.active_version_id).toBeTruthy();
        const versions = (await pool.query("SELECT id,status FROM agent_config_versions WHERE agent_config_id=$1", [a])).rows;
        expect(versions.filter(v => v.status === "active")).toHaveLength(1);
        expect(versions.filter(v => v.status !== "active").every(v => v.status === "retired")).toBe(true);
        const afterOtherFirst = (await pool.query("SELECT jsonb_build_object('config', (SELECT to_jsonb(c) FROM agent_configs c WHERE c.id=$1), 'versions', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM agent_config_versions v WHERE v.agent_config_id=$1), '[]'::jsonb)) AS snapshot", [b])).rows[0].snapshot;
        expect(afterOtherFirst).toEqual(beforeOther);
        await pool.query(sql);
        expect((await pool.query("SELECT count(*)::int AS n FROM agent_config_versions WHERE agent_config_id=$1", [a])).rows[0].n).toBe(versions.length);
        expect((await pool.query("SELECT active_version_id FROM agent_configs WHERE id=$1", [a])).rows[0].active_version_id).toBe(after.active_version_id);
        const afterOther = (await pool.query("SELECT jsonb_build_object('config', (SELECT to_jsonb(c) FROM agent_configs c WHERE c.id=$1), 'versions', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY v.id) FROM agent_config_versions v WHERE v.agent_config_id=$1), '[]'::jsonb)) AS snapshot", [b])).rows[0].snapshot;
        expect(afterOther).toEqual(beforeOther);
      } finally { await cleanup(); }
    }, 30000);
    it("rejects ambiguous NEWAVE configs without changing state", async () => {
      await cleanup();
      try {
        const t = (await pool.query("INSERT INTO tenants(name,slug,status,timezone) VALUES('Newave','newave-ia','active','UTC') RETURNING id")).rows[0].id;
        const ids = (await pool.query("INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active) VALUES($1,'a','A','m','{}','[]',true),($1,'b','B','m','{}','[]',true) RETURNING id", [t])).rows.map(r => r.id);
        const before = await pool.query("SELECT id,active_version_id,to_jsonb(agent_configs) AS row FROM agent_configs WHERE tenant_id=$1 ORDER BY id", [t]);
        const beforeVersions = await pool.query("SELECT agent_config_id,id,status FROM agent_config_versions WHERE agent_config_id=ANY($1) ORDER BY id", [ids]);
        await expect(pool.query(await readFile(migrationPath, "utf8"))).rejects.toThrow(/alvo inequívoco|ambig|agent_configs/i);
        expect((await pool.query("SELECT id,active_version_id,to_jsonb(agent_configs) AS row FROM agent_configs WHERE tenant_id=$1 ORDER BY id", [t])).rows).toEqual(before.rows);
        expect((await pool.query("SELECT agent_config_id,id,status FROM agent_config_versions WHERE agent_config_id=ANY($1) ORDER BY id", [ids])).rows).toEqual(beforeVersions.rows);
      } finally { await cleanup(); }
    }, 30000);

    it("holds the tenant lock until migration transaction end and blocks a second config", async () => {
      await cleanup();
      const migrator = await pool.connect();
      try {
        const writer = await pool.connect();
        try {
          const t = (await pool.query("INSERT INTO tenants(name,slug,status,timezone) VALUES('Newave','newave-ia','active','UTC') RETURNING id")).rows[0].id;
          await pool.query("INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active) VALUES($1,'Newave','PROMPT','model','{}','[]',true)", [t]);
          await migrator.query("BEGIN");
          await migrator.query(await readFile(migrationPath, "utf8"));
          await writer.query("BEGIN");
          await writer.query("SET LOCAL lock_timeout = '250ms'");
          let insertErrorCode: string | null = null;
          try {
            await writer.query("INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model,model_params,enabled_tools,is_active) VALUES($1,'Concurrent','PROMPT','model','{}','[]',true)", [t]);
          } catch (error) {
            insertErrorCode = (error as { code?: string }).code ?? null;
          }
          expect(insertErrorCode, "concurrent INSERT completed instead of hitting the tenant lock").toBe("55P03");
        } finally {
          await writer.query("ROLLBACK").catch(() => undefined);
          writer.release();
        }
      } finally {
        await migrator.query("ROLLBACK").catch(() => undefined);
        migrator.release();
        await cleanup();
      }
    }, 30000);
  });
});
