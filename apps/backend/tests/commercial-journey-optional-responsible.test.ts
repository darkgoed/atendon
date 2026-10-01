import type { PoolClient } from "pg";
import { beforeEach,describe,expect,it,vi } from "vitest";

vi.mock("../src/db/client.js",()=>({ db: {} }));
vi.mock("../src/modules/scheduling/status-reaction.js",()=>({ APPOINTMENT_STATUS_REACTIONS: {} }));
vi.mock("../src/modules/commercial-journey/loss-reasons.js",()=>({ resolveLossReason: vi.fn() }));
vi.mock("../src/modules/post-sales/service.js",()=>({ captureClosedSalePostSaleClient: vi.fn() }));
vi.mock("../src/modules/assignments/service.js",()=>({ transferCaseAssignment: vi.fn() }));

import { applyStructuredStageEffects } from "../src/modules/commercial-journey/service.js";
import { transferCaseAssignment } from "../src/modules/assignments/service.js";

beforeEach(()=>vi.clearAllMocks());

describe("closing with an optional responsible member",()=>{
  it.each([undefined,{}])("preserves assignment when no responsible member is supplied (%j)",async(payload)=>{
    const query = vi.fn(async(sql: string,_values?: unknown[])=>{
      if (sql.includes("FROM tenant_closing_requirements")) return { rows: [{
        requireSaleValue: false,requireSaleProduct: false,requireSaleChannel: false,
        requireSaleSource: false,requireResponsavel: false
      }] };
      if (sql.includes("SELECT assigned_member_id")) return { rows: [{ assigned_member_id: "existing-member" }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    await applyStructuredStageEffects(client,{
      tenantId: "tenant",lead: { id: "lead",status: "em_atendimento" },
      targetStatus: "fechado",targetStageId: "closed-stage",payload,
      actor: { userId: "actor" }
    });
    expect(transferCaseAssignment).not.toHaveBeenCalled();
    const update = query.mock.calls.find(([sql])=>sql.includes("UPDATE scheduling_leads SET"));
    expect(update).toBeDefined();
    expect(update?.[1]?.[12]).toBeNull();
  });
});
