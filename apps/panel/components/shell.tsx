"use client";

import { ArrowClockwise, CaretDown, CaretLineLeft, CaretLineRight, CheckCircle, List, MagnifyingGlass, Prohibit, SignOut, UserCircle, X } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { BrandMark } from "@/components/brand-mark";
import { CommandPalette, type PaletteItem } from "@/components/command-palette";
import { MessageNotifications } from "@/components/message-notifications";
import { NotificationCenter } from "@/components/notification-center";
import { InternalNotifications } from "@/components/internal-notifications";
import { ThemeToggle } from "@/components/theme-toggle";
import { VersionBanner } from "@/components/version-banner";
import { WorkspaceSwitcher } from "@/components/workspace-switcher";
import { Button } from "@/components/ui";
import { ApiError, api, type VersionInfo } from "@/lib/api";
import { useCapabilities } from "@/lib/capabilities";
import { useEntitlements } from "@/lib/entitlements";
import { accessStatusLabel } from "@/lib/labels";
import {
  canAccessManifestItem,
  canExposeManifestItem,
  findPanelManifestItem,
  panelManifest,
  panelManifestGroups,
  type PanelManifestItem
} from "@/lib/panel-manifest";
import { useRealtimeSignals } from "@/lib/realtime";
import {
  canAccessWithSession,
  caseScopedNavigationLabel,
  publishWorkspaceContextChange,
  type PanelSession
} from "@/lib/session";

const fetcher = <T,>(url: string) => api<T>(url);
type ShellAttendant = {
  member_id: string;
  user_id: string;
  selected: boolean;
  availability_status: "available" | "unavailable" | null;
  is_current: boolean;
};
type ShellAttendantsResponse = { attendants: ShellAttendant[]; member_ids: string[] };

function Brand() {
  return <div className="brand"><BrandMark className="brand-logo" /><span>AtendON</span></div>;
}

function matchesPath(path: string, href: string) {
  return panelManifest.find((item) => item.href === href)?.match?.(path) ?? (path === href || path.startsWith(`${href}/`));
}

function formatUserName(email: string) {
  const localPart = email.split("@", 1)[0]?.trim() || email;
  const words = localPart.split(/[._-]+/).filter(Boolean);
  if (words.length === 0) return email;
  return words.map((word) => `${word.charAt(0).toLocaleUpperCase("pt-BR")}${word.slice(1)}`).join(" ");
}

function getInitials(name: string) {
  const words = name.split(/\s+/).filter(Boolean);
  const initials = words.length > 1 ? `${words[0][0]}${words.at(-1)?.[0] ?? ""}` : words[0]?.slice(0, 2) ?? "";
  return initials.toLocaleUpperCase("pt-BR");
}

function SessionState({ error = false, onRetry }: { error?: boolean; onRetry?: () => void }) {
  return (
    <main className="shell-loading" role={error ? "alert" : "status"} aria-live="polite">
      <div className="shell-loading__panel">
        <BrandMark className="brand-logo" />
        <strong>{error ? "Não foi possível carregar o painel" : "Carregando seu workspace"}</strong>
        <p>{error ? "Verifique sua conexão e tente novamente." : "Preparando permissões e dados da sessão…"}</p>
        {onRetry ? <button type="button" className="btn" onClick={onRetry}>Tentar novamente</button> : <span className="skeleton h-1.5 w-full" aria-hidden="true" />}
      </div>
    </main>
  );
}

export function Shell({
  children,
  flush = false,
  fitViewport = false,
  activeConversationId,
  onOpenConversation
}: {
  children: React.ReactNode;
  flush?: boolean;
  fitViewport?: boolean;
  activeConversationId?: string;
  onOpenConversation?: (conversationId: string) => void;
}) {
  const path = usePathname();
  const router = useRouter();
  const [switchingWorkspace, setSwitchingWorkspace] = useState(false);
  const [hasMoreNavItems, setHasMoreNavItems] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [changingAvailability, setChangingAvailability] = useState(false);
  const [availabilityError, setAvailabilityError] = useState("");
  const navRef = useRef<HTMLElement>(null);
  // O CSS reage a data-theme/data-sidebar no <html> (setados pré-hidratação); o
  // estado só controla o ícone do toggle da sidebar. O tema vive inteiro em
  // <ThemeToggle> (components/theme-toggle.tsx) com a própria animação.
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    setCollapsed(document.documentElement.dataset.sidebar === "collapsed");
  }, []);
  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      document.documentElement.dataset.sidebar = next ? "collapsed" : "expanded";
      try { localStorage.setItem("atendon-sidebar", next ? "collapsed" : "expanded"); } catch { /* sem storage, sem persistência */ }
      return next;
    });
  }, []);
  const { data: session, error: sessionError, isLoading, mutate: mutateSession } = useSWR<PanelSession>("/me", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const capabilities = useCapabilities();
  const entitlements = useEntitlements(Boolean(session?.activeWorkspace));
  const canReadDashboard = session
    ? canAccessWithSession(session, ["dashboard.read"]) && capabilities.isEnabled("dashboard_v1")
    : false;
  const canReadConversations = session ? canAccessWithSession(session, ["conversations.read"]) : false;
  const canReadAttendants = session ? Boolean(
    session.activeWorkspace
    && capabilities.isEnabled("appointments_v1")
    && canAccessWithSession(session, ["units.read"])
  ) : false;
  const {
    data: attendantsData,
    error: attendantsError,
    mutate: mutateAttendants
  } = useSWR<ShellAttendantsResponse>(canReadAttendants ? "/scheduling/config/attendants" : null, fetcher, {
    refreshInterval: 10_000,
    revalidateOnFocus: true,
    dedupingInterval: 5_000,
    shouldRetryOnError: false
  });
  const { data: dashboard, mutate: mutateDashboard } = useSWR<{ counts?: { handoff?: number } }>(canReadDashboard ? "/dashboard" : null, fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  useRealtimeSignals({
    onCatchUp: () => { if (document.visibilityState === "visible") void mutateDashboard(); },
    onSignal: (signal) => {
      if (
        document.visibilityState === "visible"
        && (signal.type === "conversation.messages.changed" || signal.type === "case.assignment.changed")
      ) void mutateDashboard();
    }
  });
  const [versionBannerOpen, setVersionBannerOpen] = useState(false);
  const { data: versionData } = useSWR<VersionInfo>("/panel/version", fetcher, {
    revalidateOnFocus: false,
    dedupingInterval: 60_000
  });

  useEffect(() => {
    if (!versionData?.version) return;
    try {
      const lastSeen = localStorage.getItem("atendon_last_seen_version");
      if (lastSeen !== versionData.version) {
        setVersionBannerOpen(true);
      }
    } catch {
      // Ignora erro de localStorage
    }
  }, [versionData?.version]);

  const currentItem = useMemo<PanelManifestItem | undefined>(() => findPanelManifestItem(path), [path]);
  const visibleGroups = useMemo(() => {
    if (!session) return [];
    const showOperationalGroups = !session.user.isRoot || session.rootWorkspaceAccess;
    return panelManifestGroups
      .filter((group) => showOperationalGroups || group === "ROOT")
      .map((group) => ({
        label: group,
        items: panelManifest
          .filter((item) => item.menu && item.group === group)
          .filter((item) => canExposeManifestItem(
            session,
            item,
            capabilities.isEnabled,
            (feature) => entitlements.features[feature] === true
          ))
          .map((item) => ({
            ...item,
            label: caseScopedNavigationLabel(session, item.href, item.label)
          }))
      }))
      .filter((group) => group.items.length > 0);
  }, [capabilities, entitlements.features, session]);
  const canRenderCurrentPage = Boolean(session && (!currentItem || canAccessManifestItem(session, currentItem)));
  const paletteItems = useMemo<PaletteItem[]>(
    () => visibleGroups.flatMap((group) => group.items.map(({ href, label, Icon }) => ({ href, label, Icon, group: group.label }))),
    [visibleGroups]
  );
  const currentAttendant = attendantsData?.attendants.find((attendant) => attendant.is_current && attendant.selected);

  const toggleAvailability = useCallback(async () => {
    if (!currentAttendant || changingAvailability) return;
    setChangingAvailability(true);
    setAvailabilityError("");
    const next = currentAttendant.availability_status === "available" ? "unavailable" : "available";
    try {
      await api("/scheduling/attendants/me/availability", {
        method: "PATCH",
        body: JSON.stringify({ availability_status: next })
      });
      await mutateAttendants();
    } catch (error) {
      setAvailabilityError(error instanceof Error ? error.message : "Falha ao alterar disponibilidade");
    } finally {
      setChangingAvailability(false);
    }
  }, [changingAvailability, currentAttendant, mutateAttendants]);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const updateOverflow = () => {
      setHasMoreNavItems(nav.scrollTop + nav.clientHeight < nav.scrollHeight - 1);
    };
    const frame = requestAnimationFrame(updateOverflow);
    // Safari 12–13.0 não tem ResizeObserver: segue só com o evento scroll.
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(updateOverflow) : null;
    if (observer) observer.observe(nav);
    nav.addEventListener("scroll", updateOverflow, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
      nav.removeEventListener("scroll", updateOverflow);
    };
  }, [collapsed, visibleGroups]);

  useEffect(() => {
    if (!(sessionError instanceof ApiError) || sessionError.status !== 403 || path === "/403") return;
    router.replace("/403");
  }, [path, router, sessionError]);

  useEffect(() => setMobileNavOpen(false), [path]);

  useEffect(() => {
    if (!session || path === "/403") return;
    if (currentItem && !canAccessManifestItem(session, currentItem)) router.replace("/403");
  }, [currentItem, path, router, session]);

  const switchWorkspace = useCallback(async (workspaceId: string) => {
    if (!session?.activeWorkspace || workspaceId === session.activeWorkspace.id) return;
    setSwitchingWorkspace(true);
    try {
      const nextSession = await api<PanelSession>("/workspaces/switch", { method: "POST", body: JSON.stringify({ workspaceId }) });
      await mutateSession(nextSession, false);
      try { publishWorkspaceContextChange(localStorage, workspaceId); } catch { /* sem sincronização entre abas */ }
      window.location.reload();
    } catch {
      setSwitchingWorkspace(false);
    }
  }, [mutateSession, session?.activeWorkspace]);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    await mutateSession(undefined, false);
    router.replace("/login");
    router.refresh();
  }, [mutateSession, router]);

  if (isLoading && !session) return <SessionState />;
  if (!session) {
    const redirecting = sessionError instanceof ApiError && sessionError.status === 403;
    return <SessionState error={!redirecting} onRetry={redirecting ? undefined : () => void mutateSession()} />;
  }

  const workspaceName = session.activeWorkspace?.name ?? "Workspace";
  const workspaceSlug = session.activeWorkspace?.slug ?? "";
  const workspaceStatus = session.activeWorkspace?.status ?? "inactive";
  const workspaceRole = session.activeWorkspace?.role ?? "-";
  const userName = formatUserName(session.user.email);
  const userInitials = getInitials(userName);
  const userRole = session.user.isRoot ? "ROOT" : workspaceRole;
  const handoffCount = dashboard?.counts?.handoff ?? 0;
  const showRootBanner = session.actorScope === "root" && !path.startsWith("/root");

  return (
    <div className={`shell${flush ? " shell--flush" : ""}${fitViewport ? " shell--fit" : ""}`} data-mobile-nav={mobileNavOpen ? "open" : "closed"}>
      {mobileNavOpen ? <button type="button" className="mobile-nav-backdrop" aria-label="Fechar menu" onClick={() => setMobileNavOpen(false)} /> : null}
      <aside className="sidebar">
        <div className="sidebar-top">
          <Brand />
          <button type="button" className="sidebar-collapse" onClick={toggleSidebar} aria-label={collapsed ? "Expandir menu" : "Recolher menu"} title={collapsed ? "Expandir menu" : "Recolher menu"}>
            {collapsed ? <CaretLineRight size={16} aria-hidden="true" /> : <CaretLineLeft size={16} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="mobile-nav-toggle"
            onClick={() => setMobileNavOpen((open) => !open)}
            aria-label={mobileNavOpen ? "Fechar menu" : "Abrir menu"}
            aria-expanded={mobileNavOpen}
          >
            {mobileNavOpen ? <X size={18} aria-hidden="true" /> : <List size={18} aria-hidden="true" />}
          </button>
        </div>
        {session.activeWorkspace && session.workspaces.length > 1 ? (
          <WorkspaceSwitcher
            activeWorkspaceId={session.activeWorkspace?.id}
            disabled={switchingWorkspace}
            onChange={switchWorkspace}
            workspaces={session.workspaces}
          />
        ) : null}
        <button type="button" className="palette-trigger" onClick={() => setPaletteOpen(true)} aria-label="Buscar página (Ctrl+K)" title="Buscar página (Ctrl+K)">
          <MagnifyingGlass size={15} aria-hidden="true" />
          <span>Buscar…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <div className="mobile-nav-panel">
        <div className="nav-scroll-region">
          <nav ref={navRef} className="nav" aria-label="Navegação principal">
            {visibleGroups.map((group) => (
              <div key={group.label} className="navgroup">
                <span className="navlabel">{group.label}</span>
                {group.items.map(({ href, label, Icon }) => (
                  <Link key={href} href={href} className={matchesPath(path, href) ? "active" : ""} aria-label={label} title={label} aria-current={matchesPath(path, href) ? "page" : undefined}>
                    <Icon size={17} weight="regular" aria-hidden="true" />
                    <span>{label}</span>
                    {href === "/conversas" && handoffCount > 0 ? <b className="count">{handoffCount}</b> : null}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          {hasMoreNavItems ? (
            <button
              type="button"
              className="nav-scroll-hint"
              aria-label="Ver mais itens do menu"
              title="Mais itens abaixo"
              onClick={() => {
                const nav = navRef.current;
                nav?.scrollBy({ top: Math.max(120, nav.clientHeight * 0.55), behavior: "smooth" });
              }}
            >
              <CaretDown size={15} weight="bold" aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className="mobile-account-tools">
          {session.activeWorkspace && session.workspaces.length > 1 ? (
            <label className="mobile-workspace-select">
              <span className="sr-only">Workspace atual</span>
              <select value={session.activeWorkspace?.id} disabled={switchingWorkspace} onChange={(event) => void switchWorkspace(event.target.value)}>
                {session.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
              </select>
            </label>
          ) : <strong className="mobile-workspace-name">{workspaceName}</strong>}
          {currentAttendant ? (
            <button
              type="button"
              disabled={changingAvailability}
              onClick={() => void toggleAvailability()}
              aria-label={`Status: ${currentAttendant.availability_status === "available" ? "Disponível" : "Indisponível"}. Alterar disponibilidade`}
              title={currentAttendant.availability_status === "available" ? "Disponível" : "Indisponível"}
            >
              {currentAttendant.availability_status === "available" ? <CheckCircle size={20} aria-hidden="true" /> : <Prohibit size={20} aria-hidden="true" />}
            </button>
          ) : null}
          <Link href="/perfil" aria-label="Abrir perfil" aria-current={matchesPath(path, "/perfil") ? "page" : undefined} className={matchesPath(path, "/perfil") ? "active" : ""}><UserCircle size={20} aria-hidden="true" /></Link>
          <ThemeToggle iconSize={20} />
          <button type="button" onClick={() => void logout()} aria-label="Sair"><SignOut size={20} aria-hidden="true" /></button>
        </div>
        </div>
        <div className="sidebar-footer">
          {currentAttendant ? (
            <Button
              type="button"
              tone={currentAttendant.availability_status === "available" ? "quiet" : "danger"}
              className={`availability-control ${currentAttendant.availability_status === "available" ? "is-available" : "is-unavailable"}`}
              disabled={changingAvailability}
              aria-pressed={currentAttendant.availability_status === "available"}
              onClick={() => void toggleAvailability()}
            >
              <span className="availability-control__label">
                {currentAttendant.availability_status === "available" ? <CheckCircle size={16} weight="fill" aria-hidden="true" /> : <Prohibit size={16} weight="fill" aria-hidden="true" />}
                {currentAttendant.availability_status === "available" ? "Disponível" : "Indisponível"}
              </span>
              <span className="availability-control__action">{changingAvailability ? "Salvando…" : "Alterar"}</span>
            </Button>
          ) : null}
          {availabilityError || attendantsError ? (
            <p className="sidebar-status-error" role="alert">{availabilityError || "Status indisponível"}</p>
          ) : null}
          <div className="account-menu">
            <div className={`account-card${matchesPath(path, "/perfil") ? " active" : ""}`}>
              <Link
                href="/perfil"
                className="account-card__profile"
                aria-label={`Abrir perfil de ${userName}`}
                aria-current={matchesPath(path, "/perfil") ? "page" : undefined}
                title={session.user.email}
              >
                <span className="account-card__avatar" aria-hidden="true">{userInitials}</span>
                <span className="account-card__identity">
                  <strong>{userName}</strong>
                  <small>{userRole}</small>
                </span>
              </Link>
              <div className="account-card__actions">
                <ThemeToggle className="account-card__action" iconSize={15} />
                <button type="button" className="account-card__action" onClick={() => void logout()} aria-label="Sair" title="Sair">
                  <SignOut size={15} weight="regular" aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>
      <header className="topbar">
        <div className="topbar__tenant">
          <i className={`dot ${workspaceStatus !== "active" ? "warn" : ""}`} aria-hidden="true" />
          <strong>{workspaceName}</strong>
          {workspaceSlug ? <span className="topbar__slug mono">{workspaceSlug}</span> : null}
          <span className="topbar__role">{accessStatusLabel(workspaceStatus)}</span>
        </div>
        <div className="topbar__meta">
          {showRootBanner ? (
            <Link className="topbar__root" href="/root/workspaces" title="Acesso assistido ROOT — todas as ações ficam auditadas neste workspace">
              ROOT
            </Link>
          ) : null}
          {/* Sino de notificações internas (R2 v6): user-scoped e independente do
              centro de alertas — presente em TODAS as páginas, inclusive /conversas. */}
          <InternalNotifications />
          <Link className="mono topbar__version" href="/changelog" title="Ver changelog público">
            AtendON v{versionData?.version ?? "—"}{versionData?.buildNumber ? ` · Build ${versionData.buildNumber}` : ""}
          </Link>
          <button type="button" className="topbar__changelog" onClick={() => setVersionBannerOpen(true)} title="Ver o que há de novo nesta versão">
            <CheckCircle size={13} weight="regular" aria-hidden="true" />
            Novidades
          </button>
        </div>
      </header>
      <main className={`content${flush ? " content--flush" : ""}`}>
        {capabilities.error && session.activeWorkspace ? (
          <section className={`shell-capability-alert${flush ? " shell-capability-alert--flush" : ""}`} role="alert">
            <span>Não foi possível carregar os módulos desta empresa. Os módulos comerciais ficam indisponíveis; Conversas permanece acessível.</span>
            <Button type="button" tone="danger" onClick={() => void capabilities.retry()}>
              <ArrowClockwise size={15} aria-hidden="true" />Tentar novamente
            </Button>
          </section>
        ) : null}
        {canRenderCurrentPage ? children : null}
      </main>
      <CommandPalette items={paletteItems} open={paletteOpen} onOpenChange={setPaletteOpen} />
      <VersionBanner versionInfo={versionData ?? null} isOpen={versionBannerOpen} onClose={() => setVersionBannerOpen(false)} />
      <MessageNotifications
        enabled={canReadConversations}
        tenantId={session.activeWorkspace?.id}
        activeConversationId={activeConversationId}
        onOpenConversation={onOpenConversation}
      />
      <NotificationCenter
        enabled={canReadConversations && !path.startsWith("/conversas")}
        avoidBottomComposer={path.startsWith("/tripz-ai")}
      />
    </div>
  );
}
