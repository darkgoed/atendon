export function localMinute(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

export function localDay(value: Date, timezone: string): string {
  return localMinute(value.toISOString(), timezone).slice(0, 10);
}

export function instantFromLocalMinute(value: string, timezone: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";

  const desired = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  );
  let candidate = desired;
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const represented = localMinute(new Date(candidate).toISOString(), timezone);
    const representedMatch = represented.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
    if (!representedMatch) return "";
    const representedUtc = Date.UTC(
      Number(representedMatch[1]),
      Number(representedMatch[2]) - 1,
      Number(representedMatch[3]),
      Number(representedMatch[4]),
      Number(representedMatch[5])
    );
    candidate += desired - representedUtc;
  }

  const result = new Date(candidate).toISOString();
  return localMinute(result, timezone) === value ? result : "";
}

export function defaultManualAppointmentStart(
  anchorDay: string,
  timezone: string,
  now = new Date()
): string {
  const nowLocal = localMinute(now.toISOString(), timezone);
  const today = nowLocal.slice(0, 10);
  const targetDay = anchorDay < today ? today : anchorDay;
  const localWallClock = new Date(
    `${targetDay === today ? nowLocal : `${targetDay}T09:00`}:00.000Z`
  );
  if (targetDay === today) {
    localWallClock.setUTCMinutes(
      Math.ceil((localWallClock.getUTCMinutes() + 1) / 15) * 15,
      0,
      0
    );
  }
  return instantFromLocalMinute(localWallClock.toISOString().slice(0, 16), timezone);
}
