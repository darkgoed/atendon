import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requirePermission, requireWorkspace } from "../../auth/session.js";
import { appointmentScopeCondition, resolveCaseScope } from "../../auth/case-scope.js";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { HTTP_RATE_LIMITS } from "../../security/http-rate-limit.js";
import {
  createMeetRoom,
  findPublicRoom,
  findTenantRoom,
  meetDomain,
  moderatorToken,
  participantJoinUrl,
  participantToken
} from "./service.js";

const roomParams = z.object({ id: z.string().uuid() });
const joinParams = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{32}$/) });
const createRoomBody = z.object({ appointment_id: z.string().uuid().nullable().optional() }).strict();
const recordingParams = z.object({ id: z.string().uuid() });
const recordingQuery = z.object({ appointment_id: z.string().uuid() });

interface RecordingRow {
  id: string;
  file_path: string;
  size_bytes: string | number;
  started_at: Date | null;
  ended_at: Date | null;
  status: string;
}

export interface RecordingByteRange {
  start: number;
  end: number;
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

export function resolveRecordingPath(root: string, storedPath: string): string {
  if (!storedPath || storedPath.includes("\0") || storedPath.startsWith("/") || storedPath.startsWith("\\")) {
    throw notFound("Gravação não encontrada");
  }
  const rootPath = resolve(root);
  const candidate = resolve(rootPath, storedPath);
  const withinRoot = relative(rootPath, candidate);
  if (!withinRoot || withinRoot === "." || withinRoot.startsWith("..") || withinRoot.includes("\0")) {
    throw notFound("Gravação não encontrada");
  }
  return candidate;
}

function recordingPayload(row: RecordingRow) {
  return {
    id: row.id,
    file_name: basename(row.file_path),
    size_bytes: Number(row.size_bytes),
    started_at: row.started_at?.toISOString() ?? null,
    ended_at: row.ended_at?.toISOString() ?? null,
    status: row.status
  };
}

function recordingContentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".webm": return "video/webm";
    case ".mkv": return "video/x-matroska";
    default: return "video/mp4";
  }
}

async function canAccessAppointment(request: Parameters<typeof requirePermission>[0], appointmentId: string): Promise<boolean> {
  const session = await requirePermission(request, "appointments.read");
  const scope = await resolveCaseScope(db, session);
  const result = await db.query(
    `SELECT 1 FROM scheduling_appointments appointment
     WHERE appointment.tenant_id=$1 AND appointment.id=$2
       AND (${appointmentScopeCondition(scope, "appointment", "$3")})`,
    [session.tenantId, appointmentId, scope.memberId]
  );
  return Boolean(result.rows[0]);
}

export function parseRecordingRange(header: string, size: number): RecordingByteRange | null {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid recording size");
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start < 0 || start >= size) return null;
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

export async function registerMeetRoutes(app: FastifyInstance) {
  app.addHook("onRequest", async () => {
    if (!config.MEET_ENABLED) {
      throw Object.assign(new Error("AtendON Meet ainda não está disponível"), { statusCode: 503 });
    }
  });

  app.post("/meet/rooms", {
    config: { rateLimit: HTTP_RATE_LIMITS.sensitiveWrite }
  }, async (request, reply) => {
    const session = await requireWorkspace(request);
    const body = createRoomBody.parse(request.body ?? {});
    if (body.appointment_id && !await canAccessAppointment(request, body.appointment_id)) {
      throw notFound("Agendamento não encontrado");
    }
    const room = await createMeetRoom(session.tenantId, body.appointment_id ?? null);
    return reply.status(201).send({
      room: {
        id: room.id,
        room_name: room.room_name,
        code: room.public_code,
        url: participantJoinUrl(room.public_code),
        appointment_id: room.appointment_id,
        created_at: room.created_at,
        expires_at: room.expires_at
      }
    });
  });

  app.get("/meet/rooms/:id/token", async (request) => {
    const session = await requireWorkspace(request);
    const { id } = roomParams.parse(request.params);
    const room = await findTenantRoom(session.tenantId, id);
    if (!room) throw notFound("Sala não encontrada");
    if (room.appointment_id && !await canAccessAppointment(request, room.appointment_id)) {
      throw notFound("Sala não encontrada");
    }
    return {
      token: await moderatorToken(room, { id: session.userId, name: session.email, email: session.email }),
      room_name: room.room_name,
      domain: meetDomain()
    };
  });

  app.get("/meet/join/:code", {
    config: { rateLimit: { ...HTTP_RATE_LIMITS.invitationRead, groupId: "meet-public-join" } }
  }, async (request) => {
    const { code } = joinParams.parse(request.params);
    const room = await findPublicRoom(code);
    if (!room) throw notFound("Sala não encontrada");
    return {
      token: await participantToken(room),
      room_name: room.room_name,
      domain: meetDomain()
    };
  });

  app.get("/meet/recordings", async (request) => {
    const session = await requirePermission(request, "appointments.read");
    const scope = await resolveCaseScope(db, session);
    const query = recordingQuery.parse(request.query);
    const result = await db.query<RecordingRow>(
      `SELECT recording.id,recording.file_path,recording.size_bytes,
              recording.started_at,recording.ended_at,recording.status
       FROM meet_recordings recording
       JOIN scheduling_appointments appointment
         ON appointment.id=recording.appointment_id AND appointment.tenant_id=recording.tenant_id
       WHERE recording.tenant_id=$1 AND recording.appointment_id=$2
         AND (${appointmentScopeCondition(scope, "appointment", "$3")})
       ORDER BY recording.created_at DESC,recording.id DESC`,
      [session.tenantId, query.appointment_id, scope.memberId]
    );
    return { recordings: result.rows.map(recordingPayload) };
  });

  app.get("/meet/recordings/:id/file", async (request, reply) => {
    const session = await requirePermission(request, "appointments.read");
    const scope = await resolveCaseScope(db, session);
    const { id } = recordingParams.parse(request.params);
    const result = await db.query<RecordingRow>(
      `SELECT recording.id,recording.file_path,recording.size_bytes,
              recording.started_at,recording.ended_at,recording.status
       FROM meet_recordings recording
       JOIN scheduling_appointments appointment
         ON appointment.id=recording.appointment_id AND appointment.tenant_id=recording.tenant_id
       WHERE recording.id=$1 AND recording.tenant_id=$2 AND recording.status='ready'
         AND (${appointmentScopeCondition(scope, "appointment", "$3")})`,
      [id, session.tenantId, scope.memberId]
    );
    const recording = result.rows[0];
    if (!recording) throw notFound("Gravação não encontrada");
    const candidate = resolveRecordingPath(config.MEET_RECORDINGS_DIR, recording.file_path);
    let rootReal: string;
    let fileReal: string;
    let actualSize: number;
    try {
      [rootReal, fileReal] = await Promise.all([realpath(config.MEET_RECORDINGS_DIR), realpath(candidate)]);
      const fileInfo = await lstat(fileReal);
      if (!fileInfo.isFile()) throw notFound("Gravação não encontrada");
      actualSize = fileInfo.size;
    } catch {
      throw notFound("Gravação não encontrada");
    }
    const withinRoot = relative(rootReal, fileReal);
    if (!withinRoot || withinRoot.startsWith("..")) throw notFound("Gravação não encontrada");
    const filename = basename(fileReal).replace(/["\\\r\n]/g, "_");
    const rangeHeader = request.headers.range;
    const range = typeof rangeHeader === "string" ? parseRecordingRange(rangeHeader, actualSize) : undefined;
    reply
      .header("content-type", recordingContentType(fileReal))
      .header("content-disposition", `inline; filename="${filename}"`)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("accept-ranges", "bytes");
    if (rangeHeader && !range) {
      return reply
        .status(416)
        .header("content-range", `bytes */${actualSize}`)
        .send();
    }
    if (range) {
      return reply
        .status(206)
        .header("content-range", `bytes ${range.start}-${range.end}/${actualSize}`)
        .header("content-length", String(range.end - range.start + 1))
        .send(createReadStream(fileReal, range));
    }
    return reply
      .header("content-length", String(actualSize))
      .send(createReadStream(fileReal));
  });
}
