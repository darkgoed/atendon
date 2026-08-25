import { randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { config } from "../../config.js";
import { db } from "../../db/client.js";
import { createJitsiToken } from "./jitsi-token.js";

export interface MeetRoomRow {
  id: string;
  tenant_id: string;
  room_name: string;
  public_code: string;
  appointment_id: string | null;
  created_at: Date;
  expires_at: Date;
}

export interface MeetRoomIdentity {
  roomName: string;
  publicCode: string;
}

export function createMeetRoomIdentity(): MeetRoomIdentity {
  return {
    roomName: `atendon-${randomBytes(16).toString("hex")}`,
    publicCode: randomBytes(24).toString("base64url")
  };
}

export function participantJoinUrl(publicCode: string): string {
  return new URL(`/reuniao/${encodeURIComponent(publicCode)}`, config.PANEL_PUBLIC_URL).toString();
}

export async function insertMeetRoom(
  client: Pick<PoolClient, "query">,
  tenantId: string,
  appointmentId: string | null,
  identity: MeetRoomIdentity = createMeetRoomIdentity()
): Promise<MeetRoomRow> {
  if (appointmentId) {
    const appointment = await client.query<{ id: string }>(
      "SELECT id FROM scheduling_appointments WHERE id=$1 AND tenant_id=$2",
      [appointmentId, tenantId]
    );
    if (!appointment.rows[0]) throw Object.assign(new Error("Agendamento não encontrado"), { statusCode: 404 });
  }
  const result = await client.query<MeetRoomRow>(
    `INSERT INTO meet_rooms(tenant_id,room_name,public_code,appointment_id)
     VALUES($1,$2,$3,$4)
     RETURNING id,tenant_id,room_name,public_code,appointment_id,created_at,expires_at`,
    [tenantId, identity.roomName, identity.publicCode, appointmentId]
  );
  return result.rows[0];
}

export async function createMeetRoom(tenantId: string, appointmentId: string | null): Promise<MeetRoomRow> {
  return insertMeetRoom(db, tenantId, appointmentId);
}

export async function findTenantRoom(tenantId: string, roomId: string): Promise<MeetRoomRow | null> {
  const result = await db.query<MeetRoomRow>(
    `SELECT room.id,room.tenant_id,room.room_name,room.public_code,
            room.appointment_id,room.created_at,room.expires_at
     FROM meet_rooms room
     WHERE room.id=$1 AND room.tenant_id=$2
       AND (
         (room.appointment_id IS NULL AND room.expires_at>now())
         OR EXISTS (
           SELECT 1 FROM scheduling_appointments appointment
           WHERE appointment.id=room.appointment_id
             AND appointment.tenant_id=room.tenant_id
             AND appointment.status IN ('confirmado','reagendado')
             AND appointment.end_at + interval '24 hours'>now()
         )
       )`,
    [roomId, tenantId]
  );
  return result.rows[0] ?? null;
}

export async function findPublicRoom(publicCode: string): Promise<MeetRoomRow | null> {
  const result = await db.query<MeetRoomRow>(
    `SELECT id,tenant_id,room_name,public_code,appointment_id,created_at,expires_at
     FROM meet_rooms room
     WHERE public_code=$1
       AND (
         (appointment_id IS NULL AND expires_at>now())
         OR EXISTS (
           SELECT 1 FROM scheduling_appointments appointment
           WHERE appointment.id=room.appointment_id
             AND appointment.tenant_id=room.tenant_id
             AND appointment.status IN ('confirmado','reagendado')
             AND appointment.end_at + interval '24 hours'>now()
         )
       )`,
    [publicCode]
  );
  return result.rows[0] ?? null;
}

export function meetDomain(): string {
  return new URL(config.MEET_PUBLIC_URL).origin;
}

export async function moderatorToken(room: MeetRoomRow, user: { id: string; name: string; email?: string }): Promise<string> {
  return createJitsiToken({
    appId: config.MEET_JWT_APP_ID,
    secret: config.MEET_JWT_SECRET,
    publicUrl: config.MEET_PUBLIC_URL,
    roomName: room.room_name,
    role: "moderator",
    user
  });
}

export async function participantToken(room: MeetRoomRow): Promise<string> {
  return createJitsiToken({
    appId: config.MEET_JWT_APP_ID,
    secret: config.MEET_JWT_SECRET,
    publicUrl: config.MEET_PUBLIC_URL,
    roomName: room.room_name,
    role: "participant",
    user: { id: `participant-${randomBytes(12).toString("hex")}`, name: "Participante" }
  });
}
