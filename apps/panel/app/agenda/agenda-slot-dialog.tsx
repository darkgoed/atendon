"use client";

import { X } from "@phosphor-icons/react";
import { ModalDialog } from "@/components/modal-dialog";
import type { Slot } from "./agenda-types";

export function AgendaSlotDialog({ open, slot, onAddLead, onBlock, onClose }: {
  open: boolean; slot: Slot | null; onAddLead: () => void; onBlock: () => void; onClose: () => void;
}) {
  if (!open || !slot) return null;
  return <ModalDialog labelledBy="agenda-slot-title" onClose={onClose}>
    <div className="flex items-start justify-between gap-4"><div><span className="eyebrow">AÇÃO NO HORÁRIO</span><h2 id="agenda-slot-title" className="mt-2">O que você deseja fazer?</h2></div><button type="button" className="btn" aria-label="Fechar" onClick={onClose}><X aria-hidden="true" /></button></div>
    <div className="mt-5 grid gap-2"><button type="button" className="btn primary w-full justify-center" onClick={onAddLead}>Adicionar lead</button><button type="button" className="btn w-full justify-center" onClick={onBlock}>Bloquear horário</button><button type="button" className="btn w-full justify-center" onClick={onClose}>Cancelar</button></div>
  </ModalDialog>;
}
