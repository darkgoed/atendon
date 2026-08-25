import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import type { Pool } from "pg";
import { config } from "../../config.js";
import { db } from "../../db/client.js";

interface Queryable {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

interface KnownRoom {
  tenant_id: string;
  room_name: string;
  appointment_id: string | null;
}

export interface RecordingFile {
  absolutePath: string;
  relativePath: string;
  sizeBytes: number;
  startedAt: Date;
  endedAt: Date;
}

export interface RecordingIndexResult {
  scanned: number;
  indexed: number;
  unmatched: number;
  errors: number;
  missing: number;
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".webm", ".mkv"]);

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return Boolean(rel) && rel !== "." && !rel.startsWith(`..${sep}`) && rel !== "..";
}

async function walk(root: string, directory: string, files: RecordingFile[], finalizedByParent = false): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  const finalized = finalizedByParent || entries.some((entry) => entry.name === ".atendon-ready" && entry.isFile());
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (!inside(root, path) || entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walk(root, path, files, finalized);
      continue;
    }
    if (!finalized || !entry.isFile() || !VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    const stat = await lstat(path);
    files.push({
      absolutePath: path,
      relativePath: relative(root, path).split(sep).join("/"),
      sizeBytes: stat.size,
      startedAt: stat.birthtimeMs > 0 ? stat.birthtime : stat.mtime,
      endedAt: stat.mtime
    });
  }
}

export async function listRecordingFiles(recordingsRoot: string): Promise<RecordingFile[]> {
  let root: string;
  try {
    root = await realpath(recordingsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: RecordingFile[] = [];
  await walk(root, root, files);
  return files;
}

async function metadataRoomName(file: RecordingFile): Promise<string | null> {
  for (const filename of ["metadata.json", "recording_metadata.json"]) {
    try {
      const data = JSON.parse(await readFile(resolve(dirname(file.absolutePath), filename), "utf8")) as Record<string, unknown>;
      for (const key of ["room_name", "roomName", "meeting_name", "meetingName"]) {
        if (typeof data[key] === "string" && data[key]) return data[key] as string;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

export function matchRecordingRoom(relativePath: string, metadataName: string | null, rooms: KnownRoom[]): KnownRoom | null {
  const normalizedPath = relativePath.toLocaleLowerCase("en-US");
  const normalizedMetadata = metadataName?.toLocaleLowerCase("en-US") ?? null;
  return rooms.find((room) => {
    const name = room.room_name.toLocaleLowerCase("en-US");
    return normalizedMetadata === name
      || normalizedPath.split("/").some((segment) => segment === name || segment.startsWith(`${name}_`) || segment.startsWith(`${name}-`));
  }) ?? null;
}

export async function indexMeetRecordings(
  recordingsRoot = config.MEET_RECORDINGS_DIR,
  database: Queryable = db as Pool
): Promise<RecordingIndexResult> {
  try {
    await realpath(recordingsRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: 0, indexed: 0, unmatched: 0, errors: 0, missing: 0 };
    }
    throw error;
  }
  const [files, known] = await Promise.all([
    listRecordingFiles(recordingsRoot),
    database.query<KnownRoom>("SELECT tenant_id,room_name,appointment_id FROM meet_rooms")
  ]);
  let indexed = 0;
  let unmatched = 0;
  let errors = 0;
  for (const file of files) {
    try {
      const room = matchRecordingRoom(file.relativePath, await metadataRoomName(file), known.rows);
      if (!room) {
        unmatched += 1;
        continue;
      }
      await database.query(
        `INSERT INTO meet_recordings(
           tenant_id,room_name,appointment_id,file_path,size_bytes,started_at,ended_at,status
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'ready')
         ON CONFLICT(file_path) DO UPDATE SET
           size_bytes=EXCLUDED.size_bytes,
           ended_at=EXCLUDED.ended_at,
           status='ready'`,
        [
          room.tenant_id,
          room.room_name,
          room.appointment_id,
          file.relativePath,
          file.sizeBytes,
          file.startedAt,
          file.endedAt
        ]
      );
      indexed += 1;
    } catch {
      errors += 1;
    }
  }
  const presentPaths = files.map((file) => file.relativePath);
  const missingResult = await database.query<{ id: string }>(
    `UPDATE meet_recordings
     SET status='missing'
     WHERE status='ready' AND NOT (file_path=ANY($1::text[]))
     RETURNING id`,
    [presentPaths]
  );
  return {
    scanned: files.length,
    indexed,
    unmatched,
    errors,
    missing: missingResult.rowCount ?? missingResult.rows.length
  };
}
