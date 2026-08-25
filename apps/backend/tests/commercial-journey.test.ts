import { describe,expect,it } from "vitest";
import { LEAD_TECHNICAL_STATUSES,domainAllowsStageTransition } from "../src/modules/organization/domain.js";
import {
  cancellationSchema,
  commercialTransitionPayloadSchema,
  concludeAppointmentSchema
} from "../src/modules/commercial-journey/schemas.js";
import { OUTCOME_PIPELINE_STAGE,stageRequiresCommercialPayload } from "../src/modules/commercial-journey/domain.js";

describe("commercial journey contract",()=>{
  it("exposes exactly the ten canonical statuses",()=>{
    expect(LEAD_TECHNICAL_STATUSES).toEqual([
      "novo","em_atendimento","aguardando_resposta","qualificado","agendado",
      "em_negociacao","proposta_enviada","follow_up","fechado","perdido"
    ]);
  });

  it("keeps terminal wins closed while allowing an explicit lost recovery",()=>{
    expect(domainAllowsStageTransition("fechado","follow_up")).toBe(false);
    expect(domainAllowsStageTransition("perdido","follow_up")).toBe(true);
    expect(domainAllowsStageTransition("agendado","fechado")).toBe(true);
  });

  it("maps all five outcomes to one canonical pipeline",()=>{
    expect(OUTCOME_PIPELINE_STAGE).toEqual({
      fechado: "fechado",
      proposta_enviada: "proposta_enviada",
      em_negociacao: "em_negociacao",
      follow_up: "follow_up",
      nao_avancou: "perdido"
    });
  });

  it("requires the outcome-specific commercial fields",()=>{
    expect(()=>concludeAppointmentSchema.parse({ outcome: "fechado" })).toThrow();
    expect(()=>concludeAppointmentSchema.parse({ outcome: "fechado",sale_value: 0 })).toThrow();
    expect(concludeAppointmentSchema.parse({ outcome: "fechado",sale_value: 1250 })).toMatchObject({ sale_value: 1250 });
    expect(()=>concludeAppointmentSchema.parse({ outcome: "follow_up",next_action: "Ligar" })).toThrow();
    expect(()=>concludeAppointmentSchema.parse({ outcome: "nao_avancou" })).toThrow();
    expect(concludeAppointmentSchema.parse({ outcome: "nao_avancou",loss_reason: "preco" })).toMatchObject({ loss_reason: "preco" });
  });

  it("requires a recovery action or a loss reason on cancellation",()=>{
    expect(()=>cancellationSchema.parse({ disposition: "recover" })).toThrow();
    expect(cancellationSchema.parse({
      disposition: "recover",next_action: "Reagendar",next_action_at: "2035-01-01T12:00:00.000Z"
    })).toMatchObject({ disposition: "recover" });
    expect(()=>cancellationSchema.parse({ disposition: "lost" })).toThrow();
  });

  it("identifies DnD targets that cannot bypass structured data",()=>{
    for (const status of ["fechado","perdido","em_negociacao","proposta_enviada","follow_up"] as const) {
      expect(stageRequiresCommercialPayload(status)).toBe(true);
    }
    expect(stageRequiresCommercialPayload("agendado")).toBe(false);
    expect(commercialTransitionPayloadSchema.parse({ sale_value: 100 })).toEqual({ sale_value: 100 });
  });
});
