import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../src/db/migration-runner.js";
import { resolveTestDatabaseUrl } from "./test-database.js";
import { loadTestEnvironment } from "./test-environment.js";

loadTestEnvironment();

const databaseUrl = resolveTestDatabaseUrl(process.env);
const directory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await runMigrations(client, directory);
  // Legacy integration fixtures insert tenants directly instead of exercising
  // the ROOT template workflow. Keep that shortcut test-only: newly inserted
  // synthetic tenants inherit the historically available general modules,
  // while production remains fail-closed and template-driven.
  await client.query(`
    CREATE OR REPLACE FUNCTION test_enable_legacy_capabilities()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
      VALUES
        (NEW.id,'dashboard_v1',true),
        (NEW.id,'leads_v1',true),
        (NEW.id,'pipeline_v1',true),
        (NEW.id,'appointments_v1',true),
        (NEW.id,'workspace_admin_v1',true)
      ON CONFLICT(tenant_id,flag_key) DO NOTHING;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_tenants_enable_legacy_capabilities ON tenants;
    CREATE TRIGGER test_tenants_enable_legacy_capabilities
      AFTER INSERT ON tenants
      FOR EACH ROW EXECUTE FUNCTION test_enable_legacy_capabilities();
  `);
  // Since 0184 a new company starts with ONE stage ("Primeiro contato").
  // Legacy commercial fixtures (agendado/fechado/perdido…) predate that and
  // resolve stages by technical_status, so synthetic test tenants get the
  // pre-0184 stage set + transition graph appended to their default pipeline.
  // Opt out per tenant with slug prefix 'clean-' (used by the clean-start
  // tests). Production and fresh-migration databases never run this.
  await client.query(`
    CREATE OR REPLACE FUNCTION test_seed_legacy_pipeline_stages()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE default_pipeline UUID;
    BEGIN
      IF COALESCE(NEW.slug,'') LIKE 'clean-%' THEN RETURN NEW; END IF;
      default_pipeline := tenant_default_pipeline(NEW.id);
      IF default_pipeline IS NULL THEN RETURN NEW; END IF;
      UPDATE pipeline_stages SET name='Novo' WHERE tenant_id=NEW.id AND pipeline_id=default_pipeline AND technical_status='novo';
      INSERT INTO pipeline_stages(tenant_id,pipeline_id,name,color,position,technical_status,is_default)
      VALUES
        (NEW.id,default_pipeline,'Em atendimento','#3B82F6',20,'em_atendimento',true),
        (NEW.id,default_pipeline,'Aguardando resposta','#F59E0B',30,'aguardando_resposta',true),
        (NEW.id,default_pipeline,'Qualificado','#14B8A6',40,'qualificado',true),
        (NEW.id,default_pipeline,'Agendado','#8B5CF6',50,'agendado',true),
        (NEW.id,default_pipeline,'Em negociação','#6366F1',60,'em_negociacao',true),
        (NEW.id,default_pipeline,'Proposta enviada','#0EA5E9',70,'proposta_enviada',true),
        (NEW.id,default_pipeline,'Follow-up','#F97316',80,'follow_up',true),
        (NEW.id,default_pipeline,'Fechado','#10B981',90,'fechado',true),
        (NEW.id,default_pipeline,'Perdido','#EF4444',100,'perdido',true);
      INSERT INTO pipeline_transitions(tenant_id,from_stage_id,to_stage_id)
      SELECT source.tenant_id,source.id,target.id
      FROM pipeline_stages source
      JOIN pipeline_stages target ON target.tenant_id=source.tenant_id AND target.pipeline_id=source.pipeline_id
      WHERE source.tenant_id=NEW.id AND source.pipeline_id=default_pipeline
        AND (
          (source.technical_status='novo' AND target.technical_status=ANY(ARRAY['em_atendimento','perdido'])) OR
          (source.technical_status='em_atendimento' AND target.technical_status=ANY(ARRAY['aguardando_resposta','qualificado','proposta_enviada','follow_up','perdido'])) OR
          (source.technical_status='aguardando_resposta' AND target.technical_status=ANY(ARRAY['em_atendimento','qualificado','proposta_enviada','follow_up','perdido'])) OR
          (source.technical_status='qualificado' AND target.technical_status=ANY(ARRAY['em_atendimento','agendado','em_negociacao','proposta_enviada','follow_up','perdido'])) OR
          (source.technical_status='agendado' AND target.technical_status=ANY(ARRAY['qualificado','em_negociacao','proposta_enviada','follow_up','fechado','perdido'])) OR
          (source.technical_status='em_negociacao' AND target.technical_status=ANY(ARRAY['proposta_enviada','follow_up','fechado','perdido'])) OR
          (source.technical_status='proposta_enviada' AND target.technical_status=ANY(ARRAY['em_negociacao','qualificado','follow_up','fechado','perdido'])) OR
          (source.technical_status='follow_up' AND target.technical_status=ANY(ARRAY['em_atendimento','aguardando_resposta','qualificado','agendado','em_negociacao','proposta_enviada','fechado','perdido'])) OR
          (source.technical_status='perdido' AND target.technical_status=ANY(ARRAY['em_atendimento','follow_up','fechado']))
        )
      ON CONFLICT DO NOTHING;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_tenants_seed_legacy_pipeline_stages ON tenants;
    CREATE TRIGGER test_tenants_seed_legacy_pipeline_stages
      AFTER INSERT ON tenants
      FOR EACH ROW EXECUTE FUNCTION test_seed_legacy_pipeline_stages();
  `);
} finally {
  await client.end();
}
