"use client";

import * as RadixPopover from "@radix-ui/react-popover";
import { useRef, useState, type ReactNode } from "react";
import { Question } from "@/components/icons";
import { cn } from "@/lib/cn";

/**
 * Ajuda contextual inline: um ícone de ajuda discreto ao lado do rótulo que explica o
 * campo/controle no lugar onde a dúvida surge. Abre no clique/toque (funciona
 * no celular) e também ao repousar o mouse; Esc ou clique fora fecham.
 *
 * `label` é o nome acessível do botão ("Ajuda: Tempo de espera"); `title`
 * vira o cabeçalho opcional do balão.
 */
export function HelpHint({ label, title, children, side = "top", align = "center", className }: {
  label: string;
  title?: ReactNode;
  children: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const hoverTimer = useRef<number | null>(null);
  const clearHover = () => {
    if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current);
    hoverTimer.current = null;
  };
  return (
    <RadixPopover.Root open={open} onOpenChange={setOpen}>
      <RadixPopover.Trigger asChild>
        <button
          type="button"
          className={cn("help-hint", className)}
          aria-label={label}
          onPointerEnter={(event) => {
            if (event.pointerType !== "mouse") return;
            clearHover();
            hoverTimer.current = window.setTimeout(() => setOpen(true), 350);
          }}
          onPointerLeave={clearHover}
        >
          <Question size={15} aria-hidden="true" />
        </button>
      </RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="help-hint__panel"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          {title ? <strong className="help-hint__title">{title}</strong> : null}
          <div className="help-hint__body">{children}</div>
          <RadixPopover.Arrow className="help-hint__arrow" width={10} height={5} />
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
