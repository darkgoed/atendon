import { lstat, realpath, unlink } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { Pool } from "pg";
import { config } from "../../config.js";
import { db } from "../../db/client.js";

interface Queryable {
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

interface ExpiredRecording {
  id: string;
  file_path: string;
}

export interface RecordingRetentionResult {
  examined: number;
  deleted: number;
  failed: number;
}

export function safeRecordingFilePath(root: string, storedPath: string): string {
  if (!storedPath || storedPath.includes("\0") || storedPath.startsWith("/") || storedPath.startsWith("\\")) {
    throw new Error("Unsafe recording path");
  }
  const rootPath = resolve(root);
  const path = resolve(rootPath, storedPath);
  const rel = relative(rootPath, path);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Unsafe recording path");
  return path;
}

export async function deleteExpiredMeetRecordings(options: {
  recordingsRoot?: string;
  retentionDays?: number;
  now?: Date;
  database?: Queryable;
  removeFile?: (path: string) => Promise<void>;
} = {}): Promise<RecordingRetentionResult> {
  const recordingsRoot = options.recordingsRoot ?? config.MEET_RECORDINGS_DIR;
  const retentionDays = options.retentionDays ?? config.MEET_RECORDING_RETENTION_DAYS;
  const now = options.now ?? new Date();
  const database = options.database ?? db as Pool;
  const removeFile = options.removeFile ?? unlink;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const expired = await database.query<ExpiredRecording>(
    `SELECT id,file_path FROM meet_recordings
     WHERE COALESCE(ended_at,started_at,created_at) < $1
     ORDER BY created_at,id`,
    [cutoff]
  );
  let deleted = 0;
  let failed = 0;
  for (const recording of expired.rows) {
    try {
      const path = safeRecordingFilePath(recordingsRoot, recording.file_path);
      try {
        const [rootReal, stat] = await Promise.all([realpath(recordingsRoot), lstat(path)]);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Recording is not a regular file");
        const fileReal = await realpath(path);
        const rel = relative(rootReal, fileReal);
        if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`)) {
          throw new Error("Recording resolves outside its root");
        }
        await removeFile(fileReal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await database.query("DELETE FROM meet_recordings WHERE id=$1", [recording.id]);
      deleted += 1;
    } catch {
      failed += 1;
    }
  }
  return { examined: expired.rows.length, deleted, failed };
}
