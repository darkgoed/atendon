import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const meetRoom = readFileSync(new URL("../components/meet-room.tsx", import.meta.url), "utf8");
const authenticatedPage = readFileSync(new URL("../app/meet/[roomId]/page.tsx", import.meta.url), "utf8");
const publicPage = readFileSync(new URL("../app/reuniao/[code]/page.tsx", import.meta.url), "utf8");
const accessGuard = readFileSync(new URL("../components/panel-access-guard.tsx", import.meta.url), "utf8");
const settings = readFileSync(new URL("../app/configuracoes/page.tsx", import.meta.url), "utf8");
const agenda = readFileSync(new URL("../app/agenda/agenda-detail-dialog.tsx", import.meta.url), "utf8");

describe("AtendON Meet panel integration", () => {
  it("loads the external API with scoped tokens and disposes the conference on cleanup", () => {
    expect(meetRoom).toContain("/external_api.js");
    expect(meetRoom).toContain("new Constructor(new URL(origin).host");
    expect(meetRoom).toContain("jwt: access.token");
    expect(meetRoom).toContain("roomName: access.room_name");
    expect(meetRoom).toContain("instance?.dispose()");
    expect(meetRoom).toContain("parentNode?.replaceChildren()");
    expect(authenticatedPage).toContain("/meet/rooms/${encodeURIComponent(roomId)}/token");
    expect(publicPage).toContain("/meet/join/${encodeURIComponent(code)}");
    expect(accessGuard).toContain('"/reuniao"');
  });

  it("exposes tenant settings and appointment-scoped authenticated recordings", () => {
    expect(settings).toContain('"atendon-meet": "AtendON Meet"');
    expect(settings).toContain('<AtendonMeetSettingsPanel canManage={canManageUnits} />');
    expect(settings).toContain('api<AtendonMeetSettingsResponse>("/scheduling/config/atendon-meet"');
    expect(settings).toContain("JSON.stringify({ enabled })");
    expect(agenda).toContain('meeting_provider === "atendon_meet"');
    expect(agenda).toContain("/meet/recordings?appointment_id=${encodeURIComponent(appointmentId)}");
    expect(agenda).toContain("/meet/recordings/${encodeURIComponent(recording.id)}/file");
    expect(agenda).toContain("crossOrigin=\"use-credentials\"");
    expect(agenda).toContain("download={recording.file_name || undefined}");
  });
});
