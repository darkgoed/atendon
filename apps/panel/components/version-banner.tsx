"use client";

import { CheckCircle, Sparkle, X } from "@/components/icons";
import { ModalDialog } from "@/components/modal-dialog";
import type { VersionInfo } from "@/lib/api";

export function VersionBanner({
  versionInfo,
  isOpen,
  onClose
}: {
  versionInfo: VersionInfo | null;
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen || !versionInfo) return null;

  const currentVersion = versionInfo.version;
  const hasKnownVersion = typeof currentVersion === "string" && currentVersion.trim().length > 0;
  const currentChangelog = versionInfo.changelog.find((item) => item.version === currentVersion)
    ?? versionInfo.changelog[0];

  const handleClose = () => {
    try {
      localStorage.setItem("atendon_last_seen_version", currentVersion);
    } catch {
      // Ignora falhas de localStorage (modo privado/restrito)
    }
    onClose();
  };

  return (
    <ModalDialog
      labelledBy="version-banner-title"
      describedBy="version-banner-desc"
      onClose={handleClose}
      className="max-w-lg"
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--primary-subtle)] text-[var(--primary)]">
              <Sparkle size={20} weight="fill" />
            </span>
            <div>
              <h2 id="version-banner-title" className="text-lg font-semibold text-[var(--text)]">
                O que há de novo
              </h2>
              <p id="version-banner-desc" className="text-xs text-[var(--text-secondary)]">
                {hasKnownVersion ? <>Novidades da versão <strong className="mono text-[var(--primary-text)]">v{currentVersion}</strong></> : "Novidades da versão implantada"}
                {currentChangelog?.date ? ` (${currentChangelog.date})` : ""}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-md p-1 text-[var(--text-secondary)] hover:bg-[var(--surface-active)] hover:text-[var(--text)] transition"
            aria-label="Fechar novidades"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-72 overflow-y-auto space-y-4 pr-1" tabIndex={0}>
          {currentChangelog && currentChangelog.changes.length > 0 ? (
            <div className="space-y-2">
              <span className="text-xs font-medium text-[var(--text-muted)]">
                Mudanças nesta versão
              </span>
              <ul className="space-y-2">
                {currentChangelog.changes.map((change, index) => (
                  <li key={index} className="flex items-start gap-2.5 text-sm text-[var(--text-secondary)]">
                    <CheckCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-[var(--success-text)]" />
                    <span>{change}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-[var(--text-secondary)]">
              {hasKnownVersion ? <>O sistema foi atualizado para a versão <span className="mono">v{currentVersion}</span> com melhorias gerais de desempenho e segurança.</> : "A versão implantada está sendo identificada. Consulte novamente em instantes."}
            </p>
          )}

          {versionInfo.changelog.length > 1 && (
            <div className="pt-3 border-t border-[var(--border)] space-y-3">
              <span className="text-xs font-medium text-[var(--text-muted)]">
                Histórico recente
              </span>
              {versionInfo.changelog
                .filter((item) => item.version !== currentVersion)
                .slice(0, 3)
                .map((item) => (
                  <div key={item.version} className="rounded-lg bg-[var(--surface-active)] p-3 text-xs">
                    <div className="flex items-center justify-between font-mono font-medium text-[var(--text-secondary)] mb-1">
                      <span>v{item.version}</span>
                      <span className="type-caption text-[var(--text-muted)]">{item.date}</span>
                    </div>
                    <ul className="list-disc list-inside space-y-0.5 text-[var(--text-secondary)]">
                      {item.changes.map((change, cIdx) => (
                        <li key={cIdx}>{change}</li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          )}
        </div>

        <div className="pt-2 flex justify-end">
          <button
            type="button"
            onClick={handleClose}
            className="btn font-medium px-5"
            data-autofocus
          >
            Entendi
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
