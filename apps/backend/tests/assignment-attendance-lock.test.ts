import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { assignmentIsLockedByAttendance } from "../src/modules/assignments/service.js";

type QueryResult = { rows: Array<Record<string, unknown>> };

describe("attendance assignment lock", () => {
  it.each(["concluido", "no_show"] as const)(
    "detects a lead locked by %s attendance",
    async (status) => {
      const queries: Array<{ text: string; values?: unknown[] }> = [];
      const client = {
        query: async (text: string, values?: unknown[]): Promise<QueryResult> => {
          queries.push({ text, values });
          return { rows: [{ status }] };
        }
      } as never;

      await expect(
        assignmentIsLockedByAttendance(client, "tenant-1", "lead-1")
      ).resolves.toBe(true);
      expect(queries).toHaveLength(1);
      expect(queries[0].text).toContain("status IN ('concluido','no_show')");
      expect(queries[0].values).toEqual(["tenant-1", "lead-1"]);
    }
  );

  it("does not lock a lead without a final attendance result", async () => {
    const client = {
      query: async (): Promise<QueryResult> => ({ rows: [] })
    } as never;
    await expect(
      assignmentIsLockedByAttendance(client, "tenant-1", "lead-1")
    ).resolves.toBe(false);
  });

  it("keeps every automatic assignment routine guarded, while allowing initial assignment", () => {
    const source = readFileSync(
      new URL("../src/modules/assignments/service.ts", import.meta.url),
      "utf8"
    );
    for (const routine of [
      "ensureCaseAssignment",
      "rebalanceUnscheduledAssignments",
      "redistributeRemovedAssignments"
    ]) {
      const start = source.indexOf(`export async function ${routine}`);
      expect(start, `${routine} must exist`).toBeGreaterThanOrEqual(0);
      const body = source.slice(start, source.indexOf("\nexport ", start + 8));
      expect(body).toContain("assignmentIsLockedByAttendance");
    }
    // The guard returns the existing assignment rather than nulling it. This
    // is the key invariant: an unassigned lead may still receive its first
    // assignment; only a replacement is blocked after attendance.
    expect(source).toContain("return eligibleByExistingAssignment(client, input.tenantId, rows);");
    expect(source).toContain('"transferencia_manual"');
    expect(source).toContain('statusCode: 403');
  });
});
