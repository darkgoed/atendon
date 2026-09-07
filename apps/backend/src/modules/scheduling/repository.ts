import type { PoolClient } from "pg";

export type SchedulingUnitRow = {
  id: string; name: string; opening_time: string; closing_time: string; operating_days: number[];
  slot_duration_min: number; simultaneous_capacity: number; timezone: string;
};

/** Persistence seam: load the unit using the original SQL and parameter order. */
export async function loadSchedulingUnit(client: PoolClient, tenantId: string, unitId: string) {
  return client.query<SchedulingUnitRow>(
    `SELECT u.id,u.name,u.opening_time::text,u.closing_time::text,u.operating_days,u.slot_duration_min,u.simultaneous_capacity,t.timezone
     FROM scheduling_units u
     JOIN tenants t ON t.id=u.tenant_id
     WHERE u.tenant_id=$1 AND u.id=$2`, [tenantId, unitId]
  );
}

/** Persistence seam: serialize capacity checks without changing lock/query order. */
export async function lockAndLoadOverlappingAppointments(
  client: PoolClient,
  tenantId: string,
  unitId: string,
  start: Date,
  end: Date,
  exceptId?: string
) {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`schedule:${tenantId}:${unitId}`]);
  return client.query<{ start_at: Date; end_at: Date }>(
    `SELECT start_at,end_at FROM scheduling_appointments
     WHERE tenant_id=$1 AND unit_id=$2 AND status IN ('confirmado','reagendado')
       AND start_at < $4 AND end_at > $3 AND ($5::uuid IS NULL OR id <> $5)`,
    [tenantId, unitId, start.toISOString(), end.toISOString(), exceptId ?? null]
  );
}
