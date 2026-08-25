import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

let schedulerSource = "";

beforeAll(async () => {
  schedulerSource = await readFile(new URL("../components/conversation-scheduler.tsx", import.meta.url), "utf8");
});

describe("Conversation scheduler closer availability", () => {
  it("reloads availability for the selected closer", () => {
    expect(schedulerSource).toContain("&assigned_member_id=${encodeURIComponent(assignedMemberId)}");
    expect(schedulerSource).toContain("Escolha o closer para ver abaixo somente os horários livres dele.");
  });

  it("allows switching to a closer that conflicts with the currently displayed time", () => {
    expect(schedulerSource).toContain('assignee.availability_status !== "available"');
    expect(schedulerSource).toContain('setSelectedStart("")');
    expect(schedulerSource).toContain("assignee.conflicts.length ? \" · outro horário será exibido\"");
  });
});
