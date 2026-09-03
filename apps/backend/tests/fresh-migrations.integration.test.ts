import { randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migration-runner.js";
import {
  deploymentSnapshotHash,
  recordDeploymentFeatureFlagSnapshot
} from "../src/modules/operations/deployment-snapshots.js";

describe("migrations on a clean database", () => {
  it("builds the complete schema including immutable agent versions", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_fresh_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source);
    adminUrl.pathname = "/postgres";
    const freshUrl = new URL(source);
    freshUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    let created = false;
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const fresh = new pg.Client({ connectionString: freshUrl.toString() });
      try {
        await fresh.connect();
        const result = await runMigrations(fresh, fileURLToPath(new URL("../src/db/migrations", import.meta.url)), () => undefined);
        expect(result.applied.at(-1)).toBe("0131_cascade_meeting_confirmation_outbox.sql");
        expect((await runMigrations(
          fresh,
          fileURLToPath(new URL("../src/db/migrations", import.meta.url)),
          () => undefined
        )).applied).toEqual([]);
        const flags = await fresh.query<{
          total: number;
          defaults_off: boolean;
          globals_enabled: number;
          kills_off: boolean;
        }>(
          `SELECT count(*)::int total,
                  bool_and(default_enabled=false) defaults_off,
                  count(*) FILTER (WHERE global_enabled=true)::int globals_enabled,
                  bool_and(kill_switch_enabled=false) kills_off
           FROM feature_flag_definitions`
        );
        expect(flags.rows[0]).toEqual({
          total: 20,
          defaults_off: true,
          globals_enabled: 4,
          kills_off: true
        });
        const capabilities = await fresh.query<{
          total: number;
          configurable: boolean;
          dependency_count: number;
          support_table: string | null;
          operation_group_type: string | null;
        }>(
          `SELECT
             count(*)::int total,
             bool_and(tenant_configurable) configurable,
             (SELECT count(*)::int FROM capability_dependencies) dependency_count,
             to_regclass('public.tenant_capability_support')::text support_table,
             (SELECT data_type FROM information_schema.columns
              WHERE table_name='audit_logs' AND column_name='operation_group') operation_group_type
           FROM feature_flag_definitions
           WHERE kind='capability'`
        );
        expect(capabilities.rows[0]).toEqual({
          total: 7,
          configurable: true,
          dependency_count: 2,
          support_table: "tenant_capability_support",
          operation_group_type: "uuid"
        });
        const schema = await fresh.query(
          `SELECT
             (SELECT data_type FROM information_schema.columns WHERE table_name='agent_configs' AND column_name='enabled_tools') enabled_tools_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_leads' AND column_name='qualification_stars') stars_type,
             (SELECT count(*)::int FROM qualification_flows WHERE active) active_legacy_flows,
             to_regclass('public.ai_follow_up_schedules') follow_up_table,
             to_regclass('public.ai_follow_up_media_assets') follow_up_media_table,
             (SELECT data_type FROM information_schema.columns WHERE table_name='tenant_ai_settings' AND column_name='ai_follow_up_delivery') follow_up_delivery_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_appointments' AND column_name='meeting_url') meeting_url_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_appointments' AND column_name='assigned_member_id') appointment_assignee_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_appointments' AND column_name='assigned_at') appointment_assigned_at_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_appointments' AND column_name='observation') appointment_observation_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_appointments' AND column_name='creation_request_hash') creation_request_hash_type,
             (SELECT count(*)::int FROM pg_trigger WHERE tgname='scheduling_appointments_notify_realtime_change' AND NOT tgisinternal) appointment_realtime_trigger_count,
             to_regclass('public.uq_scheduling_leads_tenant_normalized_phone') normalized_phone_index,
             (SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='must_change_password') must_change_password_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_appointments' AND column_name='meeting_provisioning_status') meeting_provisioning_status_type,
             to_regclass('public.scheduling_meeting_provisioning_outbox') meeting_provisioning_outbox_table,
             to_regclass('public.scheduling_meeting_contact_delivery_outbox') meeting_contact_delivery_outbox_table,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_appointment_notifications' AND column_name='reaction_status') appointment_reaction_status_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_google_meet_closers' AND column_name='availability_status') attendant_availability_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_google_meet_closers' AND column_name='availability_changed_at') attendant_availability_changed_at_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_google_meet_closers' AND column_name='calendar_color') attendant_calendar_color_type,
             to_regclass('public.scheduling_google_meet_settings') meet_settings_table,
             to_regclass('public.scheduling_atendon_meet_settings') atendon_meet_settings_table,
             to_regclass('public.meet_rooms') meet_rooms_table,
             to_regclass('public.meet_recordings') meet_recordings_table,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_google_meet_settings' AND column_name='oauth_refresh_token_encrypted') meet_refresh_token_type,
             to_regclass('public.agent_config_versions') agent_versions_table,
             (SELECT data_type FROM information_schema.columns WHERE table_name='messages' AND column_name='agent_config_version_id') message_version_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='messages' AND column_name='tenant_id') message_tenant_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='messages' AND column_name='media_is_sticker') message_sticker_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='conversations' AND column_name='contact_avatar_url') contact_avatar_url_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='conversations' AND column_name='contact_avatar_updated_at') contact_avatar_updated_at_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='conversations' AND column_name='handoff_error_code') handoff_error_code_type,
             to_regclass('public.idx_audit_logs_technical_recovery_once') technical_recovery_index,
             to_regclass('public.attendant_assignment_cursors') attendant_assignment_cursors_table,
             (SELECT data_type FROM information_schema.columns WHERE table_name='attendant_assignment_cursors' AND column_name='last_member_id') assignment_cursor_member_type,
             to_regclass('public.ai_attendance_evaluations') evaluations_table,
             to_regclass('public.ai_evaluation_events') evaluation_events_table,
             to_regclass('public.ai_regression_cases') regression_cases_table,
             to_regclass('public.ai_improvement_proposals') proposals_table,
             to_regclass('public.ai_evaluation_runs') evaluation_runs_table,
             (SELECT data_type FROM information_schema.columns WHERE table_name='conversations' AND column_name='lead_id') conversation_lead_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='scheduling_leads' AND column_name='pipeline_stage_id') lead_pipeline_stage_type,
             to_regclass('public.lead_tags') lead_tags_table,
             to_regclass('public.saved_views') saved_views_table,
             to_regclass('public.pipeline_stages') pipeline_stages_table,
             to_regclass('public.pipeline_transitions') pipeline_transitions_table,
             to_regclass('public.scheduling_attendant_time_blocks') attendant_time_blocks_table,
             to_regclass('public.bulk_operations') bulk_operations_table,
             to_regclass('public.post_sale_clients') post_sale_clients_table,
             to_regclass('public.post_sale_checklist_items') post_sale_checklist_items_table,
             to_regclass('public.post_sale_client_checklist') post_sale_client_checklist_table,
             (SELECT count(*)::int FROM permissions WHERE key IN ('post_sales.use','post_sales.manage')) post_sales_permission_count,
             (SELECT data_type FROM information_schema.columns WHERE table_name='usage_logs' AND column_name='message_id') usage_message_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='usage_logs' AND column_name='request_id') usage_request_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='usage_logs' AND column_name='reasoning_tokens') usage_reasoning_type,
             (SELECT data_type FROM information_schema.columns WHERE table_name='usage_logs' AND column_name='tools_used') usage_tools_type,
             to_regclass('public.idx_usage_message_date') usage_message_index,
             to_regclass('public.idx_usage_request') usage_request_index,
             (SELECT count(*)::int FROM pg_trigger WHERE tgname='conversations_link_lead' AND NOT tgisinternal) conversation_lead_trigger_count,
             (SELECT count(*)::int FROM pg_trigger WHERE tgname='scheduling_leads_enforce_pipeline_stage' AND NOT tgisinternal) lead_stage_trigger_count`
        );
        expect(schema.rows[0]).toEqual({
          enabled_tools_type: "jsonb",
          stars_type: "smallint",
          active_legacy_flows: 0,
          follow_up_table: "ai_follow_up_schedules",
          follow_up_media_table: "ai_follow_up_media_assets",
          follow_up_delivery_type: "jsonb",
          meeting_url_type: "text",
          appointment_assignee_type: "uuid",
          appointment_assigned_at_type: "timestamp with time zone",
          appointment_observation_type: "text",
          creation_request_hash_type: "text",
          appointment_realtime_trigger_count: 1,
          normalized_phone_index: "uq_scheduling_leads_tenant_normalized_phone",
          must_change_password_type: "boolean",
          meeting_provisioning_status_type: "text",
          meeting_provisioning_outbox_table: "scheduling_meeting_provisioning_outbox",
          meeting_contact_delivery_outbox_table: "scheduling_meeting_contact_delivery_outbox",
          appointment_reaction_status_type: "text",
          attendant_availability_type: "text",
          attendant_availability_changed_at_type: "timestamp with time zone",
          attendant_calendar_color_type: "text",
          meet_settings_table: "scheduling_google_meet_settings",
          atendon_meet_settings_table: "scheduling_atendon_meet_settings",
          meet_rooms_table: "meet_rooms",
          meet_recordings_table: "meet_recordings",
          meet_refresh_token_type: "text",
          agent_versions_table: "agent_config_versions",
          message_version_type: "uuid",
          message_tenant_type: "uuid",
          message_sticker_type: "boolean",
          contact_avatar_url_type: "text",
          contact_avatar_updated_at_type: "timestamp with time zone",
          handoff_error_code_type: "text",
          technical_recovery_index: "idx_audit_logs_technical_recovery_once",
          attendant_assignment_cursors_table: "attendant_assignment_cursors",
          assignment_cursor_member_type: "uuid",
          evaluations_table: "ai_attendance_evaluations",
          evaluation_events_table: "ai_evaluation_events",
          regression_cases_table: "ai_regression_cases",
          proposals_table: "ai_improvement_proposals",
          evaluation_runs_table: "ai_evaluation_runs",
          conversation_lead_type: "uuid",
          lead_pipeline_stage_type: "uuid",
          lead_tags_table: "lead_tags",
          saved_views_table: "saved_views",
          pipeline_stages_table: "pipeline_stages",
          pipeline_transitions_table: "pipeline_transitions",
          attendant_time_blocks_table: "scheduling_attendant_time_blocks",
          bulk_operations_table: "bulk_operations",
          post_sale_clients_table: "post_sale_clients",
          post_sale_checklist_items_table: "post_sale_checklist_items",
          post_sale_client_checklist_table: "post_sale_client_checklist",
          post_sales_permission_count: 2,
          usage_message_type: "uuid",
          usage_request_type: "uuid",
          usage_reasoning_type: "integer",
          usage_tools_type: "ARRAY",
          usage_message_index: "idx_usage_message_date",
          usage_request_index: "idx_usage_request",
          conversation_lead_trigger_count: 1,
          lead_stage_trigger_count: 1
        });
        const expectedForeignKeyIndexes = [
          "idx_ai_sticker_sends_conversation_tenant",
          "idx_ai_sticker_sends_sticker_tenant",
          "idx_ai_stickers_source_session_tenant",
          "idx_conversations_assignee_tenant",
          "idx_conversations_session_tenant",
          "idx_handoff_notifications_conversation_tenant",
          "idx_handoff_notifications_session_tenant",
          "idx_qualification_outbox_qualification_tenant",
          "idx_qualification_outbox_session_tenant",
          "idx_scheduling_leads_assignee_tenant",
          "idx_tenant_api_keys_rotation_tenant",
          "idx_usage_logs_conversation_tenant",
          "idx_workspace_invitations_role_workspace",
          "idx_workspace_members_role_workspace",
          "idx_web_push_deliveries_subscription_tenant"
        ];
        const foreignKeyIndexes = await fresh.query<{ indexname: string }>(
          "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname",
          [expectedForeignKeyIndexes]
        );
        expect(new Set(foreignKeyIndexes.rows.map((row) => row.indexname))).toEqual(new Set(expectedForeignKeyIndexes));

        const tenantA = (await fresh.query<{ id: string }>(
          "INSERT INTO tenants(name) VALUES('Tenant integrity A') RETURNING id"
        )).rows[0].id;
        const tenantB = (await fresh.query<{ id: string }>(
          "INSERT INTO tenants(name) VALUES('Tenant integrity B') RETURNING id"
        )).rows[0].id;
        expect((await fresh.query(
          "SELECT 1 FROM scheduling_atendon_meet_settings WHERE tenant_id=ANY($1::uuid[]) AND enabled=true",
          [[tenantA, tenantB]]
        )).rows).toHaveLength(0);
        await fresh.query(
          `INSERT INTO scheduling_units(
             tenant_id,id,name,opening_time,closing_time,operating_days,slot_duration_min,simultaneous_capacity
           ) VALUES($1,'meet-integrity','Meet integrity','00:00','23:59',ARRAY[0,1,2,3,4,5,6]::smallint[],60,1)`,
          [tenantA]
        );
        const tenantAAppointment = (await fresh.query<{ id: string }>(
          `INSERT INTO scheduling_leads(tenant_id,phone,name,status,source)
           VALUES($1,'5511999990001','Meet integrity','novo','test')
           RETURNING id`,
          [tenantA]
        )).rows[0].id;
        const appointmentId = (await fresh.query<{ id: string }>(
          `INSERT INTO scheduling_appointments(lead_id,tenant_id,unit_id,start_at,end_at,status)
           VALUES($1,$2,'meet-integrity',now() + interval '1 day',now() + interval '1 day 1 hour','confirmado')
           RETURNING id`,
          [tenantAAppointment, tenantA]
        )).rows[0].id;
        await expect(fresh.query(
          `INSERT INTO meet_rooms(tenant_id,room_name,public_code,appointment_id)
           VALUES($1,'atendon-0123456789abcdef0123456789abcdef','0123456789abcdef0123456789abcdef',$2)`,
          [tenantB, appointmentId]
        )).rejects.toMatchObject({ code: "23503" });
        await expect(fresh.query(
          `INSERT INTO meet_recordings(tenant_id,room_name,appointment_id,file_path,size_bytes)
           VALUES($1,'atendon-0123456789abcdef0123456789abcdef',$2,'cross-tenant/video.mp4',1)`,
          [tenantB, appointmentId]
        )).rejects.toMatchObject({ code: "23503" });
        const seededPipelines = await fresh.query<{ tenant_id: string; stages: number; defaults: number; statuses: string[] }>(
          `SELECT tenant_id,count(*)::int stages,count(*) FILTER (WHERE is_default)::int defaults,
                  array_agg(DISTINCT technical_status ORDER BY technical_status) statuses
           FROM pipeline_stages WHERE tenant_id=ANY($1::uuid[])
           GROUP BY tenant_id ORDER BY tenant_id`,
          [[tenantA,tenantB]]
        );
        expect(seededPipelines.rows).toHaveLength(2);
        expect(seededPipelines.rows.every((row) => row.stages === 10 && row.defaults === 10)).toBe(true);
        expect(seededPipelines.rows[0].statuses).toEqual([
          "agendado","aguardando_resposta","em_atendimento","em_negociacao","fechado",
          "follow_up","novo","perdido","proposta_enviada","qualificado"
        ]);
        const snapshotPool = new pg.Pool({ connectionString: freshUrl.toString() });
        try {
          const deployVersion = `fresh-${randomUUID()}`;
          const snapshot = await recordDeploymentFeatureFlagSnapshot(snapshotPool, deployVersion);
          expect(snapshot).toMatchObject({
            deployVersion,
            latestMigration: "0131_cascade_meeting_confirmation_outbox.sql",
            created: true
          });
          expect(snapshot.globalFlags.case_organization_v1.enabled).toBe(true);
          expect(snapshot.globalFlags.dashboard_widgets_v1.enabled).toBe(true);
          expect(snapshot.globalFlags.web_push_v1.enabled).toBe(true);
          expect(snapshot.globalFlags.compact_prompt_v2.enabled).toBe(false);
          expect(snapshot.effectiveFlags[tenantA].case_organization_v1).toBe(true);
          expect(snapshot.effectiveFlags[tenantB].case_organization_v1).toBe(true);
          expect(snapshot.snapshotHash).toBe(deploymentSnapshotHash({
            deployVersion,
            latestMigration: snapshot.latestMigration,
            globalFlags: snapshot.globalFlags,
            effectiveFlags: snapshot.effectiveFlags
          }));
          const replay = await recordDeploymentFeatureFlagSnapshot(snapshotPool, deployVersion);
          expect(replay).toMatchObject({
            id: snapshot.id,
            snapshotHash: snapshot.snapshotHash,
            created: false
          });

          await fresh.query(
            "UPDATE feature_flag_definitions SET global_enabled=true WHERE flag_key='compact_prompt_v2'"
          );
          await expect(recordDeploymentFeatureFlagSnapshot(snapshotPool, deployVersion))
            .rejects.toThrow(/já possui snapshot diferente/i);
          await fresh.query(
            "UPDATE feature_flag_definitions SET global_enabled=NULL WHERE flag_key='compact_prompt_v2'"
          );
          await expect(fresh.query(
            "UPDATE deployment_feature_flag_snapshots SET latest_migration='0001_invalid.sql' WHERE id=$1",
            [snapshot.id]
          )).rejects.toThrow(/immutable/i);
          await expect(fresh.query(
            "DELETE FROM deployment_feature_flag_snapshots WHERE id=$1",
            [snapshot.id]
          )).rejects.toThrow(/immutable/i);
        } finally {
          await snapshotPool.end();
        }
        const sessionA = (await fresh.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
          [tenantA]
        )).rows[0].id;
        const sessionB = (await fresh.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
          [tenantB]
        )).rows[0].id;
        const stickerSourceSessionA = (await fresh.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
          [tenantA]
        )).rows[0].id;

        await expect(fresh.query(
          "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511999990001')",
          [tenantB, sessionA]
        )).rejects.toThrow();

        const conversationA = (await fresh.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511999990002') RETURNING id",
          [tenantA, sessionA]
        )).rows[0].id;
        const conversationB = (await fresh.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511999990003') RETURNING id",
          [tenantB, sessionB]
        )).rows[0].id;
        const conversationA2 = (await fresh.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511999990014') RETURNING id",
          [tenantA, sessionA]
        )).rows[0].id;
        const messageA = (await fresh.query<{ id: string; tenant_id: string }>(
          "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','Tenant-owned message') RETURNING id,tenant_id",
          [conversationA]
        )).rows[0];
        const messageB = (await fresh.query<{ id: string }>(
          "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'agent','Tenant B message') RETURNING id",
          [conversationB]
        )).rows[0];
        expect(messageA.tenant_id).toBe(tenantA);
        await expect(fresh.query(
          "INSERT INTO messages(tenant_id,conversation_id,sender,content) VALUES($1,$2,'contact','Forged tenant')",
          [tenantB, conversationA]
        )).rejects.toThrow(/another tenant/i);
        await expect(fresh.query(
          `INSERT INTO messages(conversation_id,sender,content,reply_to_message_id)
           VALUES($1,'human','Same tenant, different conversation',$2)`,
          [conversationA2, messageA.id]
        )).rejects.toMatchObject({ code: "23503" });
        await expect(fresh.query(
          `INSERT INTO messages(conversation_id,sender,content,reply_to_message_id)
           VALUES($1,'human','Cross tenant reply',$2)`,
          [conversationB, messageA.id]
        )).rejects.toMatchObject({ code: "23503" });

        const tenantBConfigId = (await fresh.query<{ id: string }>(
          `INSERT INTO agent_configs(tenant_id,name,system_prompt,ai_model)
           VALUES($1,'Tenant B agent','Tenant B only','test/model') RETURNING id`,
          [tenantB]
        )).rows[0].id;
        const tenantBVersionId = (await fresh.query<{ active_version_id: string }>(
          "SELECT active_version_id FROM agent_configs WHERE id=$1",
          [tenantBConfigId]
        )).rows[0].active_version_id;
        await expect(fresh.query(
          `INSERT INTO messages(conversation_id,sender,content,agent_config_version_id)
           VALUES($1,'agent','Foreign configuration',$2)`,
          [conversationA, tenantBVersionId]
        )).rejects.toThrow(/another tenant/i);
        await expect(fresh.query(
          `INSERT INTO ai_follow_up_schedules(conversation_id,tenant_id,last_agent_message_id)
           VALUES($1,$2,$3)`,
          [conversationA, tenantA, messageB.id]
        )).rejects.toMatchObject({ code: "23503" });
        await expect(fresh.query(
          `INSERT INTO usage_logs(
             tenant_id,conversation_id,message_id,ai_model,input_tokens,output_tokens,cost_usd
           ) VALUES($1,$2,$3,'test/model',1,1,0)`,
          [tenantA, conversationA, messageB.id]
        )).rejects.toMatchObject({ code: "23503" });

        await expect(fresh.query(
          `INSERT INTO usage_logs(tenant_id,conversation_id,ai_model,input_tokens,output_tokens,cost_usd)
           VALUES($1,$2,'test/model',1,1,0)`,
          [tenantB, conversationA]
        )).rejects.toThrow();
        await expect(fresh.query(
          `INSERT INTO handoff_notifications(
             tenant_id,conversation_id,session_id,idempotency_key,attendant_phone,message
           ) VALUES($1,$2,$3,'cross-conversation','5511999990006','test')`,
          [tenantB, conversationA, sessionB]
        )).rejects.toThrow();
        await expect(fresh.query(
          `INSERT INTO handoff_notifications(
             tenant_id,conversation_id,session_id,idempotency_key,attendant_phone,message
           ) VALUES($1,$2,$3,'cross-session','5511999990006','test')`,
          [tenantA, conversationA, sessionB]
        )).rejects.toThrow();

        const userId = (await fresh.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES('tenant-integrity@test.local','active') RETURNING id"
        )).rows[0].id;
        const roleA = (await fresh.query<{ id: string }>(
          "INSERT INTO workspace_roles(workspace_id,name) VALUES($1,'INTEGRITY ROLE') RETURNING id",
          [tenantA]
        )).rows[0].id;
        const suspendedUserId = (await fresh.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES('suspended-assignee@test.local','active') RETURNING id"
        )).rows[0].id;
        const suspendedMemberId = (await fresh.query<{ id: string }>(
          `INSERT INTO workspace_members(workspace_id,user_id,role_id,status)
           VALUES($1,$2,$3,'suspended') RETURNING id`,
          [tenantA, suspendedUserId, roleA]
        )).rows[0].id;
        const disabledUserId = (await fresh.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES('disabled-assignee@test.local','disabled') RETURNING id"
        )).rows[0].id;
        const disabledMemberId = (await fresh.query<{ id: string }>(
          `INSERT INTO workspace_members(workspace_id,user_id,role_id,status)
           VALUES($1,$2,$3,'active') RETURNING id`,
          [tenantA, disabledUserId, roleA]
        )).rows[0].id;
        await expect(fresh.query(
          "UPDATE conversations SET assigned_user_id=$2 WHERE id=$1",
          [conversationA, suspendedUserId]
        )).rejects.toThrow();
        await expect(fresh.query(
          "UPDATE conversations SET assigned_user_id=$2 WHERE id=$1",
          [conversationA, disabledUserId]
        )).rejects.toThrow();
        await expect(fresh.query(
          "INSERT INTO workspace_members(workspace_id,user_id,role_id) VALUES($1,$2,$3)",
          [tenantB, userId, roleA]
        )).rejects.toThrow();
        const memberA = (await fresh.query<{ id: string }>(
          "INSERT INTO workspace_members(workspace_id,user_id,role_id,status) VALUES($1,$2,$3,'active') RETURNING id",
          [tenantA, userId, roleA]
        )).rows[0].id;
        const foreignPushSubscription = (await fresh.query<{ id: string }>(
          `INSERT INTO web_push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth,device_name)
           VALUES($1,$2,'https://push.example/foreign','public-key-material','auth-secret','Foreign')
           RETURNING id`,
          [tenantB, userId]
        )).rows[0].id;
        const tenantAOutbox = (await fresh.query<{ id: string }>(
          `INSERT INTO web_push_outbox(
             tenant_id,user_id,event_type,urgency,target_path,resource_type,dedupe_key
           ) VALUES($1,$2,'other','low','/','test','tenant-integrity') RETURNING id`,
          [tenantA, userId]
        )).rows[0].id;
        await expect(fresh.query(
          `INSERT INTO web_push_deliveries(outbox_id,tenant_id,subscription_id)
           VALUES($1,$2,$3)`,
          [tenantAOutbox, tenantA, foreignPushSubscription]
        )).rejects.toMatchObject({ code: "23503" });

        await fresh.query(
          "UPDATE conversations SET ai_active=false,handoff_reason='manually_paused',assigned_user_id=$2 WHERE id=$1",
          [conversationA, userId]
        );
        await expect(fresh.query(
          "UPDATE conversations SET assigned_user_id=$2 WHERE id=$1",
          [conversationB, userId]
        )).rejects.toThrow();

        for (const tenantId of [tenantA, tenantB]) {
          await fresh.query(
            "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'integrity-category','Integrity category')",
            [tenantId]
          );
          await fresh.query(
            `INSERT INTO scheduling_units(
               tenant_id,id,name,opening_time,closing_time,operating_days
             ) VALUES($1,'integrity-unit','Integrity unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
            [tenantId]
          );
        }
        const leadA = (await fresh.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,source,assigned_member_id
           ) VALUES($1,'5511999990004','integrity-category','integrity-unit','test',$2)
           RETURNING id`,
          [tenantA, memberA]
        )).rows[0].id;
        await expect(fresh.query(
          `INSERT INTO scheduling_appointments(
             tenant_id,lead_id,unit_id,start_at,end_at,status
           ) VALUES($1,$2,'integrity-unit','2035-01-01T09:00:00Z','2035-01-01T09:30:00Z','concluido')`,
          [tenantA,leadA]
        )).rejects.toMatchObject({code:"23514"});
        for (const [phone, inactiveMemberId] of [
          ["5511999990012", suspendedMemberId],
          ["5511999990013", disabledMemberId]
        ]) {
          await expect(fresh.query(
            `INSERT INTO scheduling_leads(
               tenant_id,phone,interest_category_id,unit_id,source,assigned_member_id
             ) VALUES($1,$2,'integrity-category','integrity-unit','test',$3)`,
            [tenantA, phone, inactiveMemberId]
          )).rejects.toThrow();
        }
        await fresh.query(
          `INSERT INTO qualification_flows(tenant_id,id,name,definition)
           VALUES($1,'integrity-flow','Integrity flow','{"version":1,"steps":[]}')`,
          [tenantA]
        );
        const qualificationA = (await fresh.query<{ id: string }>(
          `INSERT INTO lead_qualifications(
             tenant_id,lead_id,flow_id,current_step,total_questions,definition_snapshot
           ) VALUES($1,$2,'integrity-flow','first',1,'{"version":1,"steps":[]}')
           RETURNING id`,
          [tenantA, leadA]
        )).rows[0].id;
        await expect(fresh.query(
          `INSERT INTO qualification_message_outbox(
             tenant_id,qualification_id,session_id,contact_phone,step_id,
             inbound_external_id,message_kind,message
           ) VALUES($1,$2,$3,'5511999990004','first','cross-qualification','question','test')`,
          [tenantB, qualificationA, sessionB]
        )).rejects.toThrow();
        await expect(fresh.query(
          `INSERT INTO qualification_message_outbox(
             tenant_id,qualification_id,session_id,contact_phone,step_id,
             inbound_external_id,message_kind,message
           ) VALUES($1,$2,$3,'5511999990004','first','cross-session','question','test')`,
          [tenantA, qualificationA, sessionB]
        )).rejects.toThrow();
        await expect(fresh.query(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,source,assigned_member_id
           ) VALUES($1,'5511999990005','integrity-category','integrity-unit','test',$2)`,
          [tenantB, memberA]
        )).rejects.toThrow();

        await fresh.query("DELETE FROM workspace_members WHERE id=$1", [memberA]);
        expect((await fresh.query(
          "SELECT assigned_user_id,handoff_reason FROM conversations WHERE id=$1",
          [conversationA]
        )).rows[0]).toEqual({ assigned_user_id: null, handoff_reason: "ai_decided" });
        expect((await fresh.query(
          "SELECT assigned_member_id FROM scheduling_leads WHERE id=$1",
          [leadA]
        )).rows[0].assigned_member_id).toBeNull();

        await expect(fresh.query(
          `INSERT INTO ai_stickers(
             tenant_id,name,description,file_name,size_bytes,content_hash,media_data,source,source_session_id
           ) VALUES($1,'Cross tenant','test','cross.webp',12,'cross-tenant',decode('00','hex'),'whatsapp_sent',$2)`,
          [tenantB, sessionA]
        )).rejects.toThrow();

        const stickerA = (await fresh.query<{ id: string }>(
          `INSERT INTO ai_stickers(
             tenant_id,name,description,file_name,size_bytes,content_hash,media_data,source,source_session_id
           ) VALUES($1,'Valid sticker','test','valid.webp',12,'valid-sticker',decode('00','hex'),'whatsapp_sent',$2)
           RETURNING id`,
          [tenantA, stickerSourceSessionA]
        )).rows[0].id;
        await expect(fresh.query(
          "UPDATE whatsapp_sessions SET tenant_id=$2 WHERE id=$1",
          [stickerSourceSessionA, tenantB]
        )).rejects.toThrow();
        await expect(fresh.query(
          `INSERT INTO ai_sticker_sends(tenant_id,conversation_id,sticker_id,external_message_id)
           VALUES($1,$2,$3,'cross-tenant-send')`,
          [tenantB, conversationB, stickerA]
        )).rejects.toThrow();

        const keyA = (await fresh.query<{ id: string }>(
          "INSERT INTO tenant_api_keys(tenant_id,key_hash) VALUES($1,'integrity-key-a') RETURNING id",
          [tenantA]
        )).rows[0].id;
        await expect(fresh.query(
          "INSERT INTO tenant_api_keys(tenant_id,key_hash,rotated_from_id) VALUES($1,'integrity-key-b',$2)",
          [tenantB, keyA]
        )).rejects.toThrow();
        await fresh.query(
          "INSERT INTO tenant_api_keys(tenant_id,key_hash,rotated_from_id) VALUES($1,'integrity-key-child',$2)",
          [tenantA, keyA]
        );
        await expect(fresh.query(
          "UPDATE tenant_api_keys SET tenant_id=$2 WHERE id=$1",
          [keyA, tenantB]
        )).rejects.toThrow();
      } finally {
        await fresh.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
    }
  }, 30_000);

  it("refuses to conceal legacy cross-conversation replies or cross-tenant Push deliveries", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_tenant_integrity_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source);
    adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source);
    upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-tenant-integrity-migration-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      await Promise.all(files.filter((file) => file < "0123_").map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenantA = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('Integrity upgrade A','active') RETURNING id"
        )).rows[0].id;
        const tenantB = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('Integrity upgrade B','active') RETURNING id"
        )).rows[0].id;
        const sessionA = (await upgrade.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
          [tenantA]
        )).rows[0].id;
        const sessionB = (await upgrade.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
          [tenantB]
        )).rows[0].id;
        const conversationA = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511888880001') RETURNING id",
          [tenantA, sessionA]
        )).rows[0].id;
        const conversationB = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,session_id,contact_phone) VALUES($1,$2,'5511888880002') RETURNING id",
          [tenantB, sessionB]
        )).rows[0].id;
        const messageA = (await upgrade.query<{ id: string }>(
          "INSERT INTO messages(conversation_id,sender,content) VALUES($1,'contact','A') RETURNING id",
          [conversationA]
        )).rows[0].id;
        const messageB = (await upgrade.query<{ id: string }>(
          `INSERT INTO messages(conversation_id,sender,content,reply_to_message_id)
           VALUES($1,'human','B',$2) RETURNING id`,
          [conversationB, messageA]
        )).rows[0].id;
        await upgrade.query(
          `INSERT INTO ai_follow_up_schedules(conversation_id,tenant_id,last_agent_message_id)
           VALUES($1,$2,$3)`,
          [conversationA, tenantA, messageB]
        );
        const foreignUsageId = (await upgrade.query<{ id: string }>(
          `INSERT INTO usage_logs(
             tenant_id,conversation_id,message_id,ai_model,input_tokens,output_tokens,cost_usd
           ) VALUES($1,$2,$3,'test/model',1,1,0) RETURNING id`,
          [tenantA, conversationA, messageB]
        )).rows[0].id;
        const userId = (await upgrade.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES($1,'active') RETURNING id",
          [`integrity-upgrade-${randomUUID()}@test.local`]
        )).rows[0].id;
        const foreignSubscription = (await upgrade.query<{ id: string }>(
          `INSERT INTO web_push_subscriptions(tenant_id,user_id,endpoint,p256dh,auth,device_name)
           VALUES($1,$2,'https://push.example/legacy-foreign','public-key-material','auth-secret','Legacy')
           RETURNING id`,
          [tenantB, userId]
        )).rows[0].id;
        const outbox = (await upgrade.query<{ id: string }>(
          `INSERT INTO web_push_outbox(
             tenant_id,user_id,event_type,urgency,target_path,resource_type,dedupe_key
           ) VALUES($1,$2,'other','low','/','test','legacy-cross-tenant') RETURNING id`,
          [tenantA, userId]
        )).rows[0].id;
        await upgrade.query(
          "INSERT INTO web_push_deliveries(outbox_id,tenant_id,subscription_id) VALUES($1,$2,$3)",
          [outbox, tenantA, foreignSubscription]
        );
        await copyFile(
          join(migrationDirectory, "0123_tenant_owned_messages_and_web_push.sql"),
          join(stagedDirectory, "0123_tenant_owned_messages_and_web_push.sql")
        );

        await expect(runMigrations(upgrade, stagedDirectory, () => undefined))
          .rejects.toThrow(/reply target belongs to another conversation/i);
        expect((await upgrade.query(
          "SELECT count(*)::int count FROM schema_migrations WHERE filename='0123_tenant_owned_messages_and_web_push.sql'"
        )).rows[0].count).toBe(0);

        await upgrade.query("UPDATE messages SET reply_to_message_id=NULL WHERE id=$1", [messageB]);
        await expect(runMigrations(upgrade, stagedDirectory, () => undefined))
          .rejects.toThrow(/delivery references another tenant subscription/i);
        expect((await upgrade.query(
          "SELECT count(*)::int count FROM schema_migrations WHERE filename='0123_tenant_owned_messages_and_web_push.sql'"
        )).rows[0].count).toBe(0);

        await upgrade.query(
          "DELETE FROM web_push_deliveries WHERE outbox_id=$1 AND subscription_id=$2",
          [outbox, foreignSubscription]
        );
        await expect(runMigrations(upgrade, stagedDirectory, () => undefined))
          .rejects.toThrow(/follow-up message ownership/i);
        expect((await upgrade.query(
          "SELECT count(*)::int count FROM schema_migrations WHERE filename='0123_tenant_owned_messages_and_web_push.sql'"
        )).rows[0].count).toBe(0);

        await upgrade.query(
          "DELETE FROM ai_follow_up_schedules WHERE conversation_id=$1",
          [conversationA]
        );
        await expect(runMigrations(upgrade, stagedDirectory, () => undefined))
          .rejects.toThrow(/usage message ownership/i);
        expect((await upgrade.query(
          "SELECT count(*)::int count FROM schema_migrations WHERE filename='0123_tenant_owned_messages_and_web_push.sql'"
        )).rows[0].count).toBe(0);

        await upgrade.query("UPDATE usage_logs SET message_id=NULL WHERE id=$1", [foreignUsageId]);
        await expect(runMigrations(upgrade, stagedDirectory, () => undefined)).resolves.toMatchObject({
          applied: ["0123_tenant_owned_messages_and_web_push.sql"]
        });
        expect((await upgrade.query<{ tenant_id: string }>(
          "SELECT tenant_id FROM messages WHERE id=$1",
          [messageA]
        )).rows[0].tenant_id).toBe(tenantA);
      } finally {
        await upgrade.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("preserves legacy leads without digits while enforcing uniqueness for normalized phones", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_phone_integrity_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source); upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-phone-integrity-migration-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      const beforeFiles = files.filter((file) => file < "0093_");
      await Promise.all(beforeFiles.map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenantId = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('Phone integrity upgrade','active') RETURNING id"
        )).rows[0].id;
        const legacyLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(tenant_id,phone,name,source)
           VALUES($1,'sem telefone','Legacy appointment','agenda_manual') RETURNING id`,
          [tenantId]
        )).rows[0].id;

        await copyFile(
          join(migrationDirectory, "0093_review_data_integrity.sql"),
          join(stagedDirectory, "0093_review_data_integrity.sql")
        );
        expect((await runMigrations(upgrade, stagedDirectory, () => undefined)).applied)
          .toEqual(["0093_review_data_integrity.sql"]);
        expect((await upgrade.query(
          "SELECT phone FROM scheduling_leads WHERE id=$1",
          [legacyLeadId]
        )).rows[0].phone).toBe("sem telefone");

        await upgrade.query(
          "INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,'(11) 99999-0000','test')",
          [tenantId]
        );
        await expect(upgrade.query(
          "INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,'11999990000','test')",
          [tenantId]
        )).rejects.toThrow(/uq_scheduling_leads_tenant_normalized_phone/);
      } finally {
        await upgrade.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("upgrades legacy cases with deterministic normalized-phone assignment and a matching cursor", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_round_robin_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source); upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-round-robin-migration-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      const beforeFiles = files.filter((file) => file < "0088_");
      const afterFiles = files.filter((file) => file >= "0088_");
      await Promise.all(beforeFiles.map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenantId = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('Round robin upgrade','active') RETURNING id"
        )).rows[0].id;
        const roleId = (await upgrade.query<{ id: string }>(
          `INSERT INTO workspace_roles(workspace_id,name,description)
           VALUES($1,'ROUND ROBIN OPERATOR','Round robin migration fixture') RETURNING id`,
          [tenantId]
        )).rows[0].id;
        await upgrade.query(
          `INSERT INTO workspace_role_permissions(role_id,permission_key)
           SELECT $1,key FROM permissions
           WHERE key IN ('leads.read','conversations.read','conversations.reply')`,
          [roleId]
        );
        const betoUserId = (await upgrade.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES('beto-round-robin-upgrade@test.local','active') RETURNING id"
        )).rows[0].id;
        const juliaUserId = (await upgrade.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES('julia-round-robin-upgrade@test.local','active') RETURNING id"
        )).rows[0].id;
        const betoMemberId = (await upgrade.query<{ id: string }>(
          `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
           VALUES($1,$2,$3,'active',now()) RETURNING id`,
          [tenantId, betoUserId, roleId]
        )).rows[0].id;
        const juliaMemberId = (await upgrade.query<{ id: string }>(
          `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
           VALUES($1,$2,$3,'active',now()) RETURNING id`,
          [tenantId, juliaUserId, roleId]
        )).rows[0].id;
        const ineligibleRoleId = (await upgrade.query<{ id: string }>(
          `INSERT INTO workspace_roles(workspace_id,name,description)
           VALUES($1,'INELIGIBLE ASSIGNEE','No case permissions') RETURNING id`,
          [tenantId]
        )).rows[0].id;
        const ineligibleUserId = (await upgrade.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES('ineligible-round-robin-upgrade@test.local','active') RETURNING id"
        )).rows[0].id;
        const ineligibleMemberId = (await upgrade.query<{ id: string }>(
          `INSERT INTO workspace_members(workspace_id,user_id,role_id,status,joined_at)
           VALUES($1,$2,$3,'active',now()) RETURNING id`,
          [tenantId, ineligibleUserId, ineligibleRoleId]
        )).rows[0].id;
        await upgrade.query(
          `INSERT INTO scheduling_google_meet_closers(
             tenant_id,member_id,created_at,availability_status
           ) VALUES
             ($1,$2,'2026-01-01T00:00:00Z','available'),
             ($1,$3,'2026-01-02T00:00:00Z','unavailable'),
             ($1,$4,'2026-01-03T00:00:00Z','available')`,
          [tenantId, betoMemberId, juliaMemberId, ineligibleMemberId]
        );
        await upgrade.query(
          "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'upgrade-assignment','Upgrade assignment')",
          [tenantId]
        );
        await upgrade.query(
          `INSERT INTO scheduling_units(
             tenant_id,id,name,opening_time,closing_time,operating_days
           ) VALUES($1,'upgrade-assignment','Upgrade assignment','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
          [tenantId]
        );

        const conversationOwnedLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source
           ) VALUES($1,'551100000001','upgrade-assignment','upgrade-assignment','em_qualificacao','upgrade')
           RETURNING id`,
          [tenantId]
        )).rows[0].id;
        await upgrade.query(
          `INSERT INTO conversations(
             tenant_id,contact_phone,status,assigned_user_id,claimed_at
           ) VALUES($1,'+55 (11) 0000-0001','open',$2,now())`,
          [tenantId, betoUserId]
        );

        const leadOwnedLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source,assigned_member_id
           ) VALUES($1,'551100000002','upgrade-assignment','upgrade-assignment','em_qualificacao','upgrade',$2)
           RETURNING id`,
          [tenantId, juliaMemberId]
        )).rows[0].id;
        const leadOwnedConversationId = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,contact_phone,status) VALUES($1,'551100000002','open') RETURNING id",
          [tenantId]
        )).rows[0].id;

        const firstRotatedLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source
           ) VALUES($1,'551100000003','upgrade-assignment','upgrade-assignment','em_qualificacao','upgrade')
           RETURNING id`,
          [tenantId]
        )).rows[0].id;
        const firstRotatedConversationId = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,contact_phone,status) VALUES($1,'551100000003','open') RETURNING id",
          [tenantId]
        )).rows[0].id;
        const activeAppointmentId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_appointments(
             lead_id,tenant_id,unit_id,start_at,end_at,status
           ) VALUES(
             $1,$2,'upgrade-assignment','2035-06-01T10:00:00Z','2035-06-01T10:30:00Z','confirmado'
           ) RETURNING id`,
          [firstRotatedLeadId, tenantId]
        )).rows[0].id;
        const completedAppointmentId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_appointments(
             lead_id,tenant_id,unit_id,start_at,end_at,status
           ) VALUES(
             $1,$2,'upgrade-assignment','2035-06-01T11:00:00Z','2035-06-01T11:30:00Z','concluido'
           ) RETURNING id`,
          [firstRotatedLeadId, tenantId]
        )).rows[0].id;

        const activeLeadWithClosedConversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source
           ) VALUES($1,'551100000004','upgrade-assignment','upgrade-assignment','aprovado','upgrade')
           RETURNING id`,
          [tenantId]
        )).rows[0].id;
        const closedConversationForActiveLeadId = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,contact_phone,status) VALUES($1,'551100000004','closed') RETURNING id",
          [tenantId]
        )).rows[0].id;

        await upgrade.query(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source
           ) VALUES($1,'551100000005','upgrade-assignment','upgrade-assignment','em_qualificacao','upgrade')`,
          [tenantId]
        );
        const conversationOnlyId = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,contact_phone,status) VALUES($1,'551100000005','open') RETURNING id",
          [tenantId]
        )).rows[0].id;

        const historicalLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source
           ) VALUES($1,'551100000006','upgrade-assignment','upgrade-assignment','cancelado','upgrade')
           RETURNING id`,
          [tenantId]
        )).rows[0].id;
        const historicalConversationId = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,contact_phone,status) VALUES($1,'551100000006','closed') RETURNING id",
          [tenantId]
        )).rows[0].id;

        const ineligibleLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source
           ) VALUES($1,'551100000007','upgrade-assignment','upgrade-assignment','em_qualificacao','upgrade')
           RETURNING id`,
          [tenantId]
        )).rows[0].id;
        const ineligibleConversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO conversations(tenant_id,contact_phone,status,assigned_user_id,claimed_at)
           VALUES($1,'551100000007','open',$2,now()) RETURNING id`,
          [tenantId, ineligibleUserId]
        )).rows[0].id;

        const conflictingLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source,assigned_member_id
           ) VALUES(
             $1,'551100000008','upgrade-assignment','upgrade-assignment','em_qualificacao','upgrade',$2
           ) RETURNING id`,
          [tenantId, betoMemberId]
        )).rows[0].id;
        const conflictingConversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO conversations(tenant_id,contact_phone,status,assigned_user_id,claimed_at)
           VALUES($1,'551100000008','open',$2,now()) RETURNING id`,
          [tenantId, juliaUserId]
        )).rows[0].id;

        const finalLeadWithOpenConversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source
           ) VALUES($1,'551100000009','upgrade-assignment','upgrade-assignment','recusado','upgrade')
           RETURNING id`,
          [tenantId]
        )).rows[0].id;
        const openConversationForFinalLeadId = (await upgrade.query<{ id: string }>(
          "INSERT INTO conversations(tenant_id,contact_phone,status) VALUES($1,'551100000009','open') RETURNING id",
          [tenantId]
        )).rows[0].id;

        const noPermissionConflictLeadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,status,source,assigned_member_id
           ) VALUES(
             $1,'551100000010','upgrade-assignment','upgrade-assignment','em_qualificacao','upgrade',$2
           ) RETURNING id`,
          [tenantId, betoMemberId]
        )).rows[0].id;
        const noPermissionConflictConversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO conversations(tenant_id,contact_phone,status,assigned_user_id,claimed_at)
           VALUES($1,'551100000010','open',$2,now()) RETURNING id`,
          [tenantId, ineligibleUserId]
        )).rows[0].id;

        await Promise.all(afterFiles.map((file) => copyFile(
          join(migrationDirectory, file), join(stagedDirectory, file)
        )));
        const migrationResult = await runMigrations(upgrade, stagedDirectory, () => undefined);
        expect(migrationResult.applied).toContain("0088_attendant_case_round_robin.sql");

        expect((await upgrade.query(
          `SELECT
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$1) conversation_owned_lead,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$2) lead_owned_lead,
             (SELECT assigned_user_id FROM conversations WHERE id=$3) lead_owned_conversation,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$4) first_rotated_lead,
             (SELECT assigned_user_id FROM conversations WHERE id=$5) first_rotated_conversation,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$6) active_lead_with_closed_conversation,
             (SELECT assigned_user_id FROM conversations WHERE id=$7) closed_conversation_for_active_lead,
             (SELECT assigned_user_id FROM conversations WHERE id=$8) conversation_only,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$9) historical_lead,
             (SELECT assigned_user_id FROM conversations WHERE id=$10) historical_conversation,
             (SELECT assigned_member_id FROM scheduling_appointments WHERE id=$11) active_appointment,
             (SELECT assigned_member_id FROM scheduling_appointments WHERE id=$12) completed_appointment,
             (SELECT commercial_outcome FROM scheduling_appointments WHERE id=$12) completed_appointment_outcome,
             (SELECT outcome_next_action FROM scheduling_appointments WHERE id=$12) completed_appointment_next_action,
             (SELECT outcome_metadata->>'legacy_result_unknown' FROM scheduling_appointments WHERE id=$12) completed_appointment_legacy_result,
             (SELECT finalized_at IS NOT NULL FROM scheduling_appointments WHERE id=$12) completed_appointment_finalized,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$13) ineligible_lead,
             (SELECT assigned_user_id FROM conversations WHERE id=$14) ineligible_conversation,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$15) conflicting_lead,
             (SELECT assigned_user_id FROM conversations WHERE id=$16) conflicting_conversation,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$17) final_lead_with_open_conversation,
             (SELECT assigned_user_id FROM conversations WHERE id=$18) open_conversation_for_final_lead,
             (SELECT assigned_member_id FROM scheduling_leads WHERE id=$19) no_permission_conflict_lead,
             (SELECT assigned_user_id FROM conversations WHERE id=$20) no_permission_conflict_conversation,
             (SELECT last_member_id FROM attendant_assignment_cursors WHERE tenant_id=$21) cursor`,
          [
            conversationOwnedLeadId,
            leadOwnedLeadId,
            leadOwnedConversationId,
            firstRotatedLeadId,
            firstRotatedConversationId,
            activeLeadWithClosedConversationId,
            closedConversationForActiveLeadId,
            conversationOnlyId,
            historicalLeadId,
            historicalConversationId,
            activeAppointmentId,
            completedAppointmentId,
            ineligibleLeadId,
            ineligibleConversationId,
            conflictingLeadId,
            conflictingConversationId,
            finalLeadWithOpenConversationId,
            openConversationForFinalLeadId,
            noPermissionConflictLeadId,
            noPermissionConflictConversationId,
            tenantId
          ]
        )).rows[0]).toEqual({
          conversation_owned_lead: betoMemberId,
          lead_owned_lead: juliaMemberId,
          lead_owned_conversation: juliaUserId,
          first_rotated_lead: betoMemberId,
          first_rotated_conversation: betoUserId,
          active_lead_with_closed_conversation: juliaMemberId,
          closed_conversation_for_active_lead: null,
          conversation_only: betoUserId,
          historical_lead: null,
          historical_conversation: null,
          active_appointment: betoMemberId,
          completed_appointment: null,
          completed_appointment_outcome: null,
          completed_appointment_next_action: null,
          completed_appointment_legacy_result: "true",
          completed_appointment_finalized: true,
          ineligible_lead: juliaMemberId,
          ineligible_conversation: juliaUserId,
          conflicting_lead: juliaMemberId,
          conflicting_conversation: juliaUserId,
          final_lead_with_open_conversation: null,
          open_conversation_for_final_lead: betoUserId,
          no_permission_conflict_lead: betoMemberId,
          no_permission_conflict_conversation: betoUserId,
          cursor: betoMemberId
        });
      } finally {
        await upgrade.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("backfills inactive assignees and keeps future user deactivation safe", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_assignment_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source); upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-assignment-migration-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      const beforeFiles = files.filter((file) => file < "0065_");
      const afterFiles = files.filter((file) => file >= "0065_");
      await Promise.all(beforeFiles.map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenantId = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('Assignment upgrade','active') RETURNING id"
        )).rows[0].id;
        const otherTenantId = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('Assignment upgrade other','active') RETURNING id"
        )).rows[0].id;
        const sessionId = (await upgrade.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
          [tenantId]
        )).rows[0].id;
        const movedStickerSessionId = (await upgrade.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id",
          [tenantId]
        )).rows[0].id;
        const movedStickerId = (await upgrade.query<{ id: string }>(
          `INSERT INTO ai_stickers(
             tenant_id,name,file_name,size_bytes,content_hash,media_data,source,source_session_id
           ) VALUES($1,'Moved source','moved.webp',12,'moved-source',decode('00','hex'),'whatsapp_sent',$2)
           RETURNING id`,
          [tenantId, movedStickerSessionId]
        )).rows[0].id;
        await upgrade.query("UPDATE whatsapp_sessions SET tenant_id=$2 WHERE id=$1", [movedStickerSessionId, otherTenantId]);
        const movedKeyId = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenant_api_keys(tenant_id,key_hash) VALUES($1,'moved-parent-key') RETURNING id",
          [tenantId]
        )).rows[0].id;
        const rotatedKeyId = (await upgrade.query<{ id: string }>(
          `INSERT INTO tenant_api_keys(tenant_id,key_hash,rotated_from_id)
           VALUES($1,'moved-child-key',$2) RETURNING id`,
          [tenantId, movedKeyId]
        )).rows[0].id;
        await upgrade.query("UPDATE tenant_api_keys SET tenant_id=$2 WHERE id=$1", [movedKeyId, otherTenantId]);
        const userId = (await upgrade.query<{ id: string }>(
          "INSERT INTO users(email,status) VALUES('inactive-assignee@test.local','active') RETURNING id"
        )).rows[0].id;
        const roleId = (await upgrade.query<{ id: string }>(
          "INSERT INTO workspace_roles(workspace_id,name) VALUES($1,'INACTIVE ASSIGNEE') RETURNING id",
          [tenantId]
        )).rows[0].id;
        const memberId = (await upgrade.query<{ id: string }>(
          `INSERT INTO workspace_members(workspace_id,user_id,role_id,status)
           VALUES($1,$2,$3,'suspended') RETURNING id`,
          [tenantId, userId, roleId]
        )).rows[0].id;
        await upgrade.query(
          "INSERT INTO scheduling_google_meet_closers(tenant_id,member_id) VALUES($1,$2)",
          [tenantId, memberId]
        );
        const conversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO conversations(
             tenant_id,session_id,contact_phone,ai_active,handoff_reason,assigned_user_id,claimed_at
           ) VALUES($1,$2,'5511999990010',false,'manually_paused',$3,now()) RETURNING id`,
          [tenantId, sessionId, userId]
        )).rows[0].id;
        await upgrade.query(
          "INSERT INTO scheduling_categories(tenant_id,id,name) VALUES($1,'upgrade-category','Upgrade category')",
          [tenantId]
        );
        await upgrade.query(
          `INSERT INTO scheduling_units(
             tenant_id,id,name,opening_time,closing_time,operating_days
           ) VALUES($1,'upgrade-unit','Upgrade unit','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
          [tenantId]
        );
        const leadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(
             tenant_id,phone,interest_category_id,unit_id,source,assigned_member_id
           ) VALUES($1,'5511999990011','upgrade-category','upgrade-unit','test',$2) RETURNING id`,
          [tenantId, memberId]
        )).rows[0].id;

        await Promise.all(afterFiles.map((file) => copyFile(
          join(migrationDirectory, file), join(stagedDirectory, file)
        )));
        await runMigrations(upgrade, stagedDirectory, () => undefined);

        const backfilledLead = (await upgrade.query<{
          id: string;
          status: string;
          qualification_stars: number | null;
        }>(
          `SELECT id,status,qualification_stars
           FROM scheduling_leads
           WHERE tenant_id=$1 AND phone='5511999990010'`,
          [tenantId]
        )).rows[0];
        expect(backfilledLead).toMatchObject({
          status: "em_atendimento",
          qualification_stars: null
        });
        expect((await upgrade.query(
          `SELECT event_type,details
           FROM scheduling_lead_events
           WHERE tenant_id=$1 AND lead_id=$2`,
          [tenantId, backfilledLead.id]
        )).rows).toEqual([{
          event_type: "lead_criado",
          details: { origem_automatica: "conversa_existente" }
        }]);
        expect((await upgrade.query(
          "SELECT source_session_id FROM ai_stickers WHERE id=$1",
          [movedStickerId]
        )).rows[0].source_session_id).toBeNull();
        expect((await upgrade.query(
          "SELECT rotated_from_id FROM tenant_api_keys WHERE id=$1",
          [rotatedKeyId]
        )).rows[0].rotated_from_id).toBeNull();
        expect((await upgrade.query(
          "SELECT assigned_user_id,claimed_at,handoff_reason FROM conversations WHERE id=$1",
          [conversationId]
        )).rows[0]).toEqual({ assigned_user_id: null, claimed_at: null, handoff_reason: "ai_decided" });
        expect((await upgrade.query(
          "SELECT assigned_member_id FROM scheduling_leads WHERE id=$1",
          [leadId]
        )).rows[0].assigned_member_id).toBeNull();
        expect((await upgrade.query(
          `SELECT availability_status,availability_changed_at IS NOT NULL changed_at_set
           FROM scheduling_google_meet_closers WHERE tenant_id=$1 AND member_id=$2`,
          [tenantId, memberId]
        )).rows[0]).toEqual({ availability_status: "available", changed_at_set: true });

        await upgrade.query("UPDATE workspace_members SET status='active' WHERE id=$1", [memberId]);
        await upgrade.query("UPDATE conversations SET assigned_user_id=$2,claimed_at=now() WHERE id=$1", [conversationId, userId]);
        await upgrade.query("UPDATE scheduling_leads SET assigned_member_id=$2 WHERE id=$1", [leadId, memberId]);
        await upgrade.query("UPDATE users SET status='disabled' WHERE id=$1", [userId]);
        expect((await upgrade.query(
          "SELECT assigned_user_id FROM conversations WHERE id=$1",
          [conversationId]
        )).rows[0].assigned_user_id).toBeNull();
        expect((await upgrade.query(
          "SELECT assigned_member_id FROM scheduling_leads WHERE id=$1",
          [leadId]
        )).rows[0].assigned_member_id).toBeNull();
      } finally {
        await upgrade.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("backfills version 1 for an agent that existed before the versioning migration", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source); upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-migrations-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      const beforeFiles = files.filter((file) => file < "0049_");
      const afterFiles = files.filter((file) => file >= "0049_");
      await Promise.all(beforeFiles.map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenantId = (await upgrade.query<{id:string}>(
          "INSERT INTO tenants(name,status) VALUES('Tenant legado','active') RETURNING id"
        )).rows[0].id;
        const agentId = (await upgrade.query<{id:string}>(
          `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model,model_params,enabled_tools)
           VALUES($1,'Prompt legado','model/legacy','{"temperature":0.7}','["registrar_lead"]') RETURNING id`,
          [tenantId]
        )).rows[0].id;

        await Promise.all(afterFiles.map((file) => copyFile(
          join(migrationDirectory, file), join(stagedDirectory, file)
        )));
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const backfill = await upgrade.query(
          `SELECT a.active_version_id,v.version_number,v.source,v.status,v.system_prompt,
             v.ai_model,v.model_params,v.enabled_tools
           FROM agent_configs a JOIN agent_config_versions v ON v.id=a.active_version_id
           WHERE a.id=$1`,
          [agentId]
        );
        expect(backfill.rows).toEqual([expect.objectContaining({
          version_number: 1,
          source: "bootstrap",
          status: "active",
          system_prompt: "Prompt legado",
          ai_model: "model/legacy",
          model_params: { temperature: 0.7 },
          enabled_tools: ["registrar_lead"]
        })]);
      } finally { await upgrade.end(); }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it("upgrades canonical phones, WhatsApp JIDs and pending meeting deliveries", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_e164_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source); upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-e164-upgrade-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      await Promise.all(files.filter((file) => file < "0097_").map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenantId = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('E164 upgrade','active') RETURNING id"
        )).rows[0].id;
        const sessionId = (await upgrade.query<{ id: string }>(
          "INSERT INTO whatsapp_sessions(tenant_id) VALUES($1) RETURNING id", [tenantId]
        )).rows[0].id;
        await upgrade.query(
          `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days)
           VALUES($1,'e164-unit','E164','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
          [tenantId]
        );
        const leadId = (await upgrade.query<{ id: string }>(
          "INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,'43 23412-3431','test') RETURNING id",
          [tenantId]
        )).rows[0].id;
        const conversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_jid)
           VALUES($1,$2,'(43) 23412-3431','043234123431@s.whatsapp.net') RETURNING id`,
          [tenantId, sessionId]
        )).rows[0].id;
        const lidConversationId = (await upgrade.query<{ id: string }>(
          `INSERT INTO conversations(tenant_id,session_id,contact_phone,contact_jid)
           VALUES($1,$2,'+14155552671','opaque-contact@lid') RETURNING id`,
          [tenantId, sessionId]
        )).rows[0].id;
        const appointmentId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
           VALUES($1,$2,'e164-unit','2032-01-05T10:00:00Z','2032-01-05T10:30:00Z') RETURNING id`,
          [tenantId, leadId]
        )).rows[0].id;
        const deliveryId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_meeting_contact_delivery_outbox(
             tenant_id,appointment_id,conversation_id,session_id,contact_phone,contact_jid,meet_url,message_text
           ) VALUES($1,$2,$3,$4,'043234123431','043234123431@s.whatsapp.net','https://meet.google.com/abc-defg-hij','Link')
           RETURNING id`,
          [tenantId, appointmentId, conversationId, sessionId]
        )).rows[0].id;

        await copyFile(join(migrationDirectory, "0097_phone_e164.sql"), join(stagedDirectory, "0097_phone_e164.sql"));
        expect((await runMigrations(upgrade, stagedDirectory, () => undefined)).applied).toEqual(["0097_phone_e164.sql"]);
        expect((await upgrade.query("SELECT phone FROM scheduling_leads WHERE id=$1", [leadId])).rows[0].phone)
          .toBe("5543234123431");
        expect((await upgrade.query(
          "SELECT contact_phone,contact_jid FROM conversations WHERE id=$1", [conversationId]
        )).rows[0]).toEqual({ contact_phone: "5543234123431", contact_jid: "5543234123431@s.whatsapp.net" });
        expect((await upgrade.query("SELECT contact_jid FROM conversations WHERE id=$1", [lidConversationId])).rows[0].contact_jid)
          .toBe("opaque-contact@lid");
        expect((await upgrade.query(
          "SELECT contact_phone,contact_jid FROM scheduling_meeting_contact_delivery_outbox WHERE id=$1", [deliveryId]
        )).rows[0]).toEqual({ contact_phone: "5543234123431", contact_jid: "5543234123431@s.whatsapp.net" });
      } finally {
        await upgrade.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("rolls back the E164 migration for invalid values and canonical collisions", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_e164_rollback_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source); upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-e164-rollback-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      await Promise.all(files.filter((file) => file < "0097_").map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenantId = (await upgrade.query<{ id: string }>(
          "INSERT INTO tenants(name,status) VALUES('E164 rollback','active') RETURNING id"
        )).rows[0].id;
        const invalidId = (await upgrade.query<{ id: string }>(
          "INSERT INTO scheduling_leads(tenant_id,phone,source) VALUES($1,'12345','test') RETURNING id", [tenantId]
        )).rows[0].id;
        await upgrade.query(
          `INSERT INTO scheduling_leads(tenant_id,phone,source)
           VALUES($1,'(43) 23412-3431','test'),($1,'5543234123431','test')`,
          [tenantId]
        );
        await copyFile(join(migrationDirectory, "0097_phone_e164.sql"), join(stagedDirectory, "0097_phone_e164.sql"));
        const invalidRun = runMigrations(upgrade, stagedDirectory, () => undefined);
        await expect(invalidRun).rejects.toThrow(/E164 preflight found invalid values/);
        await expect(invalidRun).rejects.not.toThrow(/12345/);
        expect((await upgrade.query("SELECT phone FROM scheduling_leads WHERE id=$1", [invalidId])).rows[0].phone).toBe("12345");
        await upgrade.query("DELETE FROM scheduling_leads WHERE id=$1", [invalidId]);
        const collisionRun = runMigrations(upgrade, stagedDirectory, () => undefined);
        await expect(collisionRun).rejects.toThrow(/E164 preflight found canonical collisions/);
        await expect(collisionRun).rejects.not.toThrow(/5543234123431/);
        expect((await upgrade.query(
          "SELECT count(*)::int count FROM schema_migrations WHERE filename='0097_phone_e164.sql'"
        )).rows[0].count).toBe(0);
        expect((await upgrade.query(
          "SELECT count(*)::int count FROM pg_constraint WHERE conname='scheduling_leads_phone_e164_check'"
        )).rows[0].count).toBe(0);
      } finally {
        await upgrade.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it("upgrades 0118 with data-driven capability support and appointment backfill", async () => {
    const source = new URL(config.DATABASE_URL);
    const databaseName = `atendon_capability_upgrade_${randomUUID().replaceAll("-", "")}`;
    const adminUrl = new URL(source); adminUrl.pathname = "/postgres";
    const upgradeUrl = new URL(source); upgradeUrl.pathname = `/${databaseName}`;
    const admin = new pg.Pool({ connectionString: adminUrl.toString() });
    const temporaryRoot = await mkdtemp(join(tmpdir(), "atendon-capability-upgrade-"));
    const stagedDirectory = join(temporaryRoot, "staged");
    let created = false;
    try {
      await mkdir(stagedDirectory);
      const migrationDirectory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
      const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
      await Promise.all(files.filter((file) => file < "0118_").map((file) => copyFile(
        join(migrationDirectory, file), join(stagedDirectory, file)
      )));
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      created = true;
      const upgrade = new pg.Client({ connectionString: upgradeUrl.toString() });
      try {
        await upgrade.connect();
        await runMigrations(upgrade, stagedDirectory, () => undefined);
        const tenants = await upgrade.query<{ id: string }>(
          `INSERT INTO tenants(name,status)
           VALUES('Capability A','active'),('Capability B','active'),('Capability C','active')
           RETURNING id`
        );
        const [tenantA, tenantB, tenantC] = tenants.rows.map((tenant) => tenant.id);
        await upgrade.query(
          `INSERT INTO scheduling_categories(tenant_id,id,name)
           VALUES($1,'catalog','Catalog')`,
          [tenantA]
        );
        await upgrade.query(
          `INSERT INTO scheduling_units(tenant_id,id,name,opening_time,closing_time,operating_days)
           VALUES($1,'main','Main','08:00','18:00',ARRAY[1,2,3,4,5]::smallint[])`,
          [tenantA]
        );
        const leadId = (await upgrade.query<{ id: string }>(
          `INSERT INTO scheduling_leads(tenant_id,phone,interest_category_id,unit_id,source)
           VALUES($1,'5511999997777','catalog','main','test') RETURNING id`,
          [tenantA]
        )).rows[0].id;
        await upgrade.query(
          `INSERT INTO scheduling_appointments(tenant_id,lead_id,unit_id,start_at,end_at)
           VALUES($1,$2,'main','2035-01-02T09:00:00Z','2035-01-02T10:00:00Z')`,
          [tenantA, leadId]
        );
        await upgrade.query(
          `INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
           VALUES($1,'post_sales_v1',true),($2,'tripz_ai_v1',false)`,
          [tenantB, tenantC]
        );

        await copyFile(
          join(migrationDirectory, "0118_dynamic_capability_catalog.sql"),
          join(stagedDirectory, "0118_dynamic_capability_catalog.sql")
        );
        expect((await runMigrations(upgrade, stagedDirectory, () => undefined)).applied)
          .toEqual(["0118_dynamic_capability_catalog.sql"]);

        const overrides = await upgrade.query<{ tenant_id: string; flag_key: string; enabled: boolean }>(
          `SELECT tenant_id,flag_key,enabled FROM tenant_feature_flag_overrides
           WHERE tenant_id=ANY($1::uuid[]) AND flag_key=ANY($2::text[])`,
          [[tenantA, tenantB, tenantC], [
            "dashboard_v1", "leads_v1", "pipeline_v1", "appointments_v1",
            "workspace_admin_v1", "post_sales_v1", "tripz_ai_v1"
          ]]
        );
        const value = (tenantId: string, key: string) => overrides.rows
          .find((row) => row.tenant_id === tenantId && row.flag_key === key)?.enabled;
        for (const tenantId of [tenantA, tenantB, tenantC]) {
          for (const key of ["dashboard_v1", "leads_v1", "pipeline_v1", "workspace_admin_v1"]) {
            expect(value(tenantId, key)).toBe(true);
          }
        }
        expect(value(tenantA, "appointments_v1")).toBe(true);
        expect(value(tenantB, "appointments_v1")).toBe(false);
        expect(value(tenantC, "appointments_v1")).toBe(false);
        expect(value(tenantB, "post_sales_v1")).toBe(true);
        expect(value(tenantC, "tripz_ai_v1")).toBe(false);
        expect((await upgrade.query(
          "SELECT tenant_id FROM tenant_capability_support WHERE capability_key='tripz_ai_v1'"
        )).rows).toEqual([{ tenant_id: tenantC }]);

        await expect(upgrade.query(
          `INSERT INTO feature_flag_definitions(flag_key,description,display_name)
           VALUES('invalid-key_v1','invalid','Invalid')`
        )).rejects.toMatchObject({ code: "23514" });
        await expect(upgrade.query(
          `INSERT INTO feature_flag_definitions(flag_key,description,display_name)
           VALUES('dynamic_module_v1','dynamic','Dynamic')`
        )).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await upgrade.end();
      }
    } finally {
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await admin.end();
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 60_000);
});
