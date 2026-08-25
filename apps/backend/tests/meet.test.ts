import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJitsiToken } from "../src/modules/meet/jitsi-token.js";
import { indexMeetRecordings, matchRecordingRoom } from "../src/modules/meet/recordings-indexer.js";
import { deleteExpiredMeetRecordings, safeRecordingFilePath } from "../src/modules/meet/retention.js";
import { parseRecordingRange, resolveRecordingPath } from "../src/modules/meet/routes.js";
import { createMeetRoomIdentity } from "../src/modules/meet/service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AtendON Meet tokens", () => {
  const secret = "meet-test-secret-that-is-longer-than-thirty-two-characters";
  const base = {
    appId: "atendon-test",
    secret,
    publicUrl: "https://meet.atendon.example",
    roomName: "atendon-0123456789abcdef0123456789abcdef",
    now: new Date("2026-08-21T12:00:00.000Z")
  } as const;

  it("scopes moderator claims to one room and enables recording", async () => {
    const token = await createJitsiToken({
      ...base,
      role: "moderator",
      user: { id: "user-1", name: "Owner", email: "owner@example.test" }
    });
    const verified = await jwtVerify(token, new TextEncoder().encode(secret), {
      issuer: "atendon-test",
      audience: "atendon-test",
      subject: "meet.atendon.example",
      currentDate: base.now
    });
    expect(verified.protectedHeader).toMatchObject({ alg: "HS256", typ: "JWT" });
    expect(verified.payload.room).toBe(base.roomName);
    expect(verified.payload.exp! - verified.payload.iat!).toBe(7_200);
    expect(verified.payload.context).toEqual({
      user: { id: "user-1", name: "Owner", email: "owner@example.test", affiliation: "owner", moderator: true },
      features: { recording: true }
    });
  });

  it("issues a non-moderator participant token without recording", async () => {
    const token = await createJitsiToken({
      ...base,
      role: "participant",
      user: { id: "guest-1", name: "Participante" }
    });
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { currentDate: base.now });
    expect(payload.room).toBe(base.roomName);
    expect(payload.context).toEqual({
      user: { id: "guest-1", name: "Participante", affiliation: "member", moderator: false },
      features: { recording: false }
    });
  });

  it("generates unguessable room names and public codes", () => {
    const first = createMeetRoomIdentity();
    const second = createMeetRoomIdentity();
    expect(first.roomName).toMatch(/^atendon-[a-f0-9]{32}$/);
    expect(first.publicCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second).not.toEqual(first);
  });
});

describe("AtendON Meet recording safety and maintenance", () => {
  it("rejects traversal and absolute database paths", () => {
    expect(resolveRecordingPath("/recordings", "room/video.mp4")).toBe("/recordings/room/video.mp4");
    expect(safeRecordingFilePath("/recordings", "room/video.mp4")).toBe("/recordings/room/video.mp4");
    for (const unsafe of ["../secret.mp4", "/etc/passwd", "room/../../secret.mp4", ""] ) {
      expect(() => resolveRecordingPath("/recordings", unsafe)).toThrow();
      expect(() => safeRecordingFilePath("/recordings", unsafe)).toThrow();
    }
  });

  it("parses bounded, open and suffix byte ranges for video streaming", () => {
    expect(parseRecordingRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(parseRecordingRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(parseRecordingRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(parseRecordingRange("bytes=8-99", 10)).toEqual({ start: 8, end: 9 });
    for (const invalid of ["bytes=", "bytes=10-", "bytes=8-7", "bytes=0-1,4-5", "items=0-1"]) {
      expect(parseRecordingRange(invalid, 10)).toBeNull();
    }
  });

  it("matches only exact room-bearing path segments or metadata", () => {
    const rooms = [{ tenant_id: "tenant", room_name: "atendon-abc", appointment_id: null }];
    expect(matchRecordingRoom("atendon-abc/video.mp4", null, rooms)?.tenant_id).toBe("tenant");
    expect(matchRecordingRoom("other/video.mp4", "atendon-abc", rooms)?.tenant_id).toBe("tenant");
    expect(matchRecordingRoom("prefix-atendon-abc/video.mp4", null, rooms)).toBeNull();
  });

  it("indexes known-room recordings and leaves unknown files unassigned", async () => {
    const root = await mkdtemp(join(tmpdir(), "atendon-meet-index-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "atendon-abc"));
    await mkdir(join(root, "unknown"));
    await writeFile(join(root, "atendon-abc", "recording.mp4"), "video");
    await writeFile(join(root, "atendon-abc", ".atendon-ready"), "");
    await writeFile(join(root, "unknown", "recording.mp4"), "video");
    await writeFile(join(root, "unknown", ".atendon-ready"), "");
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      void values;
      return sql.startsWith("SELECT tenant_id")
        ? { rows: [{ tenant_id: "tenant", room_name: "atendon-abc", appointment_id: "appointment" }] }
        : { rows: [] };
    });
    const result = await indexMeetRecordings(root, { query } as never);
    expect(result).toEqual({ scanned: 2, indexed: 1, unmatched: 1, errors: 0, missing: 0 });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1][1]).toEqual(expect.arrayContaining(["tenant", "atendon-abc", "appointment", "atendon-abc/recording.mp4", 5]));
  });

  it("does not index a recording until Jibri publishes its finalization marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "atendon-meet-in-progress-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "atendon-abc"));
    await writeFile(join(root, "atendon-abc", "recording.mp4"), "partial-video");
    const query = vi.fn(async (sql: string) => sql.startsWith("SELECT tenant_id")
      ? { rows: [{ tenant_id: "tenant", room_name: "atendon-abc", appointment_id: "appointment" }] }
      : { rows: [] });

    await expect(indexMeetRecordings(root, { query } as never)).resolves.toEqual({
      scanned: 0,
      indexed: 0,
      unmatched: 0,
      errors: 0,
      missing: 0
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("marks indexed rows missing when finalized files disappear", async () => {
    const root = await mkdtemp(join(tmpdir(), "atendon-meet-missing-"));
    temporaryDirectories.push(root);
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT tenant_id")) return { rows: [] };
      if (sql.startsWith("UPDATE meet_recordings")) return { rows: [{ id: "missing" }], rowCount: 1 };
      return { rows: [] };
    });

    await expect(indexMeetRecordings(root, { query } as never)).resolves.toEqual({
      scanned: 0,
      indexed: 0,
      unmatched: 0,
      errors: 0,
      missing: 1
    });
  });

  it("deletes the database row only after the expired file is removed", async () => {
    const root = await mkdtemp(join(tmpdir(), "atendon-meet-retain-"));
    temporaryDirectories.push(root);
    await mkdir(join(root, "room"));
    const file = join(root, "room", "old.mp4");
    await writeFile(file, "old-video");
    const removeFile = vi.fn(async () => undefined);
    const query = vi.fn(async (sql: string) => sql.startsWith("SELECT id")
      ? { rows: [{ id: "recording", file_path: "room/old.mp4" }] }
      : { rows: [] });
    const result = await deleteExpiredMeetRecordings({
      recordingsRoot: root,
      retentionDays: 30,
      now: new Date("2026-08-21T00:00:00Z"),
      database: { query } as never,
      removeFile
    });
    expect(result).toEqual({ examined: 1, deleted: 1, failed: 0 });
    expect(removeFile).toHaveBeenCalledWith(file);
    expect(query.mock.calls[1]).toEqual(["DELETE FROM meet_recordings WHERE id=$1", ["recording"]]);
  });

  it("does not follow an intermediate symlink outside the recordings root during retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "atendon-meet-retain-root-"));
    const outside = await mkdtemp(join(tmpdir(), "atendon-meet-retain-outside-"));
    temporaryDirectories.push(root, outside);
    const outsideFile = join(outside, "protected.mp4");
    await writeFile(outsideFile, "do-not-delete");
    await symlink(outside, join(root, "escaped"), "dir");
    const query = vi.fn(async (sql: string) => sql.startsWith("SELECT id")
      ? { rows: [{ id: "recording", file_path: "escaped/protected.mp4" }] }
      : { rows: [] });
    const removeFile = vi.fn(async () => undefined);

    const result = await deleteExpiredMeetRecordings({
      recordingsRoot: root,
      database: { query } as never,
      removeFile
    });

    expect(result).toEqual({ examined: 1, deleted: 0, failed: 1 });
    expect(removeFile).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
