"use client";

import { CheckCircle, Prohibit, RailIcons, type Icon as HandoffIcon } from "@/components/icons";
import Link from "next/link";
import { type ComponentType, type ReactNode } from "react";
import { BrandMark } from "@/components/brand-mark";
import { PopoverMenu } from "@/components/popover-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { Tooltip, TooltipProvider } from "@/components/ui";
import { panelManifestGroups } from "@/lib/panel-manifest";

/**
 * NavRail 64px (port visual do shell — SPEC v7, onda 1).
 *
 * Referência visual 1:1 do donor (crm-whatsapp): coluna de ícones com logo em
 * tile, itens de 40px arredondados, ativo com tint da marca, tooltips à
 * direita e rodapé com tema + sair. A FONTE DE DADOS continua sendo o manifest
 * do AtendON (lib/panel-manifest.ts): nenhum href, label ou gating novo aqui —
 * este componente só recebe itens JÁ filtrados pelo Shell e os veste.
 *
 * Partição rail: itens primários fixos (SPEC) + trigger "mais" com o resto
 * agrupado pelos grupos do manifest. `splitRailItems` é puro e testado.
 */

export type RailIcon = ComponentType<{ size?: number; "aria-hidden"?: boolean }>;

export type RailMenuItem = {
  href: string;
  label: string;
  group: string;
  Icon: RailIcon;
};

export type RailPrimaryItem = {
  href: string;
  label: string;
  active: boolean;
  count?: number;
};

export type RailMoreGroup = {
  label: string;
  items: Array<{ href: string; label: string; Icon: RailIcon; active: boolean }>;
};

export type RailAvailability = {
  available: boolean;
  pending: boolean;
  onToggle: () => void;
};

/** Ordem aprovada na SPEC: os primários do rail, na ordem do donor. */
export const railPrimaryHrefs = ["/", "/conversas", "/contatos", "/pipeline", "/tarefas", "/fluxos", "/agenda"] as const;

/* Glifos do rail copiados do handoff (handoff/referencia/*.dc.html, RAIL/RAIL_B):
   18px, traço 1.8 — ver components/icons.tsx. */
const PRIMARY_ICONS: Record<string, HandoffIcon> = {
  "/": RailIcons.painel,
  "/conversas": RailIcons.conversas,
  "/contatos": RailIcons.contatos,
  "/pipeline": RailIcons.pipeline,
  "/tarefas": RailIcons.tarefas,
  "/fluxos": RailIcons.agentes,
  "/agenda": RailIcons.agenda
};
const RAIL_ICON_SIZE = 18;

/**
 * Divide o menu (já filtrado por permissão/capability pelo Shell) em primários
 * do rail + grupos do popover "mais". A ordem dos primários é a da SPEC; os
 * grupos do "mais" preservam a ordem dos grupos do manifest e nunca duplicam
 * um primário.
 */
export function splitRailItems(items: readonly RailMenuItem[]): { primary: RailPrimaryItem[]; more: RailMoreGroup[] } {
  const byHref = new Map(items.map((item) => [item.href, item]));
  const primary: RailPrimaryItem[] = [];
  const primaryHrefs = new Set<string>();
  for (const href of railPrimaryHrefs) {
    const item = byHref.get(href);
    if (!item) continue;
    primary.push({ href: item.href, label: item.label, active: false });
    primaryHrefs.add(item.href);
  }
  const more: RailMoreGroup[] = panelManifestGroups
    .map((label) => ({
      label,
      items: items
        .filter((item) => item.group === label && !primaryHrefs.has(item.href))
        .map(({ href, label: itemLabel, Icon }) => ({ href, label: itemLabel, Icon, active: false }))
    }))
    .filter((group) => group.items.length > 0);
  return { primary, more };
}

function RailCount({ count }: { count: number }) {
  if (count <= 0) return null;
  return <b className="nav-rail__count">{count > 99 ? "99+" : count}</b>;
}

export function NavRail({
  items,
  moreGroups,
  onOpenPalette,
  onLogout,
  availability,
  workspaceSlot,
  profilePath = "/perfil",
  profileActive = false
}: {
  /** Itens primários já ordenados e com estado ativo resolvido pelo Shell. */
  items: RailPrimaryItem[];
  /** Grupos do popover "mais", já com estado ativo resolvido pelo Shell. */
  moreGroups: RailMoreGroup[];
  onOpenPalette: () => void;
  onLogout: () => void;
  /** Controle de disponibilidade do atendente (mesma chamada da sidebar). */
  availability?: RailAvailability | null;
  /** WorkspaceSwitcher montado pelo Shell (gating de workspaces múltiplos). */
  workspaceSlot?: ReactNode;
  profilePath?: string;
  profileActive?: boolean;
}) {
  return (
    <TooltipProvider>
      <aside className="nav-rail" aria-label="Navegação principal">
        <div className="nav-rail__logo" aria-hidden="true">
          <BrandMark className="nav-rail__logo-mark" />
        </div>
        <span className="nav-rail__divider" aria-hidden="true" />
        <nav className="nav-rail__nav" aria-label="Navegação principal">
          {items.map((item) => {
            const Icon = PRIMARY_ICONS[item.href] ?? undefined;
            return (
              <Tooltip key={item.href} content={item.label} side="right">
                <Link
                  href={item.href}
                  className={`nav-rail__link${item.active ? " active" : ""}`}
                  aria-label={item.label}
                  aria-current={item.active ? "page" : undefined}
                >
                  {Icon ? <Icon size={RAIL_ICON_SIZE} aria-hidden /> : null}
                  <RailCount count={item.count ?? 0} />
                </Link>
              </Tooltip>
            );
          })}
          {moreGroups.length > 0 ? (
            <PopoverMenu
              align="start"
              ariaLabel="Mais itens do menu"
              title="Mais itens do menu"
              buttonClassName={`nav-rail__link nav-rail__more${moreGroups.some((group) => group.items.some((item) => item.active)) ? " active" : ""}`}
              panelClassName="rail-more-panel"
              icon={<RailIcons.mais size={RAIL_ICON_SIZE} aria-hidden="true" />}
            >
              {(close) => (
                <div className="rail-more__inner">
                  {moreGroups.map((group) => (
                    <div key={group.label} className="rail-more__group">
                      <span className="rail-more__label">{group.label}</span>
                      {group.items.map(({ href, label, Icon, active }) => (
                        <Link
                          key={href}
                          href={href}
                          className={`rail-more__item${active ? " active" : ""}`}
                          aria-current={active ? "page" : undefined}
                          onClick={close}
                        >
                          <Icon size={16} aria-hidden />
                          <span>{label}</span>
                        </Link>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </PopoverMenu>
          ) : null}
        </nav>
        <span className="nav-rail__divider" aria-hidden="true" />
        <div className="nav-rail__footer">
          {workspaceSlot ? <div className="nav-rail__workspace">{workspaceSlot}</div> : null}
          {availability ? (
            <Tooltip
              content={availability.available ? "Status: Disponível. Alterar disponibilidade" : "Status: Indisponível. Alterar disponibilidade"}
              side="right"
            >
              <button
                type="button"
                className={`nav-rail__link nav-rail__availability${availability.available ? " is-available" : " is-unavailable"}`}
                disabled={availability.pending}
                aria-pressed={availability.available}
                aria-label={availability.available ? "Status: Disponível. Alterar disponibilidade" : "Status: Indisponível. Alterar disponibilidade"}
                onClick={availability.onToggle}
              >
                {availability.available ? <CheckCircle size={RAIL_ICON_SIZE} aria-hidden="true" /> : <Prohibit size={RAIL_ICON_SIZE} aria-hidden="true" />}
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content="Buscar página (Ctrl+K)" side="right">
            <button type="button" className="nav-rail__link" aria-label="Buscar página (Ctrl+K)" onClick={onOpenPalette}>
              <RailIcons.buscar size={RAIL_ICON_SIZE} aria-hidden="true" />
            </button>
          </Tooltip>
          <Tooltip content="Alternar tema" side="right">
            <div className="nav-rail__link nav-rail__theme">
              <ThemeToggle className="nav-rail__theme-toggle" iconSize={RAIL_ICON_SIZE} />
            </div>
          </Tooltip>
          <Tooltip content="Abrir perfil" side="right">
            <Link href={profilePath} className={`nav-rail__link${profileActive ? " active" : ""}`} aria-label="Abrir perfil">
              <RailIcons.perfil size={RAIL_ICON_SIZE} aria-hidden="true" />
            </Link>
          </Tooltip>
          <Tooltip content="Sair" side="right">
            <button type="button" className="nav-rail__link nav-rail__logout" aria-label="Sair" onClick={onLogout}>
              <RailIcons.sair size={RAIL_ICON_SIZE} aria-hidden="true" />
            </button>
          </Tooltip>
        </div>
      </aside>
    </TooltipProvider>
  );
}
