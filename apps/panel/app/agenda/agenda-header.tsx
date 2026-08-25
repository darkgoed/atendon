import { CalendarX, Plus } from "@phosphor-icons/react";
import type { AppointmentView } from "./agenda-types";

export function AgendaHeader({ canCreate, canBlock, unit, mode, view, pendingCount, onCreate, onBlock, onMode, onView }: {
  canCreate: boolean;
  canBlock: boolean;
  unit: string;
  mode: "day" | "week";
  view: AppointmentView;
  pendingCount: number;
  onCreate: () => void;
  onBlock: () => void;
  onMode: (mode: "day" | "week") => void;
  onView: (view: AppointmentView) => void;
}) {
  return (
    <header className="pagehead agenda-head" style={{ "--eyebrow": '"PAINEL · ATENDIMENTO"' } as React.CSSProperties}>
      <div className="agenda-head__identity">
        <div className="flex items-center gap-2.5">
          <h1>Agenda</h1>
          <span className="agenda-head__code mono">AG—01</span>
        </div>
        <p className="agenda-head__description">Clique em um horário livre para agendar um lead.</p>
      </div>
      <div className="agenda-head__actions">
        {canBlock ? (
          <button type="button" className="btn active:scale-[.98]" onClick={onBlock}>
            <CalendarX size={15} aria-hidden="true" />
            Bloquear horário
          </button>
        ) : null}
        {canCreate ? (
          <button type="button" className="btn primary active:scale-[.98]" disabled={!unit} onClick={onCreate}>
            <Plus size={15} aria-hidden="true" />
            Novo agendamento
          </button>
        ) : null}
        <div className="agenda-head__toggle" role="group" aria-label="Visualização da agenda">
          {(["day", "week"] as const).map((option) => (
            <button
              type="button"
              key={option}
              aria-pressed={mode === option}
              className={mode === option ? "is-active" : ""}
              onClick={() => onMode(option)}
            >
              {option === "day" ? "Dia" : "Semana"}
            </button>
          ))}
        </div>
        <div className="agenda-head__toggle agenda-head__toggle--filters" role="group" aria-label="Filtrar agendamentos por situação">
          {([
            ["all", "Todos"],
            ["active", "Ativos"],
            ["pending", "Resultado pendente"],
            ["finished", "Finalizados"]
          ] as const).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={view === value}
              className={`${view === value ? "is-active" : ""} ${value === "pending" && pendingCount > 0 ? "has-pending" : ""}`}
              onClick={() => onView(value)}
            >
              {label}{value === "pending" ? <span className="mono">({pendingCount})</span> : null}
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
