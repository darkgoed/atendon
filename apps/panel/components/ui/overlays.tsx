"use client";

import * as RadixTooltip from "@radix-ui/react-tooltip";
import * as RadixSwitch from "@radix-ui/react-switch";
import { useEffect, useRef, useState, forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/* ========================================================== TOOLTIP == */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({ content, children, side = "top", align = "center", compact = false }: { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left"; align?: "start" | "center" | "end"; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const escaped = useRef(false);
  useEffect(() => {
    if (!hovered) return;
    const cancelPendingHover = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      escaped.current = true;
      setOpen(false);
    };
    document.addEventListener("keydown", cancelPendingHover);
    return () => document.removeEventListener("keydown", cancelPendingHover);
  }, [hovered]);
  // Provider próprio: o Tooltip funciona em qualquer tela sem exigir um
  // TooltipProvider ancestral (providers aninhados são suportados pelo Radix).
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
    <RadixTooltip.Root open={open} onOpenChange={(next) => { if (!next || !escaped.current) setOpen(next); }}>
      <RadixTooltip.Trigger asChild
        onPointerMove={() => setHovered(true)}
        onPointerLeave={() => { setHovered(false); escaped.current = false; }}
        onFocus={() => { escaped.current = false; }}
      >{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} align={align} sideOffset={6} collisionPadding={8} className={cn("tooltip", compact && "tooltip--compact")}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}

/* =========================================================== SWITCH == */

export type SwitchProps = ComponentPropsWithoutRef<typeof RadixSwitch.Root> & { label?: string };

export const Switch = forwardRef<HTMLButtonElement, SwitchProps>(function Switch({ label, className, ...props }, ref) {
  return (
    <RadixSwitch.Root {...props} ref={ref} aria-label={props["aria-label"] ?? label} className={cn("switch", className)}>
      <RadixSwitch.Thumb className="switch__thumb" />
    </RadixSwitch.Root>
  );
});

