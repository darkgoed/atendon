import { CalendarX, Plus } from "@/components/icons";
import { Button, PageHeader } from "@/components/ui";
import type { AppointmentView } from "./agenda-types";

export function AgendaHeader({ canCreate, canBlock, blocking = false, unit, mode, view, pendingCount, onCreate, onBlock, onMode, onView }: {
  canCreate: boolean;
  canBlock: boolean;
  /** Modo bloqueio ativo: o botão vira "Cancelar bloqueio". */
  blocking?: boolean;
  unit: string;
  mode: "day" | "week" | "month";
  view: AppointmentView;
  pendingCount: number;
  onCreate: () => void;
  onBlock: () => void;
  onMode: (mode: "day" | "week" | "month") => void;
  onView: (view: AppointmentView) => void;
}) {
  return (
    <PageHeader
      className="agenda-head"
      title="Agenda"
      actions={<div className="agenda-head__actions">
        {canBlock ? (
          <Button
            className={`agenda-head__action${blocking ? " is-blocking" : ""}`}
            onClick={onBlock}
            aria-pressed={mode === "month" ? undefined : blocking}
            title={blocking ? "Sair do modo bloqueio (Esc)" : mode === "month" ? "Bloquear um período" : "Clique depois em um horário livre da grade"}
            icon={<CalendarX size={15} aria-hidden="true" />}
          >
            {blocking ? "Cancelar bloqueio" : "Bloquear horário"}
          </Button>
        ) : null}
        {canCreate ? (
          <Button tone="primary" className="agenda-head__action" disabled={!unit} onClick={onCreate} icon={<Plus size={15} aria-hidden="true" />}>
            Novo agendamento
          </Button>
        ) : null}
        <div className="agenda-head__toggle" role="group" aria-label="Visualização da agenda">
          {(["day", "week", "month"] as const).map((option) => (
            <button type="button" key={option} aria-pressed={mode === option} className={mode === option ? "is-active" : ""} onClick={() => onMode(option)}>
              {option === "day" ? "Dia" : option === "week" ? "Semana" : "Mês"}
            </button>
          ))}
        </div>
        <div className="agenda-head__toggle agenda-head__toggle--filters" role="group" aria-label="Filtrar agendamentos por situação">
          {([["all", "Todos"], ["active", "Ativos"], ["pending", "Resultado pendente"], ["finished", "Finalizados"]] as const).map(([value, label]) => (
            <button type="button" key={value} aria-pressed={view === value} className={`${view === value ? "is-active" : ""} ${value === "pending" && pendingCount > 0 ? "has-pending" : ""}`} onClick={() => onView(value)}>
              {label}{value === "pending" ? <span className="mono">({pendingCount})</span> : null}
            </button>
          ))}
        </div>
      </div>}
    />
  );
}
