"use client";

import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Indicador de modo: barra flutuante no rodapé que avisa que um modo
 * temporário está ativo (bloquear horário, mover card…) e o que fazer a
 * seguir. Ajuda contextual no lugar da ação — não um tutorial à parte.
 *
 * `live` anuncia a barra para leitores de tela; deixe desligado quando a tela
 * já tem a própria live region para o mesmo modo (ex.: quadro do pipeline).
 */
export function ModeBar({ icon, title, description, onCancel, cancelLabel = "Cancelar", actions, live = false, className }: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  onCancel?: () => void;
  cancelLabel?: string;
  actions?: ReactNode;
  live?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("mode-bar", className)} {...(live ? { role: "status", "aria-live": "polite" as const } : {})}>
      {icon ? <span className="mode-bar__icon" aria-hidden="true">{icon}</span> : null}
      <span className="mode-bar__copy">
        <strong>{title}</strong>
        {description ? <span>{description}</span> : null}
      </span>
      {actions}
      {onCancel ? (
        <button type="button" className="mode-bar__cancel" onClick={onCancel}>
          {cancelLabel}<kbd aria-hidden="true">Esc</kbd>
        </button>
      ) : null}
    </div>
  );
}
