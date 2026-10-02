"use client";

import * as RadixTooltip from "@radix-ui/react-tooltip";
import * as RadixSwitch from "@radix-ui/react-switch";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/* ========================================================== TOOLTIP == */

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>{children}</RadixTooltip.Provider>;
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  // Provider próprio: o Tooltip funciona em qualquer tela sem exigir um
  // TooltipProvider ancestral (providers aninhados são suportados pelo Radix).
  return (
    <RadixTooltip.Provider delayDuration={400} skipDelayDuration={200}>
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content side={side} sideOffset={6} collisionPadding={8} className="tooltip">
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

