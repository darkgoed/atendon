"use client";

import { BellRinging, BellSimple, Buildings, CalendarCheck, ChartBar, CheckCircle, ChatCircleDots, ClockCountdown, Cpu, FloppyDisk, GlobeHemisphereWest, GoogleLogo, Handshake, HardDrives, Link as LinkIcon, LinkBreak, PencilSimple, Plus, Queue, ShieldCheck, SlidersHorizontal, Sticker, TagSimple, Trash, UserList, UsersThree, VideoCamera, WarningCircle, Watch, type Icon } from "@phosphor-icons/react";
import Link from "next/link";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { Empty } from "@/components/page-state";
import { Shell } from "@/components/shell";
import { api } from "@/lib/api";
import { fetchWorkspaceTimezone, unmuteConversation } from "@/lib/settings-api";
import { useCapabilities } from "@/lib/capabilities";
import {
  attendantPoolAccess,
  attendantControlState,
  attendantPanelState,
  attendantPoolSavedMessage,
  availabilityLabel,
  type AttendantAvailability,
  type AttendantRedistributionCounts
} from "@/lib/attendants";
import {
  canAccessWithSession,
  canAccessRootWorkspace,
  hasWorkspaceWideCaseScope,
  type PanelSession
} from "@/lib/session";
import { usePermission } from "@/lib/use-permission";
import type { PanelNotificationPreferencesResponse } from "@/lib/message-notifications";
import {
  DEFAULT_SOUND_KEY,
  NOTIFICATION_SOUNDS,
  playNotificationSound,
  resolveSoundKey
} from "@/lib/notification-sounds";
import { WebPushSettings } from "@/components/web-push-settings";
import { ConversationQueueManager } from "@/components/conversation-queue-manager";
import { WorkspaceLogoSection } from "@/components/workspace-logo";
import { StorageSettingsPanel } from "@/components/storage-settings";
import { SETTINGS_COLOR_DEFAULTS } from "@/components/settings-colors";
import { Button, Field as UiField, Input } from "@/components/ui";
import { settingsNavGroups } from "@/lib/panel-manifest";
import styles from "@/components/settings-panels.module.css";

type CatalogResource = "categorias" | "parceiros" | "unidades";
type Resource = CatalogResource | "workspace" | "attendants" | "conversation-queues" | "atendon-meet" | "google-meet" | "signature" | "panel-notifications" | "agenda-notifications" | "armazenamento";
type CatalogItem = {
  id?: string;
  nome?: string;
  ativa?: boolean;
  ativo?: boolean;
  ordem_prioridade?: number;
  link_proposta?: string;
  horario_abertura?: string;
  horario_fechamento?: string;
  dias_funcionamento?: number[];
  duracao_slot_min?: number;
  capacidade_simultanea?: number;
};
type WorkspaceTimezoneResponse = {
  workspace: { id: string; name: string; timezone: string; business_hours_start: string; business_hours_end: string };
  queue_adjustment?: { promoted: number; rescheduled: number; skipped: number };
};

const catalogTabs: CatalogResource[] = ["categorias", "parceiros", "unidades"];
const resourceLabels: Record<Resource, string> = {
  workspace: "Geral",
  categorias: "Categorias",
  parceiros: "Parceiros",
  unidades: "Unidades",
  attendants: "Equipe de atendimento",
  "conversation-queues": "Filas de atendimento",
  "atendon-meet": "AtendON Meet",
  "google-meet": "Google Meet",
  signature: "Assinatura do atendente",
  "panel-notifications": "Notificações do painel",
  "agenda-notifications": "Notificações de agendamento",
  armazenamento: "Armazenamento"
};

const COMMON_TIMEZONES = [
  "UTC",
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Cuiaba",
  "America/Recife",
  "America/Fortaleza",
  "America/Belem",
  "America/Rio_Branco",
  "America/New_York",
  "Europe/Lisbon"
];

type SettingsDestination = {
  href: string;
  label: string;
  Icon: typeof LinkIcon;
  permission?: string;
  rootWorkspaceOnly?: boolean;
};

// R2 (SPEC settings-search): destinos sem `description` — a navegação mostra
// só ícone + label. Gating por chave preservado (o mesmo de antes).
const settingsDestinations: readonly SettingsDestination[] = [
  { href: "/alertas", label: "Alertas", Icon: BellRinging, rootWorkspaceOnly: true },
  { href: "/conexao", label: "Conexão", Icon: LinkIcon, permission: "connection.read" },
  { href: "/workspace/members", label: "Membros", Icon: UsersThree, permission: "members.read" },
  { href: "/workspace/audit", label: "Auditoria", Icon: Watch, permission: "audit.read" },
  { href: "/workspace/roles", label: "Funções", Icon: ShieldCheck, rootWorkspaceOnly: true },
  { href: "/agente", label: "Agente", Icon: Cpu, rootWorkspaceOnly: true },
  { href: "/follow-ups", label: "Follow-ups da IA", Icon: Sticker, rootWorkspaceOnly: true },
  { href: "/humanizacao", label: "Humanização", Icon: ClockCountdown, rootWorkspaceOnly: true },
  { href: "/uso", label: "Uso", Icon: ChartBar, rootWorkspaceOnly: true }
];

const resourceIcons: Record<Resource, Icon> = {
  workspace: SlidersHorizontal,
  categorias: TagSimple,
  parceiros: Handshake,
  unidades: Buildings,
  attendants: UserList,
  "conversation-queues": Queue,
  "atendon-meet": VideoCamera,
  "google-meet": GoogleLogo,
  signature: ChatCircleDots,
  "panel-notifications": BellSimple,
  "agenda-notifications": CalendarCheck,
  armazenamento: HardDrives
};

const settingsGroupSlug = (label: string) =>
  label.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// R3 (SPEC settings-search): chassi ÚNICO de configuração — mesmo card, mesmo
// cabeçalho (ícone da família phosphor num círculo + h2 + sub opcional), mesmo
// estado de carregamento. O conteúdo interno (forms, tabelas, grids) de cada
// painel permanece como está.
function PanelChassi({ headId, Icon, title, sub, busy, busyLabel, children }: {
  headId: string;
  Icon: Icon;
  title: string;
  sub?: string;
  busy?: boolean;
  busyLabel?: string;
  // children é opcional: os skeletons de loading usam <PanelChassi ... busy /> sem children.
  children?: ReactNode;
}) {
  return (
    <section className={`card ${styles.panel}`} aria-labelledby={headId}>
      <header className={styles.panelHead}>
        <span className={styles.panelIcon}><Icon size={19} aria-hidden="true" /></span>
        <div className="min-w-0">
          <h2 id={headId} className="m-0 text-base font-semibold text-[var(--text)]">{title}</h2>
          {sub ? <p className="sub mt-1">{sub}</p> : null}
        </div>
      </header>
      {busy ? (
        <div className="grid gap-4" aria-busy="true" aria-label={busyLabel}>
          <div className="skeleton h-8 w-2/5" />
          <div className="skeleton h-28" />
        </div>
      ) : children}
    </section>
  );
}

export default function ConfigPage() {
  const { isEnabled } = useCapabilities();
  const leadsEnabled = isEnabled("leads_v1");
  const appointmentsEnabled = isEnabled("appointments_v1");
  const [resource, setResource] = useState<Resource>("categorias");
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [editing, setEditing] = useState<CatalogItem>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const canManageCategories = usePermission("categories.manage");
  const canManagePartners = usePermission("partners.manage");
  const canReadCategories = usePermission("categories.read");
  const canReadPartners = usePermission("partners.read");
  const canReadUnits = usePermission("units.read");
  const canManageUnits = usePermission("units.manage");
  const canUpdateWorkspace = usePermission("workspace.update");
  const canReadSignature = usePermission("signature.read");
  const canManageSignature = usePermission("signature.manage");
  const canManageStorage = usePermission("storage.manage");
  const hasAgendaNotificationsReadPermission = usePermission("scheduling_notifications.read");
  const hasAgendaNotificationsManagePermission = usePermission("scheduling_notifications.manage");
  const canReadAgendaNotifications = appointmentsEnabled && hasAgendaNotificationsReadPermission;
  const canManageAgendaNotifications = appointmentsEnabled && hasAgendaNotificationsManagePermission;
  const { data: session } = useSWR<PanelSession>("/me", (url: string) => api<PanelSession>(url), {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  const attendantAccess = attendantPoolAccess({
    hasWorkspaceScope: Boolean(session && hasWorkspaceWideCaseScope(session)),
    canReadUnits,
    canManageUnits
  });
  const canManageAttendants = attendantAccess.canManage;
  const canReadAttendants = attendantAccess.canRead;
  const canManageQueues = usePermission("conversations.queues.manage");
  const visibleSettingsGroups = useMemo(() => {
    const destinationByHref = new Map(settingsDestinations.map((destination) => [destination.href, destination]));
    const destinationVisible = (href: string) => {
      if (!session) return false;
      const destination = destinationByHref.get(href);
      if (!destination) return false;
      return destination.rootWorkspaceOnly
        ? canAccessRootWorkspace(session)
        : Boolean(destination.permission && canAccessWithSession(session, [destination.permission]));
    };
    // Mesmo gating de antes, agora tab por chave (deep-links ?resource= cobrem
    // todas as 12 chaves com as MESMAS condições).
    const tabVisible: Partial<Record<Resource, boolean>> = {
      workspace: canUpdateWorkspace,
      categorias: leadsEnabled && canReadCategories,
      parceiros: leadsEnabled && canReadPartners,
      unidades: leadsEnabled && canReadUnits,
      attendants: canReadAttendants,
      "conversation-queues": canManageQueues,
      "atendon-meet": appointmentsEnabled && canReadUnits,
      "google-meet": appointmentsEnabled && canReadUnits,
      signature: canReadSignature,
      "panel-notifications": Boolean(session?.activeWorkspace),
      "agenda-notifications": canReadAgendaNotifications,
      armazenamento: canManageStorage
    };
    type NavEntry =
      | { kind: "tab"; key: Resource; label: string; Icon: Icon; onClick: () => void; active: boolean }
      | { kind: "destination"; key: string; href: string; label: string; Icon: Icon };
    return settingsNavGroups
      .map((group) => ({
        label: group.label,
        entries: group.keys.flatMap((key): NavEntry[] => {
          if (key.startsWith("/")) {
            const destination = destinationByHref.get(key);
            if (!destination || !destinationVisible(key)) return [];
            return [{ kind: "destination", key, href: destination.href, label: destination.label, Icon: destination.Icon }];
          }
          if (!tabVisible[key as Resource]) return [];
          return [{
            kind: "tab",
            key: key as Resource,
            label: resourceLabels[key as Resource],
            Icon: resourceIcons[key as Resource],
            onClick: () => setResource(key as Resource),
            active: resource === key
          }];
        })
      }))
      .filter((group) => group.entries.length > 0);
  }, [
    appointmentsEnabled,
    canManageQueues,
    canManageStorage,
    canReadAgendaNotifications,
    canReadAttendants,
    canReadCategories,
    canReadPartners,
    canReadSignature,
    canReadUnits,
    canUpdateWorkspace,
    leadsEnabled,
    resource,
    session
  ]);
  const canManage = resource === "workspace" ? canUpdateWorkspace
       : resource === "attendants" ? canManageAttendants
    : resource === "conversation-queues" ? canManageQueues
    : resource === "atendon-meet" || resource === "google-meet" ? canManageUnits
    : resource === "signature" ? canManageSignature
    : resource === "panel-notifications" ? true
    : resource === "agenda-notifications" ? canManageAgendaNotifications
    : resource === "categorias" ? canManageCategories
      : resource === "parceiros" ? canManagePartners : canManageUnits;
  const visibleTabs = useMemo<Resource[]>(() => [
    ...(canUpdateWorkspace ? ["workspace" as const] : []),
    ...(leadsEnabled && canReadCategories ? ["categorias" as const] : []),
    ...(leadsEnabled && canReadPartners ? ["parceiros" as const] : []),
    ...(leadsEnabled && canReadUnits ? ["unidades" as const] : []),
    ...(canReadAttendants ? ["attendants" as const] : []),
    ...(canManageQueues ? ["conversation-queues" as const] : []),
    ...(appointmentsEnabled && canReadUnits ? ["atendon-meet" as const, "google-meet" as const] : []),
    ...(canReadSignature ? ["signature" as const] : []),
    ...(session?.activeWorkspace ? ["panel-notifications" as const] : []),
    ...(canReadAgendaNotifications ? ["agenda-notifications" as const] : []),
    ...(canManageStorage ? ["armazenamento" as const] : [])
  ], [
    canReadAttendants,
    canManageQueues,
    canReadAgendaNotifications,
    canReadCategories,
    canReadPartners,
    canReadSignature,
    canReadUnits,
    canUpdateWorkspace,
    appointmentsEnabled,
    canManageStorage,
    leadsEnabled,
    session?.activeWorkspace
  ]);

  useEffect(() => {
    if (visibleTabs.length > 0 && !visibleTabs.includes(resource)) setResource(visibleTabs[0]);
  }, [resource, visibleTabs]);

  // Deep-link ?resource= — paridade das 12 chaves (SPEC settings-search):
  // cada chave entra apenas se o usuário tem o MESMO acesso que a aba exigiria;
  // sem permissão, mantém o comportamento atual de cair no primeiro tab visível.
  useEffect(() => {
    const requested = new URL(window.location.href).searchParams.get("resource");
    if (!requested) return;
    const access: Partial<Record<Resource, boolean>> = {
      workspace: canUpdateWorkspace,
      categorias: leadsEnabled && canReadCategories,
      parceiros: leadsEnabled && canReadPartners,
      unidades: leadsEnabled && canReadUnits,
      attendants: canReadAttendants,
      "conversation-queues": canManageQueues,
      "atendon-meet": appointmentsEnabled && canReadUnits,
      "google-meet": appointmentsEnabled && canReadUnits,
      signature: canReadSignature,
      "panel-notifications": Boolean(session?.activeWorkspace),
      "agenda-notifications": canReadAgendaNotifications,
      armazenamento: canManageStorage
    };
    if (requested in access && access[requested as Resource]) setResource(requested as Resource);
  }, [
    appointmentsEnabled,
    canManageQueues,
    canManageStorage,
    canReadAgendaNotifications,
    canReadAttendants,
    canReadCategories,
    canReadPartners,
    canReadSignature,
    canReadUnits,
    canUpdateWorkspace,
    leadsEnabled,
    session?.activeWorkspace
  ]);

  const load = useCallback(() => {
    setError("");
    if (!visibleTabs.includes(resource)) {
      setLoading(false);
      return Promise.resolve();
    }
    if (resource === "workspace" || resource === "attendants" || resource === "conversation-queues" || resource === "atendon-meet" || resource === "google-meet" || resource === "signature" || resource === "panel-notifications" || resource === "agenda-notifications" || resource === "armazenamento") {
      setLoading(false);
      return Promise.resolve();
    }
    return api<Record<CatalogResource, CatalogItem[]>>(`/scheduling/config/${resource}`)
      .then((response) => setItems(response[resource]))
      .catch((loadError: unknown) => {
        setItems([]);
        setError(loadError instanceof Error ? loadError.message : "Falha ao carregar o catálogo");
      })
      .finally(() => setLoading(false));
  }, [resource, visibleTabs]);

  useEffect(() => {
    setEditing(undefined);
    setItems([]);
    setLoading(true);
    void load();
  }, [load]);

  async function remove(id: string) {
    if (!canManage || !window.confirm("Excluir este cadastro?")) return;
    setError("");
    try {
      await api(`/scheduling/config/${resource}/${id}`, { method: "DELETE" });
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : "Falha ao excluir");
    }
  }

  return (
    <Shell>
      <header className="pagehead">
        <div>
          <h1>Configurações</h1>
        </div>
        {catalogTabs.includes(resource as CatalogResource) && canManage ? (
          <Button type="button" tone="primary" onClick={() => setEditing({})}>
            <Plus aria-hidden="true" />
            Novo cadastro
          </Button>
        ) : null}
      </header>

      {visibleSettingsGroups.length > 0 ? (
        /* R1/R4 (SPEC settings-search): navegação ÚNICA de configurações —
           "Geral" primeiro + categorias semânticas, as 21 chaves (12 abas +
           9 destinos) cada uma exatamente uma vez (settingsNavGroups é a
           fonte única da ordem/grupo). Gating por chave intacto; sem
           descrições (R2). O idioma é o mesmo do rail (settings-rail). */
        <nav className="settings-rail" aria-label="Configurações">
          {visibleSettingsGroups.map((group) => {
            const headId = `settings-group-${settingsGroupSlug(group.label)}`;
            return (
              <section key={group.label} className="settings-rail__group" aria-labelledby={headId}>
                <div className="settings-rail__grouphead">
                  <h2 id={headId}>{group.label}</h2>
                </div>
                <div className="settings-rail__nav">
                  {group.entries.map((entry) => entry.kind === "tab" ? (
                    <button
                      key={entry.key}
                      type="button"
                      aria-pressed={entry.active}
                      onClick={entry.onClick}
                      className="settings-rail__tab"
                    >
                      <entry.Icon size={18} aria-hidden="true" />
                      {entry.label}
                    </button>
                  ) : (
                    <Link key={entry.key} href={entry.href} className="settings-rail__link">
                      <entry.Icon size={18} aria-hidden="true" />
                      <span><strong>{entry.label}</strong></span>
                    </Link>
                  ))}
                </div>
              </section>
            );
          })}
        </nav>
      ) : null}

      {resource === "workspace" ? (
        <WorkspaceSettingsPanel canManageLogo={canUpdateWorkspace} />
      ) : resource === "attendants" ? (
        <AttendantSettingsPanel canManage={canManageAttendants} />
      ) : resource === "conversation-queues" ? (
        <ConversationQueueManager />
      ) : resource === "atendon-meet" ? (
        <AtendonMeetSettingsPanel canManage={canManageUnits} />
      ) : resource === "google-meet" ? (
        <GoogleMeetSettingsPanel canManage={canManageUnits} />
      ) : resource === "signature" ? (
        <SignatureSettingsPanel canManage={canManageSignature} />
      ) : resource === "panel-notifications" ? (
        <PanelNotificationSettingsPanel />
      ) : resource === "agenda-notifications" ? (
        <AgendaNotificationSettingsPanel canManage={canManageAgendaNotifications} />
      ) : resource === "armazenamento" ? (
        <StorageSettingsPanel canManage={canManageStorage} />
      ) : (
        <PanelChassi
          headId="settings-catalog"
          Icon={resourceIcons[resource]}
          title={resourceLabels[resource]}
          busy={loading}
          busyLabel="Carregando catálogo"
        >
          {error ? <p className="error" role="alert">{error}</p> : null}
          {!canManage && !loading ? <p className="sub" role="status">Esta seção está disponível somente para consulta.</p> : null}

          <div className={`${styles.catalogLayout} ${canManage ? styles.catalogLayoutManaged : ""}`}>
          <section className="responsive-table-wrap" aria-label={resourceLabels[resource]}>
          {items.length === 0 ? (
            <Empty>Nenhum cadastro nesta seção.</Empty>
          ) : (
            <table className={`responsive-table ${styles.catalogTable}`}>
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--text-secondary)]">
                  <th className="px-4 py-3">ID</th>
                  <th className="px-4 py-3">Nome</th>
                  <th className="px-4 py-3">Configuração</th>
                  {canManage ? <th className="px-4 py-3"><span className="sr-only">Ações</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b border-[var(--border)] last:border-0">
                    <td data-label="ID" className="mono px-4 py-3 text-xs">{item.id}</td>
                    <td data-label="Nome" className="px-4 py-3"><strong>{item.nome}</strong></td>
                    <td data-label="Configuração" className="px-4 py-3 text-xs text-[var(--text-secondary)]"><Summary resource={resource as CatalogResource} item={item} /></td>
                    {canManage ? (
                      <td data-label="Ações" className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button type="button" className="btn p-2" aria-label={`Editar ${item.nome}`} onClick={() => setEditing(item)}>
                            <PencilSimple aria-hidden="true" />
                          </button>
                          <button type="button" className="btn warn p-2" aria-label={`Excluir ${item.nome}`} disabled={!item.id} onClick={() => { if (item.id) void remove(item.id); }}>
                            <Trash aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        {canManage ? editing ? (
          <Editor
            resource={resource as CatalogResource}
            item={editing}
            onCancel={() => setEditing(undefined)}
            onSaved={async () => {
              setEditing(undefined);
              await load();
            }}
            onError={setError}
          />
        ) : (
          <aside className={`card ${styles.editorPlaceholder}`}>
            Selecione um cadastro para editar<br />ou crie um novo.
          </aside>
        ) : null}
        </div>
        </PanelChassi>
      )}
    </Shell>
  );
}

function WorkspaceSettingsPanel({ canManageLogo }: { canManageLogo: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<WorkspaceTimezoneResponse>(
    "/workspaces/current/timezone",
    fetchWorkspaceTimezone<WorkspaceTimezoneResponse>,
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const [timezone, setTimezone] = useState("");
  const [businessHoursStart, setBusinessHoursStart] = useState("");
  const [businessHoursEnd, setBusinessHoursEnd] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.workspace.timezone) setTimezone(data.workspace.timezone);
    if (data?.workspace.business_hours_start) setBusinessHoursStart(data.workspace.business_hours_start.slice(0, 5));
    if (data?.workspace.business_hours_end) setBusinessHoursEnd(data.workspace.business_hours_end.slice(0, 5));
  }, [data?.workspace.timezone, data?.workspace.business_hours_start, data?.workspace.business_hours_end]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!timezone.trim() || !businessHoursStart || !businessHoursEnd || saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const response = await api<WorkspaceTimezoneResponse>("/workspaces/current/timezone", {
        method: "PATCH",
        body: JSON.stringify({
          timezone: timezone.trim(),
          business_hours_start: businessHoursStart,
          business_hours_end: businessHoursEnd
        })
      });
      setTimezone(response.workspace.timezone);
      setBusinessHoursStart(response.workspace.business_hours_start.slice(0, 5));
      setBusinessHoursEnd(response.workspace.business_hours_end.slice(0, 5));
      await mutate(response, { revalidate: false });
      setSaved(true);
    } catch (submitError) {
      setSaveError(submitError instanceof Error ? submitError.message : "Não foi possível atualizar o fuso horário.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <PanelChassi headId="settings-workspace" Icon={GlobeHemisphereWest} title="Geral" busy busyLabel="Carregando configurações gerais" />
    );
  }

  return (
    <PanelChassi headId="settings-workspace" Icon={GlobeHemisphereWest} title="Geral">
      <form className="grid gap-5" onSubmit={submit}>
        <div className="grid gap-5">
          <div>
            <h2 className="m-0 text-base font-semibold text-[var(--text)]">Fuso horário</h2>
            <p className="sub mt-1">Define como os horários aparecem na agenda e nas automações deste workspace.</p>
          </div>
          {error || saveError ? (
            <p className="error" role="alert">{saveError || (error instanceof Error ? error.message : "Não foi possível carregar o fuso horário.")}</p>
          ) : null}
          {saved ? <p className="text-sm text-[var(--primary-text)]" role="status">Fuso horário salvo.</p> : null}
          <label className="field">
            <span className="label">Fuso IANA</span>
            <input
              className="input mono"
              list="workspace-timezones"
              value={timezone}
              onChange={(event) => { setTimezone(event.target.value); setSaved(false); }}
              placeholder="America/Sao_Paulo"
              required
            />
            <datalist id="workspace-timezones">
              {COMMON_TIMEZONES.map((item) => <option key={item} value={item} />)}
            </datalist>
            <small className="sub">Exemplo: America/Sao_Paulo.</small>
          </label>
          <div>
            <h2 className="m-0 text-base font-semibold text-[var(--text)]">Horário de atendimento</h2>
            <p className="sub mt-1">
              Fora desse intervalo a IA não visualiza, não responde e a conexão fica offline no WhatsApp.
              O atendimento retoma automaticamente no início do horário, sem responder tudo de uma vez.
            </p>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <label className="field">
              <span className="label">Início</span>
              <input
                type="time"
                className="input mono"
                value={businessHoursStart}
                onChange={(event) => { setBusinessHoursStart(event.target.value); setSaved(false); }}
                required
              />
            </label>
            <label className="field">
              <span className="label">Fim</span>
              <input
                type="time"
                className="input mono"
                value={businessHoursEnd}
                onChange={(event) => { setBusinessHoursEnd(event.target.value); setSaved(false); }}
                required
              />
            </label>
          </div>
          <div>
            <button
              type="submit"
              className="btn primary active:scale-[0.98]"
              disabled={!timezone.trim() || !businessHoursStart || !businessHoursEnd || saving}
            >
              <FloppyDisk size={16} aria-hidden="true" />
              {saving ? "Salvando…" : "Salvar"}
            </button>
          </div>
        </div>
      </form>
      <WorkspaceLogoSection canManage={canManageLogo} />
    </PanelChassi>
  );
}

type SignatureFormat = "name_colon" | "bold_name_colon" | "role_name_colon" | "separate_line";
type SignatureNameStyle = "full" | "first_name";
type SignatureSettingsResponse = { signature: { enabled: boolean; format: SignatureFormat; name_style: SignatureNameStyle } };

const SIGNATURE_FORMAT_LABELS: Record<SignatureFormat, string> = {
  name_colon: "Nome: mensagem",
  bold_name_colon: "*Nome:* mensagem",
  role_name_colon: "Atendente Nome: mensagem",
  separate_line: "Nome em linha separada"
};

function SignatureSettingsPanel({ canManage }: { canManage: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<SignatureSettingsResponse>(
    "/signature",
    () => api<SignatureSettingsResponse>("/signature"),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const [enabled, setEnabled] = useState(false);
  const [format, setFormat] = useState<SignatureFormat>("name_colon");
  const [nameStyle, setNameStyle] = useState<SignatureNameStyle>("full");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.signature.enabled);
    setFormat(data.signature.format);
    setNameStyle(data.signature.name_style);
  }, [data]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const response = await api<SignatureSettingsResponse>("/signature", {
        method: "PUT",
        body: JSON.stringify({ enabled, format, nameStyle })
      });
      await mutate(response, { revalidate: false });
      setSaved(true);
    } catch (submitError) {
      setSaveError(submitError instanceof Error ? submitError.message : "Não foi possível salvar a assinatura.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <PanelChassi headId="settings-signature" Icon={ChatCircleDots} title="Assinatura do atendente" busy busyLabel="Carregando configuração de assinatura" />
    );
  }

  return (
    <PanelChassi
      headId="settings-signature"
      Icon={ChatCircleDots}
      title="Assinatura do atendente"
      sub="Identifica quem enviou a mensagem para o cliente no WhatsApp. Aplica-se somente a mensagens enviadas por atendentes humanos — mensagens da IA nunca recebem assinatura."
    >
      <form className="grid gap-5" onSubmit={submit}>
        <div className="grid gap-5">
          {error || saveError ? (
            <p className="error" role="alert">{saveError || (error instanceof Error ? error.message : "Não foi possível carregar a configuração.")}</p>
          ) : null}
          {saved ? <p className="text-sm text-[var(--primary-text)]" role="status">Assinatura salva.</p> : null}
          <label className="field flex-row items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }}
              disabled={!canManage}
            />
            <span className="label">Ativar assinatura nas mensagens enviadas por atendentes</span>
          </label>
          <label className="field">
            <span className="label">Formato</span>
            <select
              className="input"
              value={format}
              onChange={(event) => { setFormat(event.target.value as SignatureFormat); setSaved(false); }}
              disabled={!canManage || !enabled}
            >
              {(Object.keys(SIGNATURE_FORMAT_LABELS) as SignatureFormat[]).map((key) => (
                <option key={key} value={key}>{SIGNATURE_FORMAT_LABELS[key]}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="label">Estilo do nome</span>
            <select
              className="input"
              value={nameStyle}
              onChange={(event) => { setNameStyle(event.target.value as SignatureNameStyle); setSaved(false); }}
              disabled={!canManage || !enabled}
            >
              <option value="full">Nome completo</option>
              <option value="first_name">Primeiro nome</option>
            </select>
            <small className="sub">O nome vem do perfil de cada atendente (Configurações → Perfil).</small>
          </label>
          {canManage ? (
            <div>
              <button type="submit" className="btn primary active:scale-[0.98]" disabled={saving}>
                <FloppyDisk size={16} aria-hidden="true" />
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          ) : null}
        </div>
      </form>
    </PanelChassi>
  );
}

type SchedulingNotificationSettings = { enabled: boolean; session_id: string | null; group_jid: string | null; group_name: string | null };
type SchedulingNotificationSettingsResponse = { notifications: SchedulingNotificationSettings };
type SchedulingGroup = { id: string; subject: string };
type SchedulingGroupsResponse = { groups: SchedulingGroup[] };

function PanelNotificationSettingsPanel() {
  const { data, error, isLoading, mutate } = useSWR<PanelNotificationPreferencesResponse>(
    "/me/notification-preferences",
    () => api<PanelNotificationPreferencesResponse>("/me/notification-preferences"),
    { revalidateOnFocus: true }
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [soundKey, setSoundKey] = useState<string>(DEFAULT_SOUND_KEY);
  const [volume, setVolume] = useState(50);
  const preferences = data?.preferences ?? { enabled: true, sound_enabled: true, visual_enabled: true };

  useEffect(() => {
    if (!data) return;
    setSoundKey(resolveSoundKey(data.preferences.sound_key));
    const persisted = data.preferences.volume;
    setVolume(typeof persisted === "number" && Number.isFinite(persisted) ? Math.min(100, Math.max(0, Math.round(persisted))) : 50);
  }, [data]);

  async function saveSoundPreferences(next: { soundKey: string; volume: number }) {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const response = await api<{ preferences: typeof preferences }>("/me/notification-preferences", {
        method: "PATCH",
        body: JSON.stringify({ sound_key: next.soundKey, volume: next.volume })
      });
      await mutate((current) => current ? { ...current, preferences: response.preferences } : current, { revalidate: false });
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Não foi possível salvar a preferência.");
    } finally {
      setSaving(false);
    }
  }

  const soundControlsDisabled = saving || !preferences.enabled || !preferences.sound_enabled;

  async function change(key: keyof typeof preferences, value: boolean) {
    if (saving) return;
    setSaving(true);
    setSaveError("");
    try {
      const response = await api<{ preferences: typeof preferences }>("/me/notification-preferences", {
        method: "PATCH",
        body: JSON.stringify({ [key]: value })
      });
      await mutate((current) => current ? { ...current, preferences: response.preferences } : current, { revalidate: false });
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Não foi possível salvar a preferência.");
    } finally {
      setSaving(false);
    }
  }

  async function unmute(conversationId: string) {
    setSaveError("");
    try {
      await unmuteConversation(conversationId);
      await mutate();
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Não foi possível reativar a conversa.");
    }
  }

  async function requestDesktopPermission() {
    if (typeof Notification === "undefined") return;
    await Notification.requestPermission();
  }

  if (isLoading) {
    return (
      <PanelChassi headId="settings-panel-notifications" Icon={BellSimple} title="Notificações do painel" busy busyLabel="Carregando preferências de notificação" />
    );
  }
  return (
    <PanelChassi
      headId="settings-panel-notifications"
      Icon={BellSimple}
      title="Notificações do painel"
      sub="Controla somente novas mensagens recebidas de contatos. Alertas críticos, operacionais e de reuniões não são alterados. Os avisos de agendamento enviados ao grupo de WhatsApp ficam na seção separada “Notificações de agendamento”."
    >
      <div className="grid gap-6">
      {error || saveError ? <p className="error" role="alert">{saveError || (error instanceof Error ? error.message : "Falha ao carregar preferências.")}</p> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        {([
          ["enabled", "Novas mensagens", "Ativa ou desativa todos os avisos do painel"],
          ["sound_enabled", "Som", "Reproduz o toque de nova mensagem"],
          ["visual_enabled", "Toast e desktop", "Mostra a prévia visual e a notificação do navegador"]
        ] as const).map(([key, label, description]) => (
          <label key={key} className="flex gap-3 border border-[var(--border)] p-4">
            <input type="checkbox" checked={preferences[key]} disabled={saving || (key !== "enabled" && !preferences.enabled)} onChange={(event) => void change(key, event.target.checked)} />
            <span><strong className="block text-sm">{label}</strong><small className="sub mt-1 block">{description}</small></span>
          </label>
        ))}
      </div>
      <section className="border-t border-[var(--border)] pt-5" aria-label="Som e volume das notificações">
        <h3 className="text-sm font-semibold">Som e volume</h3>
        <p className="sub mt-1 text-xs">Toque tocado localmente quando chega uma nova mensagem. Use “Testar som” para ouvir com o volume atual.</p>
        <div className={styles.soundGrid}>
          <label className={styles.soundField}>
            <span className="sub">Som</span>
            <select
              className="input"
              value={soundKey}
              disabled={soundControlsDisabled}
              onChange={(event) => {
                const nextKey = event.target.value;
                setSoundKey(nextKey);
                playNotificationSound(nextKey, volume);
                void saveSoundPreferences({ soundKey: nextKey, volume });
              }}
            >
              {NOTIFICATION_SOUNDS.map((sound) => (
                <option key={sound.key} value={sound.key}>{sound.label}</option>
              ))}
            </select>
          </label>
          <div className={styles.soundField}>
            <label className="sub" htmlFor="panel-notification-volume">Volume</label>
            <div className={styles.volumeRow}>
              <input
                id="panel-notification-volume"
                className={styles.volumeSlider}
                type="range"
                min={0}
                max={100}
                step={1}
                value={volume}
                disabled={soundControlsDisabled}
                aria-label="Volume do som de notificação (0 a 100)"
                onChange={(event) => setVolume(Number(event.target.value))}
                onPointerUp={() => void saveSoundPreferences({ soundKey, volume })}
                onKeyUp={() => void saveSoundPreferences({ soundKey, volume })}
                onBlur={() => void saveSoundPreferences({ soundKey, volume })}
              />
              <span className={styles.volumeValue} aria-hidden="true">{volume}%</span>
            </div>
          </div>
          <div className={styles.soundField}>
            <button
              type="button"
              className="btn"
              disabled={soundControlsDisabled}
              onClick={() => playNotificationSound(soundKey, volume)}
            >
              Testar som
            </button>
          </div>
        </div>
      </section>
      {typeof Notification !== "undefined" && Notification.permission !== "granted" ? (
        <button type="button" className="btn justify-self-start" onClick={() => void requestDesktopPermission()}>Permitir notificações do navegador</button>
      ) : null}
      <section className="border-t border-[var(--border)] pt-5">
        <h3 className="text-sm font-semibold">Conversas silenciadas</h3>
        <p className="sub mt-1 text-xs">O silenciamento vale apenas para você neste workspace.</p>
        {data?.muted_conversations.length ? (
          <div className="mt-4 divide-y divide-[var(--border)] border-y border-[var(--border)]">
            {data.muted_conversations.map((conversation) => (
              <div key={conversation.id} className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0"><strong className="block truncate text-sm">{conversation.contact_name?.trim() || conversation.contact_phone}</strong><span className="mono type-caption text-[var(--text-muted)]">{conversation.contact_phone}</span></div>
                <button type="button" className="btn" onClick={() => void unmute(conversation.id)}>Reativar avisos</button>
              </div>
            ))}
          </div>
        ) : <p className="mt-4 text-sm text-[var(--text-secondary)]">Nenhuma conversa silenciada.</p>}
      </section>
      <WebPushSettings />
      </div>
    </PanelChassi>
  );
}

function AgendaNotificationSettingsPanel({ canManage }: { canManage: boolean }) {
  const { data, error, isLoading, mutate } = useSWR<SchedulingNotificationSettingsResponse>(
    "/scheduling/config/notifications",
    (url: string) => api<SchedulingNotificationSettingsResponse>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const { data: groupsData, error: groupsError, isLoading: groupsLoading } = useSWR<SchedulingGroupsResponse>(
    canManage ? "/scheduling/config/notification-groups" : null,
    (url: string) => api<SchedulingGroupsResponse>(url),
    { revalidateOnFocus: false, shouldRetryOnError: false }
  );
  const [enabled, setEnabled] = useState(false);
  const [groupJid, setGroupJid] = useState("");
  const [groupName, setGroupName] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!data) return;
    setEnabled(data.notifications.enabled);
    setGroupJid(data.notifications.group_jid ?? "");
    setGroupName(data.notifications.group_name ?? "");
  }, [data]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setSaveError("");
    setSaved(false);
    try {
      const response = await api<SchedulingNotificationSettingsResponse>("/scheduling/config/notifications", {
        method: "PUT",
        body: JSON.stringify({ enabled, groupJid: groupJid || null, groupName: groupName || null })
      });
      await mutate(response, { revalidate: false });
      setSaved(true);
    } catch (submitError) {
      setSaveError(submitError instanceof Error ? submitError.message : "Não foi possível salvar a configuração.");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading) {
    return (
      <PanelChassi headId="settings-agenda-notifications" Icon={CalendarCheck} title="Notificações de agendamento" busy busyLabel="Carregando notificações de agendamento" />
    );
  }

  return (
    <PanelChassi
      headId="settings-agenda-notifications"
      Icon={CalendarCheck}
      title="Notificações de agendamento"
      sub="Envia um aviso para um grupo de WhatsApp sempre que um novo agendamento for confirmado. Exclusivo para agendamentos — nenhum outro alerta do sistema usa este grupo."
    >
      <form className="grid gap-5" onSubmit={submit}>
        <div className="grid gap-5">
          {error || saveError ? (
            <p className="error" role="alert">{saveError || (error instanceof Error ? error.message : "Não foi possível carregar a configuração.")}</p>
          ) : null}
          {saved ? <p className="text-sm text-[var(--primary-text)]" role="status">Configuração salva.</p> : null}
          <label className="field flex-row items-center gap-2">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }}
              disabled={!canManage}
            />
            <span className="label">Ativar notificação de novos agendamentos</span>
          </label>
          <label className="field">
            <span className="label">Grupo do WhatsApp</span>
            {groupsError ? <p className="error text-xs">{groupsError instanceof Error ? groupsError.message : "Não foi possível carregar os grupos."}</p> : null}
            <select
              className="input"
              value={groupJid}
              onChange={(event) => {
                setGroupJid(event.target.value);
                setGroupName(groupsData?.groups.find((group) => group.id === event.target.value)?.subject ?? "");
                setSaved(false);
              }}
              disabled={!canManage || groupsLoading}
            >
              <option value="">{groupJid && !groupsData ? groupName || groupJid : "Selecione um grupo"}</option>
              {(groupsData?.groups ?? []).map((group) => (
                <option key={group.id} value={group.id}>{group.subject}</option>
              ))}
            </select>
            {groupJid ? (
              <small className="sub">
                Grupo atual: {groupName || groupJid}
                {canManage ? (
                  <button
                    type="button"
                    className="ml-2 text-[var(--primary-text)] underline-offset-2 hover:underline"
                    onClick={() => { setGroupJid(""); setGroupName(""); setSaved(false); }}
                  >
                    Remover
                  </button>
                ) : null}
              </small>
            ) : null}
          </label>
          {canManage ? (
            <div>
              <button type="submit" className="btn primary active:scale-[0.98]" disabled={saving || (enabled && !groupJid)}>
                <FloppyDisk size={16} aria-hidden="true" />
                {saving ? "Salvando…" : "Salvar"}
              </button>
            </div>
          ) : null}
        </div>
      </form>
    </PanelChassi>
  );
}

type Attendant = {
  member_id: string;
  user_id: string;
  email: string;
  funcao: string;
  selected: boolean;
  availability_status: AttendantAvailability | null;
  availability_changed_at: string | null;
  availability_changed_by_email: string | null;
  cor_agenda: string | null;
  active_appointments: number;
  last_assigned_at: string | null;
  is_current: boolean;
};
type AttendantSettingsResponse = AttendantRedistributionCounts & {
  attendants: Attendant[];
  member_ids: string[];
};

function AttendantSettingsPanel({ canManage }: { canManage: boolean }) {
  const { data, error: loadError, isLoading, mutate } = useSWR<AttendantSettingsResponse>(
    "/scheduling/config/attendants",
    (url: string) => api<AttendantSettingsResponse>(url),
    { refreshInterval: 10_000, revalidateOnFocus: true, shouldRetryOnError: false }
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [selectionDirty, setSelectionDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [changingMemberId, setChangingMemberId] = useState("");
  const [changingColorMemberId, setChangingColorMemberId] = useState("");
  const [colorDrafts, setColorDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const panelState = attendantPanelState({
    loading: isLoading,
    hasData: Boolean(data),
    hasError: Boolean(loadError || error),
    count: data?.attendants.length ?? 0
  });

  useEffect(() => {
    if (data && !selectionDirty) setSelectedIds(data.member_ids);
  }, [data, selectionDirty]);

  function toggleMember(memberId: string) {
    setFeedback("");
    setSelectionDirty(true);
    setSelectedIds((current) => current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : [...current, memberId]);
  }

  async function savePool(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving) return;
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      const response = await api<AttendantSettingsResponse>("/scheduling/config/attendants", {
        method: "PUT",
        body: JSON.stringify({ member_ids: selectedIds })
      });
      setSelectedIds(response.member_ids);
      setSelectionDirty(false);
      await mutate(response, false);
      setFeedback(attendantPoolSavedMessage(response));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao salvar a equipe de atendimento");
    } finally {
      setSaving(false);
    }
  }

  async function setAvailability(member: Attendant, status: AttendantAvailability) {
    if (!canManage || changingMemberId || member.availability_status === status) return;
    setChangingMemberId(member.member_id);
    setError("");
    setFeedback("");
    try {
      await api<{ redistribuidos: number }>(`/scheduling/attendants/${member.member_id}/availability`, {
        method: "PATCH",
        body: JSON.stringify({ availability_status: status })
      });
      await mutate();
      setFeedback("Disponibilidade informativa alterada. O rodízio continua igual.");
    } catch (availabilityError) {
      setError(availabilityError instanceof Error ? availabilityError.message : "Falha ao alterar a disponibilidade");
    } finally {
      setChangingMemberId("");
    }
  }

  async function setCalendarColor(member: Attendant, color: string) {
    if (!canManage || changingColorMemberId || member.cor_agenda?.toUpperCase() === color.toUpperCase()) return;
    setChangingColorMemberId(member.member_id);
    setError("");
    setFeedback("");
    try {
      await api(`/scheduling/attendants/${member.member_id}/calendar-color`, {
        method: "PATCH",
        body: JSON.stringify({ cor_agenda: color })
      });
      await mutate();
      setColorDrafts((current) => {
        const next = { ...current };
        delete next[member.member_id];
        return next;
      });
      setFeedback(`Cor de ${member.email} atualizada na agenda.`);
    } catch (colorError) {
      setError(colorError instanceof Error ? colorError.message : "Falha ao alterar a cor da agenda");
    } finally {
      setChangingColorMemberId("");
    }
  }

  if (panelState === "loading") {
    return (
      <PanelChassi headId="settings-attendants" Icon={UserList} title="Equipe de atendimento" busy busyLabel="Carregando equipe de atendimento" />
    );
  }

  return (
    <PanelChassi
      headId="settings-attendants"
      Icon={UserList}
      title="Equipe de atendimento"
      sub="Os membros selecionados recebem novos contatos em rodízio estrito, na ordem de entrada no pool. O status Disponível/Indisponível é apenas informativo e não altera a distribuição."
    >
      <form className="grid gap-5" onSubmit={savePool}>
      {loadError || error ? <p className="error" role="alert">{error || (loadError instanceof Error ? loadError.message : "Falha ao carregar a equipe")}</p> : null}
      {feedback ? <p className="mb-4 text-sm text-[var(--primary-text)]" role="status">{feedback}</p> : null}
      {data?.attendants.length ? (
        <div className="responsive-table-wrap">
          <table className="responsive-table settings-table-minwidth w-full text-left text-xs">
            <thead className="border-b border-[var(--border)] type-caption uppercase tracking-[.08em] text-[var(--text-muted)]">
              <tr>
                <th className="pb-3 font-medium">No pool</th>
                <th className="pb-3 font-medium">Atendente</th>
                <th className="pb-3 font-medium">Cor na agenda</th>
                <th className="pb-3 font-medium">Disponibilidade</th>
                <th className="pb-3 text-right font-medium">Carga ativa</th>
                <th className="pb-3 text-right font-medium">Controle</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {data.attendants.map((member) => {
                const selected = selectedIds.includes(member.member_id);
                const available = member.availability_status === "available";
                const persistedColor = member.cor_agenda ?? SETTINGS_COLOR_DEFAULTS.attendantCalendar;
                const colorDraft = colorDrafts[member.member_id] ?? persistedColor;
                const controls = attendantControlState({
                  canManage,
                  selected,
                  persistedInPool: member.selected,
                  status: member.availability_status,
                  changing: changingMemberId === member.member_id
                });
                return (
                  <tr key={member.member_id}>
                    <td data-label="No pool" className="py-3">
                      <input type="checkbox" checked={selected} disabled={!canManage || saving} aria-label={`Incluir ${member.email} no pool`} onChange={() => toggleMember(member.member_id)} />
                    </td>
                    <td data-label="Atendente" className="py-3">
                      <strong className="block text-sm">{member.email}{member.is_current ? " · você" : ""}</strong>
                      <span className="mono type-caption uppercase tracking-[.08em] text-[var(--text-muted)]">{member.funcao}</span>
                    </td>
                    <td data-label="Cor na agenda" className="py-3">
                      {selected ? (
                        <label className="inline-flex items-center gap-2">
                          <span className="sr-only">Cor de {member.email} na agenda</span>
                          <input
                            className="agenda-color-input"
                            type="color"
                            value={colorDraft}
                            disabled={!canManage || changingColorMemberId === member.member_id}
                            onChange={(event) => setColorDrafts((current) => ({
                              ...current,
                              [member.member_id]: event.target.value
                            }))}
                          />
                          <span className="mono type-caption text-[var(--text-muted)]">{colorDraft}</span>
                          <button
                            type="button"
                            className="btn px-2 py-1 type-caption"
                            disabled={
                              !canManage
                              || changingColorMemberId === member.member_id
                              || colorDraft.toUpperCase() === persistedColor.toUpperCase()
                            }
                            onClick={() => void setCalendarColor(member, colorDraft)}
                          >
                            Salvar cor
                          </button>
                        </label>
                      ) : <span className="text-[var(--text-muted)]">—</span>}
                    </td>
                    <td data-label="Disponibilidade" className="py-3">
                      {selected && member.availability_status ? (
                        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 type-caption font-medium ${available ? "border-[var(--success-border)] bg-[var(--success-subtle)] text-[var(--success-text)]" : "border-[var(--warning-border)] bg-[var(--warning-subtle)] text-[var(--warning-text)]"}`}>
                          <i className={`size-1.5 rounded-full ${available ? "bg-[var(--success)]" : "bg-[var(--warning)]"}`} aria-hidden="true" />
                          {availabilityLabel(member.availability_status)}
                        </span>
                      ) : <span className="text-[var(--text-muted)]">Fora do pool</span>}
                    </td>
                    <td data-label="Carga ativa" className="mono py-3 text-right font-semibold">{member.active_appointments}</td>
                    <td data-label="Controle" className="py-3">
                      <div className="flex justify-end gap-2">
                        <button type="button" className="btn px-2 py-1 type-caption" disabled={!controls.canSetAvailable} onClick={() => void setAvailability(member, "available")}>Disponível</button>
                        <button type="button" className="btn warn px-2 py-1 type-caption" disabled={!controls.canSetUnavailable} onClick={() => void setAvailability(member, "unavailable")}>Indisponível</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Empty>Nenhum membro ativo possui acesso de leitura e resposta a conversas.</Empty>}
      <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] pt-5">
        <span className="sub max-w-[76ch] text-xs">Ao remover alguém do pool, leads e conversas ativas e suas reuniões ativas são redistribuídos. Alterar a disponibilidade não remove o membro do rodízio.</span>
        {canManage ? <button className="btn primary" disabled={saving}><FloppyDisk size={16} aria-hidden="true" />{saving ? "Salvando…" : "Salvar equipe"}</button> : null}
      </div>
      </form>
    </PanelChassi>
  );
}

type AtendonMeetSettingsResponse = {
  settings: { enabled: boolean; available: boolean };
};

function AtendonMeetSettingsPanel({ canManage }: { canManage: boolean }) {
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    api<AtendonMeetSettingsResponse>("/scheduling/config/atendon-meet")
      .then((response) => {
        if (active) {
          setEnabled(response.settings.enabled);
          setAvailable(response.settings.available);
        }
      })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Falha ao carregar a configuração do AtendON Meet");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!available || !canManage || saving) return;
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const response = await api<AtendonMeetSettingsResponse>("/scheduling/config/atendon-meet", {
        method: "PUT",
        body: JSON.stringify({ enabled })
      });
      setEnabled(response.settings.enabled);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao salvar a configuração do AtendON Meet");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <PanelChassi headId="settings-atendon-meet" Icon={VideoCamera} title="Sala própria do AtendON" busy busyLabel="Carregando configuração do AtendON Meet" />
    );
  }

  return (
    <PanelChassi
      headId="settings-atendon-meet"
      Icon={VideoCamera}
      title="Sala própria do AtendON"
      sub="Cria uma sala protegida assim que o agendamento é confirmado. Participantes entram pelo link recebido e a equipe acessa pelo painel."
    >
      <form className="grid gap-6" onSubmit={submit}>
        <div className="min-w-0">
          <div className="flex flex-wrap items-start justify-between gap-5 border-b border-[var(--border)] pb-5">
            <label className="flex items-center gap-3 text-sm font-medium text-[var(--text-secondary)]">
              <input type="checkbox" checked={enabled} disabled={!available || !canManage || saving} onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }} />
              {enabled ? "Ativo" : "Inativo"}
            </label>
          </div>

          {error ? <p className="error mt-5" role="alert">{error}</p> : null}
          {!available ? <p className="mt-5 text-sm text-[var(--warning-text)]" role="status">A infraestrutura ainda está em validação. O Google Meet continua sendo usado nas novas reuniões.</p> : null}
          {saved ? <p className="mt-5 flex items-center gap-2 text-sm text-[var(--primary-text)]" role="status"><CheckCircle size={17} weight="fill" aria-hidden="true" /> Configuração salva.</p> : null}

          <dl className="mt-6 grid gap-5 sm:grid-cols-2">
            <div className="border-l border-[var(--border)] pl-4"><dt className="label">Criação</dt><dd className="mt-2 text-sm text-[var(--text-secondary)]">Ao confirmar o agendamento</dd></div>
            <div className="border-l border-[var(--border)] pl-4"><dt className="label">Acesso</dt><dd className="mt-2 text-sm text-[var(--text-secondary)]">Token temporário por sala</dd></div>
            <div className="border-l border-[var(--border)] pl-4"><dt className="label">Recursos</dt><dd className="mt-2 text-sm text-[var(--text-secondary)]">Vídeo, áudio, chat e compartilhamento de tela</dd></div>
            <div className="border-l border-[var(--border)] pl-4"><dt className="label">Gravações</dt><dd className="mt-2 text-sm text-[var(--text-secondary)]">Disponíveis nos detalhes do agendamento</dd></div>
          </dl>

          <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] pt-5">
            <span className="sub max-w-[58ch] text-xs">Quando ativo, o AtendON Meet tem prioridade sobre a integração Google Meet para novas reuniões.</span>
            {canManage ? <button className="btn primary active:scale-[.98]" disabled={!available || saving}><FloppyDisk size={16} aria-hidden="true" />{saving ? "Salvando…" : "Salvar AtendON Meet"}</button> : <span className="sub text-xs">Disponível somente para consulta.</span>}
          </div>
        </div>
      </form>
    </PanelChassi>
  );
}

type GoogleMeetCloser = {
  member_id: string;
  user_id: string;
  email: string;
  funcao: string;
};

type GoogleMeetSettingsResponse = {
  settings: {
    enabled: boolean;
    organizer_email: string | null;
    creation_moment: "appointment_confirmed";
    closer_member_ids: string[];
    oauth_email: string | null;
    oauth_connected_at: string | null;
    oauth_connected: boolean;
    oauth_available: boolean;
  };
  closers: GoogleMeetCloser[];
};

function GoogleMeetSettingsPanel({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<GoogleMeetSettingsResponse>();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const applyResponse = useCallback((response: GoogleMeetSettingsResponse) => {
    setData(response);
    setEnabled(response.settings.enabled);
  }, []);

  useEffect(() => {
    let active = true;
    api<GoogleMeetSettingsResponse>("/scheduling/config/google-meet")
      .then((response) => { if (active) applyResponse(response); })
      .catch((loadError: unknown) => {
        if (active) setError(loadError instanceof Error ? loadError.message : "Falha ao carregar a configuração do Google Meet");
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [applyResponse]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("meet_oauth");
    if (result === "connected") setSaved(true);
    if (result === "denied") setError("O login com o Google foi cancelado.");
    if (result === "error") setError("Não foi possível conectar a conta Google. Tente novamente.");
    if (result) {
      url.searchParams.delete("meet_oauth");
      window.history.replaceState({}, "", url);
    }
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage || saving) return;
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const response = await api<GoogleMeetSettingsResponse>("/scheduling/config/google-meet", {
        method: "PUT",
        body: JSON.stringify({
          enabled,
          closer_member_ids: data?.settings.closer_member_ids ?? []
        })
      });
      applyResponse(response);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao salvar a configuração do Google Meet");
    } finally {
      setSaving(false);
    }
  }

  async function connectGoogle() {
    if (!canManage || connecting) return;
    setConnecting(true);
    setError("");
    try {
      const response = await api<{ authorization_url: string }>("/scheduling/config/google-meet/oauth/start");
      window.location.assign(response.authorization_url);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Falha ao iniciar o login com o Google");
      setConnecting(false);
    }
  }

  async function disconnectGoogle() {
    if (!canManage || disconnecting || !window.confirm("Desconectar esta conta Google e desativar as reuniões automáticas?")) return;
    setDisconnecting(true);
    setError("");
    try {
      applyResponse(await api<GoogleMeetSettingsResponse>("/scheduling/config/google-meet/oauth", { method: "DELETE" }));
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : "Falha ao desconectar a conta Google");
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <PanelChassi headId="settings-google-meet" Icon={GoogleLogo} title="Google Meet" busy busyLabel="Carregando configuração do Google Meet" />
    );
  }

  const oauthConnected = data?.settings.oauth_connected ?? false;
  const oauthAvailable = data?.settings.oauth_available ?? false;
  const activationBlocked = enabled && (!oauthConnected || !data?.settings.closer_member_ids.length);

  return (
    <PanelChassi
      headId="settings-google-meet"
      Icon={GoogleLogo}
      title="Google Meet"
      sub="Cria uma sala pela API do Google Meet assim que o agendamento é confirmado. O fluxo não cria nem consulta eventos no Google Calendar."
    >
      <form className="grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,.65fr)]" onSubmit={submit}>
      <section className="border-b border-[var(--border)] pb-6 lg:border-b-0">
        <div className="mb-6 flex flex-wrap items-start justify-between gap-5 border-b border-[var(--border)] pb-5">
          <label className="flex items-center gap-3 text-sm font-medium text-[var(--text-secondary)]">
            <input type="checkbox" checked={enabled} disabled={!canManage} onChange={(event) => { setEnabled(event.target.checked); setSaved(false); }} />
            {enabled ? "Ativo" : "Inativo"}
          </label>
        </div>

        {error ? <p className="error mb-5" role="alert">{error}</p> : null}
        {saved ? <p className="mb-5 flex items-center gap-2 text-sm text-[var(--primary-text)]" role="status"><CheckCircle size={17} weight="fill" aria-hidden="true" /> Configuração salva.</p> : null}

        <fieldset className="mb-7 border-b border-[var(--border)] pb-7">
          <legend className="label flex items-center gap-2"><GoogleLogo size={17} weight="bold" aria-hidden="true" /> Conta Google</legend>
          <p className="sub mt-2 max-w-[68ch] text-xs">Entre com a conta que será dona das salas. O acesso renovável é criptografado no servidor; sua senha nunca passa pelo AtendON.</p>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-4 border-y border-[var(--border)] py-4">
            <div className="min-w-0">
              <strong className="block truncate text-sm text-[var(--text)]">{oauthConnected ? data?.settings.oauth_email : "Nenhuma conta conectada"}</strong>
              <span className="sub mt-1 block text-xs">{oauthConnected ? "Esta conta organiza os novos links do Meet." : "Use uma conta Google com acesso ao Meet."}</span>
            </div>
            {oauthConnected ? (
              <button type="button" className="btn warn active:scale-[0.98]" disabled={!canManage || disconnecting} onClick={() => void disconnectGoogle()}>
                <LinkBreak size={17} aria-hidden="true" /> {disconnecting ? "Desconectando…" : "Desconectar"}
              </button>
            ) : (
              <button type="button" className="btn primary active:scale-[0.98]" disabled={!canManage || connecting || !oauthAvailable} onClick={() => void connectGoogle()}>
                <GoogleLogo size={17} weight="bold" aria-hidden="true" /> {connecting ? "Abrindo Google…" : "Conectar com Google"}
              </button>
            )}
          </div>
          {!oauthAvailable ? <p className="error mt-3 text-xs">O Client ID OAuth do Google ainda não foi configurado no servidor.</p> : null}
        </fieldset>

        <div className="grid gap-5 md:grid-cols-2">
          <UiField label="Momento da criação">
            <Input value="Ao confirmar o agendamento" readOnly />
            <span className="sub text-xs">O mesmo link é salvo antes da confirmação chegar ao contato.</span>
          </UiField>
          <UiField label="Conta organizadora">
            <Input value={data?.settings.oauth_email ?? "Conecte uma conta Google"} readOnly />
            <span className="sub text-xs">Definida automaticamente pelo login OAuth.</span>
          </UiField>
        </div>

        <div className="mt-7 border-t border-[var(--border)] pt-5">
          <div className="flex items-center gap-2 text-sm font-medium text-[var(--text)]"><UsersThree size={17} aria-hidden="true" /> Pool compartilhado</div>
          <p className="sub mt-2 max-w-[68ch] text-xs">
            A integração usa os {data?.settings.closer_member_ids.length ?? 0} atendente(s) definidos na seção “Equipe de atendimento”. OAuth e criação da sala permanecem independentes da distribuição.
          </p>
        </div>

        {canManage ? (
          <div className="mt-7 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--border)] pt-5">
            <span className="sub text-xs">Ativar a sala automática exige uma conta Google conectada e ao menos um atendente no pool compartilhado.</span>
            <button className="btn primary active:scale-[0.98]" disabled={saving || activationBlocked}>
              <FloppyDisk aria-hidden="true" />
              {saving ? "Salvando…" : "Salvar Google Meet"}
            </button>
          </div>
        ) : <p className="sub mt-6 text-sm">Esta configuração está disponível somente para consulta.</p>}
      </section>

      <aside className="border-t border-[var(--border)] pt-5 lg:border-l lg:border-t-0 lg:pl-6 lg:pt-1" aria-label="Estado da integração com Google Meet">
        <h3 className="text-sm font-semibold text-[var(--text)]">Pré-requisitos da integração</h3>
        <div className="mt-5 grid gap-5">
          <div className="grid grid-cols-[32px_1fr] gap-3">
            <span className={`grid h-8 w-8 place-items-center rounded-full border ${oauthConnected ? "border-[var(--primary-border)] text-[var(--primary-text)]" : "border-[var(--warning-border)] text-[var(--warning-text)]"}`}>
              {oauthConnected ? <CheckCircle size={17} weight="fill" aria-hidden="true" /> : <WarningCircle size={17} weight="fill" aria-hidden="true" />}
            </span>
            <div><strong className="block text-sm text-[var(--text)]">Login OAuth</strong><p className="sub mt-1 text-xs leading-relaxed">{oauthConnected ? `Conta ${data?.settings.oauth_email ?? "Google"} pronta para criar salas.` : "Conecte a conta Google que organizará as reuniões."}</p></div>
          </div>
          <div className="grid grid-cols-[32px_1fr] gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-full border border-[var(--border)] text-[var(--primary-text)]"><VideoCamera size={16} aria-hidden="true" /></span>
            <div><strong className="block text-sm text-[var(--text)]">API Meet, sem Calendar</strong><p className="sub mt-1 text-xs leading-relaxed">A sala nasce em <span className="mono">meet.googleapis.com/v2/spaces</span> e fica vinculada ao agendamento interno.</p></div>
          </div>
          <div className="grid grid-cols-[32px_1fr] gap-3">
            <span className="grid h-8 w-8 place-items-center rounded-full border border-[var(--border)] text-[var(--primary-text)]"><UsersThree size={16} aria-hidden="true" /></span>
            <div><strong className="block text-sm text-[var(--text)]">Pool compartilhado</strong><p className="sub mt-1 text-xs leading-relaxed">A sala usa o responsável escolhido pela distribuição configurada na equipe de atendimento.</p></div>
          </div>
        </div>
      </aside>
      </form>
    </PanelChassi>
  );
}



function Summary({ resource, item }: { resource: CatalogResource; item: CatalogItem }) {
  if (resource === "categorias") return <span>{item.ativa ? "Ativa" : "Inativa"}</span>;
  if (resource === "parceiros") return <span>Prioridade {item.ordem_prioridade} · {item.ativo ? "Ativo" : "Inativo"}<br />{item.link_proposta}</span>;
  return <span>{item.horario_abertura}–{item.horario_fechamento} · {item.duracao_slot_min} min<br />{item.capacidade_simultanea} simultâneo(s) · dias {(item.dias_funcionamento ?? []).join(", ")}</span>;
}

function Editor({ resource, item, onCancel, onSaved, onError }: { resource: CatalogResource; item: CatalogItem; onCancel: () => void; onSaved: () => void; onError: (value: string) => void }) {
  const existing = Boolean(item.id);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const payload: CatalogItem = { id: String(formData.get("id")), nome: String(formData.get("nome")) };
    if (resource === "categorias") payload.ativa = formData.get("ativa") === "on";
    if (resource === "parceiros") Object.assign(payload, { ordem_prioridade: Number(formData.get("ordem_prioridade")), link_proposta: String(formData.get("link_proposta")), ativo: formData.get("ativo") === "on" });
    if (resource === "unidades") Object.assign(payload, { horario_abertura: String(formData.get("horario_abertura")), horario_fechamento: String(formData.get("horario_fechamento")), dias_funcionamento: formData.getAll("dias_funcionamento").map(Number), duracao_slot_min: Number(formData.get("duracao_slot_min")), capacidade_simultanea: Number(formData.get("capacidade_simultanea")) });
    setSaving(true);
    onError("");
    try {
      await api(`/scheduling/config/${resource}${existing ? `/${item.id}` : ""}`, { method: existing ? "PUT" : "POST", body: JSON.stringify(payload) });
      await onSaved();
    } catch (saveError) {
      onError(saveError instanceof Error ? saveError.message : "Falha ao salvar");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={`card ${styles.form}`} onSubmit={submit}>
      <div className="cardtitle">{existing ? "Editar" : "Novo"} {resource.slice(0, -1)}</div>
      <div className={styles.fieldGrid}>
        <UiField label="ID (slug)"><Input name="id" required pattern="[a-z0-9]+(?:-[a-z0-9]+)*" defaultValue={item.id ?? ""} readOnly={existing} /></UiField>
        <UiField label="Nome"><Input name="nome" required defaultValue={item.nome ?? ""} /></UiField>
        {resource === "categorias" ? <Toggle name="ativa" label="Categoria ativa" checked={item.ativa ?? true} /> : null}
        {resource === "parceiros" ? <><UiField label="Ordem de prioridade"><Input name="ordem_prioridade" type="number" min="1" required defaultValue={item.ordem_prioridade ?? 1} /></UiField><UiField label="Link da proposta"><Input name="link_proposta" type="url" required defaultValue={item.link_proposta ?? ""} /></UiField><Toggle name="ativo" label="Parceiro ativo" checked={item.ativo ?? true} /></> : null}
        {resource === "unidades" ? <><div className={styles.fieldGrid}><UiField label="Abertura"><Input name="horario_abertura" type="time" required defaultValue={item.horario_abertura ?? "09:00"} /></UiField><UiField label="Fechamento"><Input name="horario_fechamento" type="time" required defaultValue={item.horario_fechamento ?? "18:00"} /></UiField></div><UiField label="Dias de funcionamento"><div className={styles.choiceGrid}>{["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"].map((label, index) => <label key={label} className={styles.choice}><input type="checkbox" name="dias_funcionamento" value={index} defaultChecked={(item.dias_funcionamento ?? [1, 2, 3, 4, 5]).includes(index)} />{label}</label>)}</div></UiField><div className={styles.fieldGrid}><UiField label="Duração (min)"><Input name="duracao_slot_min" type="number" min="1" required defaultValue={item.duracao_slot_min ?? 60} /></UiField><UiField label="Capacidade"><Input name="capacidade_simultanea" type="number" min="1" required defaultValue={item.capacidade_simultanea ?? 1} /></UiField></div></> : null}
      </div>
      <div className={styles.saveActions}>
        <Button type="button" onClick={onCancel}>Cancelar</Button>
        <Button type="submit" tone="primary" disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
      </div>
    </form>
  );
}

function Toggle({ name, label, checked, disabled=false }: { name: string; label: string; checked: boolean; disabled?:boolean }) {
  return <label className="flex items-center gap-3 text-sm text-[var(--text-secondary)]"><input type="checkbox" name={name} defaultChecked={checked} disabled={disabled}/>{label}</label>;
}
