import type { Appointment } from "./agenda-types";
import { dayKey } from "./agenda-utils";
import { Button } from "@/components/ui";

export function AgendaMonth({ days, appointments, today, onSelect }: { days: Date[]; appointments: Appointment[]; today: string; onSelect: (date: string) => void }) {
  const grouped = new Map<string, Appointment[]>();
  appointments.forEach((item) => { const key = dayKey(new Date(item.start)); grouped.set(key, [...(grouped.get(key) ?? []), item]); });
  return <section className="agenda-month" aria-label="Visão mensal">
    {days.map((day) => { const key = dayKey(day); const items = grouped.get(key) ?? []; return <Button key={key} className={`agenda-month__day ${key === today ? "is-today" : ""}`} onClick={() => onSelect(key)} aria-label={`${day.toLocaleDateString("pt-BR", { timeZone: "UTC", dateStyle: "full" })}, ${items.length} agendamentos`}>
      <span className="agenda-month__weekday">{day.toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "short" })}</span><strong className="mono">{day.getUTCDate()}</strong><span className="agenda-month__summary">{items.length ? `${items.length} agendamento${items.length > 1 ? "s" : ""}` : "Livre"}</span>
    </Button>; })}
  </section>;
}
