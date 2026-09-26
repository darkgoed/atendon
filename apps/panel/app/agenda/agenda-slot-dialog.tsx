"use client";

import { X } from "@/components/icons";
import { ModalDialog } from "@/components/modal-dialog";
import { Button } from "@/components/ui";
import type { Slot } from "./agenda-types";

export function AgendaSlotDialog({ open, slot, onAddLead, onBlock, onClose }: {
  open: boolean; slot: Slot | null; onAddLead: () => void; onBlock: () => void; onClose: () => void;
}) {
  if (!open || !slot) return null;
  return <ModalDialog className="agenda-slot-dialog" labelledBy="agenda-slot-title" onClose={onClose}>
    <div className="agenda-dialog__header flex items-start justify-between gap-4"><div><h2 id="agenda-slot-title" className="mt-2">O que você deseja fazer?</h2></div><Button aria-label="Fechar" onClick={onClose}><X aria-hidden="true" /></Button></div>
    <div className="agenda-dialog__actions mt-5 grid gap-2"><Button tone="primary" className="w-full justify-center" onClick={onAddLead}>Adicionar lead</Button><Button className="w-full justify-center" onClick={onBlock}>Bloquear horário</Button><Button className="w-full justify-center" onClick={onClose}>Cancelar</Button></div>
  </ModalDialog>;
}
