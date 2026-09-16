import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

type StateProps = HTMLAttributes<HTMLDivElement>;

/**
 * Estados vazio/erro/carregando compartilham a mesma composição: ícone
 * opcional, título, corpo, ação. Sem moldura tracejada — spacing + cor bastam.
 */
export const EmptyState = forwardRef<HTMLDivElement, StateProps & { title?: ReactNode; icon?: ReactNode; action?: ReactNode; inline?: boolean }>(
  function EmptyState({ title, icon, action, inline = false, children, className, ...props }, ref) {
    return (
      <div {...props} ref={ref} className={cn("empty", inline && "empty--inline", className)} role="status">
        {icon && <span className="empty__icon" aria-hidden="true">{icon}</span>}
        {title && <strong className="empty__title">{title}</strong>}
        {children && <div>{children}</div>}
        {action}
      </div>
    );
  }
);

export const ErrorState = forwardRef<HTMLDivElement, StateProps & { title?: ReactNode; icon?: ReactNode; action?: ReactNode; inline?: boolean }>(
  function ErrorState({ title = "Algo deu errado", icon, action, inline = false, children, className, ...props }, ref) {
    return (
      <div {...props} ref={ref} className={cn("error", inline && "error--inline", className)} role="alert">
        {icon && <span className="error__icon" aria-hidden="true">{icon}</span>}
        <strong className="error__title">{title}</strong>
        {children && <div>{children}</div>}
        {action}
      </div>
    );
  }
);

export const LoadingState = forwardRef<HTMLDivElement, StateProps & { label?: string; inline?: boolean }>(
  function LoadingState({ label = "Carregando conteúdo", inline = false, className, ...props }, ref) {
    return (
      <div
        {...props}
        ref={ref}
        className={cn("loading-state", inline && "loading-state--inline", className)}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <span className="sr-only">{label}</span>
        <div className="skeleton" aria-hidden="true" />
      </div>
    );
  }
);

/** Barra de progresso determinada (0–100). Para indeterminado use Spinner. */
export const Progress = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { value: number; label?: string }>(
  function Progress({ value, label, className, ...props }, ref) {
    const clamped = Math.max(0, Math.min(100, value));
    return (
      <div
        {...props}
        ref={ref}
        className={cn("progress", className)}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={clamped}
        aria-label={label}
      >
        <div className="progress__bar" style={{ width: `${clamped}%` }} />
      </div>
    );
  }
);

export const Spinner = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & { label?: string }>(
  function Spinner({ label = "Carregando", className, ...props }, ref) {
    return (
      <span {...props} ref={ref} className={cn("spinner", className)} role="status" aria-label={label} />
    );
  }
);

export const Skeleton = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement> & { variant?: "block" | "text" | "title" }>(
  function Skeleton({ variant = "block", className, ...props }, ref) {
    return <div {...props} ref={ref} aria-hidden="true" className={cn("skeleton", variant !== "block" && `skeleton--${variant}`, className)} />;
  }
);
