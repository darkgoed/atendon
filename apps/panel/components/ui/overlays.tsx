"use client";

import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import * as RadixSwitch from "@radix-ui/react-switch";
import * as RadixCheckbox from "@radix-ui/react-checkbox";
import * as RadixTabs from "@radix-ui/react-tabs";
import * as RadixToggleGroup from "@radix-ui/react-toggle-group";
import { Check, Minus } from "@/components/icons";
import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/* ============================================================= MENU ==
   Dropdown sobre Radix: portal (escapa qualquer overflow:hidden),
   navegação por teclado, tipo-para-buscar e colisão com a viewport. */

export type MenuProps = {
  trigger: ReactNode;
  children: ReactNode;
  align?: "start" | "center" | "end";
  className?: string;
};

export function Menu({ trigger, children, align = "end", className }: MenuProps) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild>{trigger}</RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content align={align} sideOffset={6} collisionPadding={8} className={cn("menu", className)}>
          {children}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  );
}

export const MenuItem = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RadixMenu.Item> & { tone?: "default" | "danger" }>(
  function MenuItem({ tone = "default", className, ...props }, ref) {
    return <RadixMenu.Item {...props} ref={ref} className={cn("menu__item", tone === "danger" && "menu__item--danger", className)} />;
  }
);

export const MenuLabel = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RadixMenu.Label>>(
  function MenuLabel({ className, ...props }, ref) {
    return <RadixMenu.Label {...props} ref={ref} className={cn("menu__label", className)} />;
  }
);

export const MenuSeparator = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RadixMenu.Separator>>(
  function MenuSeparator({ className, ...props }, ref) {
    return <RadixMenu.Separator {...props} ref={ref} className={cn("menu__separator", className)} />;
  }
);

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

/* ========================================================= CHECKBOX == */

export const Checkbox = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof RadixCheckbox.Root>>(
  function Checkbox({ className, ...props }, ref) {
    return (
      <RadixCheckbox.Root {...props} ref={ref} className={cn("checkbox", className)}>
        <RadixCheckbox.Indicator>
          {props.checked === "indeterminate" ? <Minus size={11} weight="bold" aria-hidden="true" /> : <Check size={11} weight="bold" aria-hidden="true" />}
        </RadixCheckbox.Indicator>
      </RadixCheckbox.Root>
    );
  }
);

/* ============================================================= TABS ==
   Abas reais (Radix) com a aparência do segmented control: seleção por
   superfície, não por sublinhado grosso. */

export const Tabs = RadixTabs.Root;

export const TabsList = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RadixTabs.List>>(
  function TabsList({ className, ...props }, ref) {
    return <RadixTabs.List {...props} ref={ref} className={cn("segmented", className)} />;
  }
);

export const TabsTrigger = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof RadixTabs.Trigger>>(
  function TabsTrigger({ className, ...props }, ref) {
    return <RadixTabs.Trigger {...props} ref={ref} className={className} />;
  }
);

export const TabsContent = RadixTabs.Content;

/* ==================================================== TOGGLE GROUP ==
   Troca de visão/período: um controle, não uma fileira de botões. */

export const ToggleGroup = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<typeof RadixToggleGroup.Root>>(
  function ToggleGroup({ className, ...props }, ref) {
    return <RadixToggleGroup.Root {...props} ref={ref} className={cn("segmented", className)} />;
  }
);

export const ToggleGroupItem = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof RadixToggleGroup.Item>>(
  function ToggleGroupItem({ className, ...props }, ref) {
    return <RadixToggleGroup.Item {...props} ref={ref} className={cn("segmented__item", className)} />;
  }
);
