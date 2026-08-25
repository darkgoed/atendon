import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../src/config.js";
import type { AiRouter } from "../src/modules/ai-router/openrouter.js";
import { AiReplayRunner } from "../src/modules/agent-improvement/replay-runner.js";

const pool = new pg.Pool({ connectionString: config.DATABASE_URL });
let tenantId = "";
let runId = "";
let proposalId = "";

beforeAll(async () => {
  tenantId = (await pool.query<{id:string}>("INSERT INTO tenants(name,status) VALUES($1,'active') RETURNING id",[`Replay ${randomUUID()}`])).rows[0].id;
  const userId = (await pool.query<{id:string}>("INSERT INTO users(email,status,is_root) VALUES($1,'active',true) RETURNING id",[`replay-${randomUUID()}@example.com`])).rows[0].id;
  const agentId = (await pool.query<{id:string}>(
    `INSERT INTO agent_configs(tenant_id,system_prompt,ai_model,enabled_tools)
     VALUES($1,'Prompt base','model/replay','["registrar_lead"]') RETURNING id`,[tenantId])).rows[0].id;
  const baselineId=(await pool.query<{active_version_id:string}>("SELECT active_version_id FROM agent_configs WHERE id=$1",[agentId])).rows[0].active_version_id;
  const candidateId=(await pool.query<{id:string}>(
    `INSERT INTO agent_config_versions(tenant_id,agent_config_id,version_number,source,status,system_prompt,ai_model,model_params,enabled_tools,created_by_user_id)
     VALUES($1,$2,2,'proposal','candidate','Prompt melhor','model/replay','{"temperature":0.7,"max_tokens":777,"reasoning_effort":"high"}','["registrar_lead"]',$3) RETURNING id`,
    [tenantId,agentId,userId])).rows[0].id;
  proposalId=(await pool.query<{id:string}>(
    `INSERT INTO ai_improvement_proposals(
       tenant_id,baseline_version_id,candidate_version_id,title,rationale,target_issue_codes,
       evidence_evaluation_ids,expected_impact,status,created_by)
     VALUES($1,$2,$3,'Melhorar continuidade','Racional confirmado e seguro','["REPEATED_GREETING"]','[]',
       '{"targetDimensions":["continuity"]}','testing','human') RETURNING id`,
    [tenantId,baselineId,candidateId])).rows[0].id;
  await pool.query(
    `INSERT INTO ai_regression_cases(
       tenant_id,name,scenario,expected_behavior,severity,created_by_user_id)
     VALUES($1,'Fluxo simulado',
       '{"history":[],"targetMessage":"Cadastre meu interesse","fixedTime":"2030-01-01T12:00:00.000Z","context":{}}',
       '{"required":["ok"],"forbidden":[],"targetDimensions":["continuity"],"simulatedTools":[{"name":"registrar_lead","arguments":{},"result":"lead simulado","transactionalOutcome":{"status":"succeeded","claims":[{"claimType":"qualification_registered","normalizedValue":"true"}]}}],"deterministic":{"action":"register","actionEvidence":{"type":"tool","toolName":"registrar_lead"},"toolCalls":[{"name":"registrar_lead","arguments":{}}],"claims":[{"claimType":"qualification_registered","normalizedValue":"true"}]}}',
       'high',$2)`,[tenantId,userId]);
  await pool.query("UPDATE tenant_ai_settings SET evaluator_model='model/judge' WHERE tenant_id=$1",[tenantId]);
  runId=(await pool.query<{id:string}>(
    `INSERT INTO ai_evaluation_runs(tenant_id,proposal_id,baseline_version_id,candidate_version_id,rubric_version,status)
     VALUES($1,$2,$3,$4,'v1','queued') RETURNING id`,[tenantId,proposalId,baselineId,candidateId])).rows[0].id;
});

afterAll(async()=>{if(tenantId)await pool.query("DELETE FROM tenants WHERE id=$1",[tenantId]);await pool.query("DELETE FROM users WHERE email LIKE 'replay-%@example.com'");await pool.end()});

function judged(score:number){const item={score,rationale:"Resultado do replay",evidenceMessageIds:[]};return JSON.stringify({scores:{correctness:item,task_completion:item,continuity:item,communication:item,security_privacy:item,tool_usage:item,handoff:item},violations:[],overallScore:score,hasCriticalFailure:false,summary:"Replay seguro"})}

describe("AI replay runner isolation",()=>{
  it("uses only simulated tool results and promotes the proposal when gates pass",async()=>{
    let judgeCalls=0;
    const complete=vi.fn<AiRouter["complete"]>().mockImplementation(async input=>{
      if(input.systemPrompt.includes("Avalie uma única resposta"))return{text:judged(judgeCalls++===0?80:90),inputTokens:1,outputTokens:1,costUsd:0};
      if(input.systemPrompt.includes("Prompt melhor")) {
        expect(input.temperature).toBe(0.7);
        expect(input.maxTokens).toBe(777);
        expect(input.reasoningEffort).toBe("high");
      }
      const result=await input.executeTool?.("registrar_lead","{}");
      expect(result).toBe("lead simulado");
      return{text:"ok, interesse registrado no replay",inputTokens:1,outputTokens:1,costUsd:.01};
    });
    await expect(new AiReplayRunner(pool,{complete},config).process(runId)).resolves.toBe("passed");
    expect(complete).toHaveBeenCalledTimes(4);
    expect((await pool.query("SELECT status FROM ai_evaluation_runs WHERE id=$1",[runId])).rows[0]).toEqual({status:"passed"});
    expect((await pool.query("SELECT status FROM ai_improvement_proposals WHERE id=$1",[proposalId])).rows[0]).toEqual({status:"ready"});
    expect((await pool.query("SELECT passed,simulated_tool_calls FROM ai_evaluation_case_results WHERE run_id=$1",[runId])).rows[0]).toMatchObject({
      passed:true,
      simulated_tool_calls:[{
        name:"registrar_lead",
        arguments:{},
        transactionalOutcome:{
          status:"succeeded",
          claims:[{claimType:"qualification_registered",normalizedValue:"true"}]
        }
      }]
    });
    expect((await pool.query("SELECT aggregate_metrics FROM ai_evaluation_runs WHERE id=$1",[runId])).rows[0]
      .aggregate_metrics.publicationAuthorization).toMatchObject({
        baselineVersionId: expect.any(String),
        candidateVersionId: expect.any(String),
        baselineFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        candidateFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        regressionSuiteFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect((await pool.query("SELECT count(*)::int count FROM scheduling_leads WHERE tenant_id=$1",[tenantId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM scheduling_appointments WHERE tenant_id=$1",[tenantId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM outbound_message_requests WHERE tenant_id=$1",[tenantId])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM handoff_notifications WHERE tenant_id=$1",[tenantId])).rows[0].count).toBe(0);
  });
});
