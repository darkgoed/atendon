import { describe, expect, it } from "vitest";
import { extractPrefilledFields, prefilledQualificationAcknowledgement, schedulingAvailabilityPolicyCorrection } from "../src/modules/messages/prefilled-context-policy.js";
describe("prefilled pure policy", () => {
  it("extracts field blocks without data access", () => expect(extractPrefilledFields([{role:"user",content:"Nicho: celulares\nFaturamento: 10 mil"}])).toEqual([{label:"Nicho",value:"celulares"},{label:"Faturamento",value:"10 mil"}]));
  it("acknowledges supplied qualification", () => expect(prefilledQualificationAcknowledgement([{role:"user",content:"Nicho: celulares\nPerda de vendas: limite do cartão"}])).toContain("Entendi"));
  it("blocks open availability questions", () => expect(schedulingAvailabilityPolicyCorrection("Qual horário fica melhor?")).toBeTruthy());
});
