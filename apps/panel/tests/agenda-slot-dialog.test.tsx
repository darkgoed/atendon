import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("@/components/modal-dialog", () => ({ ModalDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
import { AgendaSlotDialog } from "@/app/agenda/agenda-slot-dialog";
import { AgendaTimeBlockDialog } from "@/app/agenda/agenda-time-blocks";

describe("agenda slot contextual actions", () => {
  const slot = { start: "2026-08-26T12:00:00.000Z", end: "2026-08-26T13:00:00.000Z", vagas: 1, capacidade: 1 };
  it("renderiza as duas opções exatas", () => {
    const html = renderToStaticMarkup(<AgendaSlotDialog open slot={slot} onAddLead={vi.fn()} onBlock={vi.fn()} onClose={vi.fn()} />);
    expect(html).toContain("Adicionar lead"); expect(html).toContain("Bloquear horário");
  });
  it("expõe motivo obrigatório e seleção recorrente de dias", () => {
    const html = renderToStaticMarkup(<AgendaTimeBlockDialog open anchor="2026-08-26" timezone="America/Sao_Paulo" onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(html).toContain("Motivo (obrigatório)"); expect(html).toContain("required"); expect(html).toContain("Recorrente");
  });
});
