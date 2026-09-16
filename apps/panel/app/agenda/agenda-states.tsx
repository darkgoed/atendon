import { WarningCircle } from "@phosphor-icons/react";
import { Button } from "@/components/ui";

export function AgendaLoading({ label }: { label: string }) {
  return (
    <div className="grid gap-3 py-6" aria-busy="true" aria-label={label} role="status">
      <span className="sr-only">{label}</span>
      <div className="skeleton h-14" aria-hidden="true" />
      <div className="skeleton h-24" aria-hidden="true" />
      <div className="skeleton h-24" aria-hidden="true" />
    </div>
  );
}

export function AgendaError({ message, onRetry, retrying = false }: { message: string; onRetry: () => void | Promise<unknown>; retrying?: boolean }) {
  return (
    <section className="grid justify-items-start gap-3 border-y border-[var(--warning-border)] bg-[var(--warning-subtle)] px-4 py-5 text-[var(--warning-text)]" role="alert">
      <div className="flex items-start gap-3"><WarningCircle className="mt-0.5 shrink-0" size={20} aria-hidden="true" /><div><strong className="block text-sm">Não foi possível carregar a agenda</strong><p className="mt-1 text-sm text-[var(--warning-text)]">{message}</p></div></div>
      <Button tone="danger" disabled={retrying} onClick={() => void onRetry()}>{retrying ? "Tentando novamente…" : "Tentar novamente"}</Button>
    </section>
  );
}
