"use client";

import { ArrowClockwise, ChatsCircle, LockSimple } from "@phosphor-icons/react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import useSWR, { SWRConfig } from "swr";
import { CapabilitiesProvider, useCapabilities } from "@/lib/capabilities";
import { api } from "@/lib/api";
import { canAccessManifestItem, findPanelManifestItem, firstEnabledModulePath } from "@/lib/panel-manifest";
import { RealtimeTenantProvider } from "@/lib/realtime";
import {
  shouldReloadForWorkspaceContextChange,
  WORKSPACE_CONTEXT_CHANNEL,
  WORKSPACE_CONTEXT_STORAGE_KEY,
  type PanelSession
} from "@/lib/session";
import { BrandMark } from "./brand-mark";
import { Shell } from "./shell";

const publicPaths = ["/login", "/convite", "/invitations", "/reuniao", "/offline", "/403"] as const;
const capabilityExemptPaths = ["/conversas", "/perfil", "/alterar-senha", "/root"] as const;
const startsAt = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
const createTenantCache = () => new Map();

function GuardLoading() {
  return (
    <main className="shell-loading" role="status" aria-live="polite">
      <div className="shell-loading__panel">
        <BrandMark className="brand-logo" />
        <strong>Carregando módulos da empresa</strong>
        <p>Validando o catálogo antes de abrir esta área.</p>
        <span className="skeleton h-1.5 w-full" aria-hidden="true" />
      </div>
    </main>
  );
}

function CapabilityUnavailable({ name, catalogError }: { name: string; catalogError?: boolean }) {
  const { retry } = useCapabilities();
  return (
    <Shell>
      <section className="mx-auto grid max-w-2xl gap-5 border-y guard-border-warning_border guard-bg-warning_subtle px-5 py-8 sm:grid-cols-[44px_minmax(0,1fr)]" role="alert">
        <span className="grid size-11 place-items-center rounded-full border guard-border-warning_border guard-text-warning">
          <LockSimple size={21} aria-hidden="true" />
        </span>
        <div>
          <span className="label">Módulo indisponível</span>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Funcionalidade indisponível para esta empresa</h1>
          <p className="sub mt-2">{catalogError ? "Não foi possível confirmar o catálogo com segurança." : `${name} não está habilitado neste workspace.`} Conversas continua disponível.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="btn btn-primary active:scale-[.98]" href="/conversas"><ChatsCircle size={16} aria-hidden="true" />Voltar para Conversas</Link>
            {catalogError ? <button type="button" className="btn active:scale-[.98]" onClick={() => void retry()}><ArrowClockwise size={16} aria-hidden="true" />Tentar novamente</button> : null}
          </div>
        </div>
      </section>
    </Shell>
  );
}

function CapabilityGate({ children, session, path }: { children: ReactNode; session: PanelSession; path: string }) {
  const router = useRouter();
  const { error, isEnabled, isLoading } = useCapabilities();
  const route = findPanelManifestItem(path);
  const exempt = capabilityExemptPaths.some((base) => startsAt(path, base));
  const capability = exempt ? undefined : route?.capability;

  useEffect(() => {
    if (path !== "/" || isLoading || error) return;
    if (session.user.isRoot && session.actorScope === "root" && !session.activeWorkspace) {
      router.replace("/root/workspaces");
      return;
    }
    const destination = firstEnabledModulePath(session, isEnabled);
    if (destination !== "/") router.replace(destination);
  }, [error, isEnabled, isLoading, path, router, session]);

  if (path === "/" && session.user.isRoot && session.actorScope === "root" && !session.activeWorkspace) return <GuardLoading />;
  if (capability && isLoading) return <GuardLoading />;
  if (route && !canAccessManifestItem(session, route)) return <Shell>{null}</Shell>;
  if (capability && (error || !isEnabled(capability))) {
    if (path === "/" && !error) return <GuardLoading />;
    return <CapabilityUnavailable name={route?.label ?? "Este módulo"} catalogError={Boolean(error)} />;
  }
  return children;
}

function ProtectedPanel({ children, path }: { children: ReactNode; path: string }) {
  const { data: session, error, isLoading, mutate } = useSWR<PanelSession>("/me", (url: string) => api<PanelSession>(url), {
    revalidateOnFocus: true,
    dedupingInterval: 10_000
  });
  useEffect(() => {
    const currentWorkspaceId = session?.activeWorkspace?.id;
    if (!currentWorkspaceId) return;
    let reloading = false;
    const reloadForWorkspaceChange = (key: string | null, value: string | null) => {
      if (reloading) return;
      if (shouldReloadForWorkspaceContextChange(key, value, currentWorkspaceId)) {
        reloading = true;
        window.location.reload();
      }
    };
    const onStorage = (event: StorageEvent) => {
      reloadForWorkspaceChange(event.key, event.newValue);
    };
    let broadcast: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== "undefined") {
        broadcast = new BroadcastChannel(WORKSPACE_CONTEXT_CHANNEL);
        broadcast.addEventListener("message", (event) => {
          reloadForWorkspaceChange(
            WORKSPACE_CONTEXT_STORAGE_KEY,
            typeof event.data === "string" ? event.data : null
          );
        });
      }
    } catch {
      broadcast = null;
    }
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("storage", onStorage);
      broadcast?.close();
    };
  }, [session?.activeWorkspace?.id]);
  if (isLoading && !session) return <GuardLoading />;
  if (!session) return error ? (
    <main className="shell-loading" role="alert">
      <div className="shell-loading__panel">
        <BrandMark className="brand-logo" />
        <strong>Não foi possível validar sua sessão</strong>
        <p>Nenhum módulo foi aberto. Tente novamente ou volte ao login.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="btn btn--danger" onClick={() => void mutate()}><ArrowClockwise size={16} aria-hidden="true" />Tentar novamente</button>
          <Link className="btn" href="/login">Voltar ao login</Link>
        </div>
      </div>
    </main>
  ) : <GuardLoading />;
  return (
    <RealtimeTenantProvider key={session.activeWorkspace?.id ?? "no-workspace"} tenantId={session.activeWorkspace?.id}>
      <SWRConfig value={{ provider: createTenantCache }}>
        <CapabilitiesProvider tenantId={session.activeWorkspace?.id}>
          <CapabilityGate session={session} path={path}>{children}</CapabilityGate>
        </CapabilitiesProvider>
      </SWRConfig>
    </RealtimeTenantProvider>
  );
}

export function PanelAccessGuard({ children }: { children: ReactNode }) {
  const path = usePathname();
  if (publicPaths.some((base) => startsAt(path, base))) return children;
  return <ProtectedPanel path={path}>{children}</ProtectedPanel>;
}
