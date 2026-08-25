export type ConversationSchedulingSlot = {
  start: string;
  end: string;
  vagas: number;
  capacidade: number;
};

export function isoDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function shiftIsoDay(value: string, amount: number): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return isoDay(date);
}

export function availableConversationSlots(
  slots: ConversationSchedulingSlot[],
  now = new Date()
): ConversationSchedulingSlot[] {
  return futureConversationSlots(slots, now).filter((slot) => slot.vagas > 0);
}

export function futureConversationSlots(
  slots: ConversationSchedulingSlot[],
  now = new Date()
): ConversationSchedulingSlot[] {
  const threshold = now.getTime();
  return slots
    .filter((slot) => new Date(slot.start).getTime() > threshold)
    .sort((left, right) => new Date(left.start).getTime() - new Date(right.start).getTime());
}

export function formatConversationSlot(
  value: string,
  timezone: string,
  options: { includeDate?: boolean } = {}
): string {
  const date = new Date(value);
  const time = date.toLocaleTimeString("pt-BR", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit"
  });
  if (!options.includeDate) return time;
  return `${date.toLocaleDateString("pt-BR", {
    timeZone: timezone,
    weekday: "long",
    day: "2-digit",
    month: "long"
  })} às ${time}`;
}
