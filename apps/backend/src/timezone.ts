type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string) {
  let value = formatters.get(timeZone);
  if (!value) {
    value = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    formatters.set(timeZone, value);
  }
  return value;
}

export function isValidIanaTimeZone(timeZone: string) {
  try {
    formatter(timeZone).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

export function zonedParts(value: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timeZone).formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)])
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second
  };
}

function offsetAt(value: Date, timeZone: string) {
  const parts = zonedParts(value, timeZone);
  const wholeSecond = Math.floor(value.getTime() / 1_000) * 1_000;
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - wholeSecond;
}

export function localDateTimeToUtc(date: string, time: string, timeZone: string) {
  if (!isValidIanaTimeZone(timeZone)) throw new RangeError(`Fuso horário IANA inválido: ${timeZone}`);
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsets = new Set<number>();
  for (const dayOffset of [-2, -1, 0, 1, 2]) {
    offsets.add(offsetAt(new Date(localEpoch + dayOffset * 86_400_000), timeZone));
  }
  const candidates = [...offsets]
    .map((offset) => new Date(localEpoch - offset))
    .filter((candidate) => {
      const parts = zonedParts(candidate, timeZone);
      return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
    })
    .sort((left, right) => left.getTime() - right.getTime());
  if (!candidates[0]) throw new RangeError(`Horário local inexistente em ${timeZone}: ${date} ${time}`);
  return candidates[0];
}

export function localDateKey(value: Date, timeZone: string) {
  const parts = zonedParts(value, timeZone);
  return `${parts.year.toString().padStart(4, "0")}-${parts.month.toString().padStart(2, "0")}-${parts.day.toString().padStart(2, "0")}`;
}

export function localWeekday(value: Date, timeZone: string) {
  const parts = zonedParts(value, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}
