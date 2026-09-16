import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export type PanelProps = HTMLAttributes<HTMLElement> & {
  /** `bare` agrupa por spacing, sem moldura — preferível a empilhar bordas. */
  variant?: "default" | "elevated" | "sunken" | "bare";
  pad?: boolean;
};

/**
 * Superfície do design system. Um painel NÃO contém outro painel com borda —
 * seções internas usam `PanelSection` (divisor de 1px) ou apenas spacing.
 */
export const Panel = forwardRef<HTMLElement, PanelProps>(function Panel(
  { variant = "default", pad = false, className, ...props },
  ref
) {
  return (
    <section
      {...props}
      ref={ref}
      className={cn("panel", variant !== "default" && `panel--${variant}`, pad && "panel--pad", className)}
    />
  );
});

export const PanelHeader = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function PanelHeader({ className, ...props }, ref) {
  return <header {...props} ref={ref} className={cn("panel__header", className)} />;
});
export const PanelBody = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { flush?: boolean }>(function PanelBody({ flush = false, className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn("panel__body", flush && "panel__body--flush", className)} />;
});
export const PanelFooter = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function PanelFooter({ className, ...props }, ref) {
  return <footer {...props} ref={ref} className={cn("panel__footer", className)} />;
});
export const PanelSection = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(function PanelSection({ className, ...props }, ref) {
  return <div {...props} ref={ref} className={cn("panel__section", className)} />;
});

/** Nome herdado do painel padrão; mantido para não reescrever ~200 call sites. */
export const Card = forwardRef<HTMLElement, HTMLAttributes<HTMLElement>>(function Card({ className, ...props }, ref) {
  return <section {...props} ref={ref} className={cn("card", className)} />;
});

export type SectionProps = HTMLAttributes<HTMLElement> & {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

/** Bloco de conteúdo com cabeçalho semântico — sem moldura, separa por spacing. */
export const Section = forwardRef<HTMLElement, SectionProps>(function Section(
  { title, description, actions, children, className, ...props },
  ref
) {
  return (
    <section {...props} ref={ref} className={cn("ui-section", className)}>
      {(title || description || actions) && (
        <header className="ui-section__header">
          <div>
            {title && <h2>{title}</h2>}
            {description && <p className="sub">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
});

export const Divider = forwardRef<HTMLHRElement, HTMLAttributes<HTMLHRElement> & { strong?: boolean }>(function Divider(
  { strong = false, className, ...props },
  ref
) {
  return <hr {...props} ref={ref} className={cn("divider", strong && "divider--strong", className)} />;
});
