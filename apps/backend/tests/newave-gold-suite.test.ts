import { describe, expect, it } from "vitest";
import {
  NEWAVE_GOLD_CASES,
  NEWAVE_GOLD_SUITE_VERSION
} from "../src/modules/agent-improvement/newave-gold-suite.js";

describe("Newave sanitized gold suite", () => {
  it("contains 30-50 stable, unique and sanitized declarative cases", () => {
    expect(NEWAVE_GOLD_CASES.length).toBeGreaterThanOrEqual(30);
    expect(NEWAVE_GOLD_CASES.length).toBeLessThanOrEqual(50);
    expect(new Set(NEWAVE_GOLD_CASES.map((item) => item.key)).size).toBe(NEWAVE_GOLD_CASES.length);
    expect(NEWAVE_GOLD_SUITE_VERSION).toMatch(/^newave-gold-v\d+$/);
    expect(JSON.stringify(NEWAVE_GOLD_CASES)).not.toMatch(
      /arthur|muller07|@gmail|5511\d{8,}|sk-or-v1-[a-z0-9]+/i
    );
  });

  it.each([
    ["duration", ["duration_15", "duration_60"]],
    ["timezone/DST", ["timezone_sao_paulo", "timezone_dst_new_york"]],
    ["availability/ambiguity", ["slot_unavailable", "slot_ambiguous_yes"]],
    ["Meet failures/retry", ["meet_link_missing", "meet_timeout", "meet_retry"]],
    ["appointment management", ["reschedule_active", "cancel_active", "active_blocks_duplicate"]],
    ["form/media", ["form_complete", "media_audio_understood", "media_document_unavailable"]],
    ["handoff/identity/injection", ["handoff_contact_requested", "identity_direct_transparency", "handoff_doubt_continues", "handoff_frustration_continues", "prompt_injection_ignore"]],
    ["conversation deviations", ["handoff_incomplete_continues", "handoff_hard_question_continues", "topic_change_continues", "unexpected_information_continues", "off_sequence_answer_continues"]],
    ["duplicate/idempotency", ["duplicate_inbound", "duplicate_tool_idempotency"]]
  ])("covers %s", (_area, keys) => {
    const available = new Set(NEWAVE_GOLD_CASES.map((item) => item.key));
    for (const key of keys) expect(available.has(key), key).toBe(true);
  });

  it("keeps actions and exact tool arguments deterministic outside the linguistic judge", () => {
    for (const item of NEWAVE_GOLD_CASES) {
      const deterministic = item.expectedBehavior.deterministic;
      expect(deterministic.action).toBeTruthy();
      expect(deterministic.actionEvidence.type).toMatch(/^(tool|response)$/);
      expect(deterministic.toolCalls).toEqual(
        item.expectedBehavior.simulatedTools.map((tool) => ({
          name: tool.name,
          arguments: tool.arguments ?? {}
        }))
      );
      if (deterministic.actionEvidence.type === "response") {
        expect(deterministic.actionEvidence.anyOf.length).toBeGreaterThan(0);
      }
    }
  });
});
