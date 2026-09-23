"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "@/components/icons";
import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type DialogSize = "sm" | "md" | "lg" | "xl";

export type DialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Ações do rodapé; alinhadas à direita, primária por último. */
  footer?: ReactNode;
  size?: DialogSize;
  /** Ações inline no cabeçalho, ao lado do fechar. */
  headerActions?: ReactNode;
  className?: string;
  children: ReactNode;
};

/**
 * Dialog do design system sobre Radix: foco preso, Esc/backdrop fecham, scroll
 * do body travado e `aria-*` corretos vêm do Radix — não reimplementamos nada
 * disso. O título é sempre visível (nunca só `sr-only`) porque um modal sem
 * título é um modal sem contexto.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  size = "md",
  headerActions,
  className,
  children
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="overlay-backdrop" />
        <RadixDialog.Content className={cn("dialog", size !== "md" && `dialog--${size}`, className)}>
          <header className="dialog__header">
            <div>
              <RadixDialog.Title className="dialog__title">{title}</RadixDialog.Title>
              {description ? <RadixDialog.Description className="dialog__description">{description}</RadixDialog.Description> : null}
            </div>
            <div className="cluster">
              {headerActions}
              <RadixDialog.Close className="btn quiet icon-button icon-button--sm" aria-label="Fechar">
                <X size={16} aria-hidden="true" />
              </RadixDialog.Close>
            </div>
          </header>
          <div className="dialog__body">{children}</div>
          {footer ? <footer className="dialog__footer">{footer}</footer> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

export const DialogClose = RadixDialog.Close;
