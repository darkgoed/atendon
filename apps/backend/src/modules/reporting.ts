import { localDateKey, localDateTimeToUtc, localWeekday } from "../timezone.js";

export type ReportingPeriod = "today" | "week" | "month" | "custom";
export type ReportingInput = { period: ReportingPeriod; start?: string; end?: string; now?: Date };
export type ReportingRange = { startKey: string; endKey: string; start: Date; end: Date; todayStart: Date; todayEnd: Date };

export function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
function firstDayOfMonth(dateKey: string) { return `${dateKey.slice(0, 7)}-01`; }

export function resolveReportingRange(timezone: string, input: ReportingInput): ReportingRange {
  const now = input.now ?? new Date();
  const today = localDateKey(now, timezone);
  let startKey = today;
  let endKey = shiftDateKey(today, 1);
  if (input.period === "week") {
    const weekday = localWeekday(now, timezone);
    startKey = shiftDateKey(today, -(weekday === 0 ? 6 : weekday - 1));
    endKey = shiftDateKey(startKey, 7);
  } else if (input.period === "month") {
    startKey = firstDayOfMonth(today);
    const [year, month] = startKey.split("-").map(Number);
    endKey = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  } else if (input.period === "custom") {
    if (!input.start || !input.end) throw Object.assign(new Error("Informe as datas inicial e final"), { statusCode: 400 });
    if (input.end < input.start) throw Object.assign(new Error("A data final deve ser igual ou posterior à inicial"), { statusCode: 400 });
    const days = Math.round((Date.parse(`${input.end}T00:00:00.000Z`) - Date.parse(`${input.start}T00:00:00.000Z`)) / 86_400_000);
    if (days > 365) throw Object.assign(new Error("O período personalizado pode ter no máximo 366 dias"), { statusCode: 400 });
    startKey = input.start;
    endKey = shiftDateKey(input.end, 1);
  }
  return { startKey, endKey, start: localDateTimeToUtc(startKey, "00:00", timezone), end: localDateTimeToUtc(endKey, "00:00", timezone), todayStart: localDateTimeToUtc(today, "00:00", timezone), todayEnd: localDateTimeToUtc(shiftDateKey(today, 1), "00:00", timezone) };
}

export type ReportingCaseScope = { type: "mine"; memberId: string } | { type: "workspace" };
export function reportingScopeParams(scope: ReportingCaseScope, tenantId: string) {
  return [tenantId, scope.type === "workspace", scope.type === "mine" ? scope.memberId : null] as const;
}
export function capReportingLimit(limit: number | undefined, cap = 100) {
  return Math.min(Math.max(Math.trunc(limit ?? 20), 1), cap);
}
