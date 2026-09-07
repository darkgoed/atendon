import { describe, expect, it } from "vitest";
import { hasAlreadyRetriedSameTopic, isSameFollowUpTopic, parseFollowUpDecision, isRepetitiveFollowUp } from "../src/modules/messages/follow-up-policy.js";
describe("follow-up pure policy", () => {
  it("detects same pending topic", () => expect(isSameFollowUpTopic("Qual horário para reunião amanhã?", "Qual horário da reunião amanhã?" )).toBe(true));
  it("recognizes repeated unanswered attempts", () => expect(hasAlreadyRetriedSameTopic([{role:"user",content:"oi"},{role:"assistant",content:"Qual horário da reunião amanhã?"},{role:"assistant",content:"Qual horário para reunião amanhã?"}])).toBe(true));
  it("fails closed on no-send marker", () => expect(parseFollowUpDecision(" [[NO_FOLLOW_UP_NEEDED]] ")).toEqual({send:false,text:""}));
  it("rejects repetitive output", () => expect(isRepetitiveFollowUp("Vamos marcar a reunião amanhã às dez", ["Vamos marcar a reunião amanhã às dez"])).toBe(true));
});
