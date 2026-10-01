import { expect, it, vi } from "vitest";
import { TripzAiRepository } from "../src/modules/tripz-ai/repository.js";
import { createEmptyTripzProposalState } from "../src/modules/tripz-ai/domain.js";

it("completeAiTurn persists schema_version with schema2 state and reloads the actual schema", async () => {
  const now = "2026-10-01T00:00:00Z";
  let row = { id: "p", conversation_id: "c", schema_version: 1, revision: 9, state: createEmptyTripzProposalState(), created_at: now, updated_at: now };
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql.includes("FROM tripz_ai_conversations")) return { rows: [{ title: "Carlos", processing_status: "processing" }] };
    if (sql.includes("SELECT id FROM tripz_ai_messages")) return { rows: [{ id: "u" }] };
    if (sql.includes("UPDATE tripz_ai_proposals SET")) {
      row = { ...row, revision: row.revision + 1, state: JSON.parse(JSON.stringify(args[2])), schema_version: sql.includes("schema_version=$6") ? args[5] as number : row.schema_version };
      return { rows: [row] };
    }
    if (sql.includes("FROM tripz_ai_proposals")) return { rows: [row] };
    if (sql.includes("INSERT INTO tripz_ai_messages")) return { rows: [{ id: "a", conversation_id: "c", role: "assistant", content: args[2], metadata: {}, processing_status: "completed", proposal_revision_before: 9, proposal_revision_after: 10, created_at: now, updated_at: now }] };
    return { rows: [], rowCount: 0 };
  });
  const database = { query, connect: async () => ({ query, release: vi.fn() }) };
  const repository = new TripzAiRepository(database as unknown as ConstructorParameters<typeof TripzAiRepository>[0]);
  const scope = { tenantId: "t", userId: "u", canManage: false };
  const state = { ...createEmptyTripzProposalState(), schemaVersion: 2 as const, client: { name: "Carlos" }, editorial: { commercial: { paymentSummary: "PIX à vista" } } };
  const completed = await repository.completeAiTurn(scope, { conversationId: "c", userMessageId: "u", expectedRevision: 9, proposal: state, assistantMessage: "Salvo", summary: "Carlos", attachmentResults: [] });
  expect(completed.proposal.schemaVersion).toBe(2);
  const reloaded = await repository.getProposal(scope, "c");
  expect(reloaded?.state).toEqual(state);
  expect(reloaded?.schemaVersion).toBe(2);
  expect(query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
});
