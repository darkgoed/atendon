"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import useSWR from "swr";
import {
  BellRinging,
  BellSimple,
  Buildings,
  CalendarCheck,
  CalendarDots,
  ChartBar,
  ChatCircleDots,
  ClockCountdown,
  Cpu,
  GoogleLogo,
  Handshake,
  HardDrives,
  Link as LinkIcon,
  Queue,
  ShieldCheck,
  SlidersHorizontal,
  Sticker,
  TagSimple,
  UserList,
  UsersThree,
  VideoCamera,
  Watch,
  type Icon
} from "@/components/icons";
import { api } from "@/lib/api";
import { attendantPoolAccess } from "@/lib/attendants";
import { useCapabilities } from "@/lib/capabilities";
import { settingsNavGroups, type SettingsNavKey } from "@/lib/panel-manifest";
import {
  canAccessRootWorkspace,
  canAccessWithSession,
  hasWorkspaceWideCaseScope,
  type PanelSession
} from "@/lib/session";
import { usePermission } from "@/lib/use-permission";

// Chaves do manifest: abas (sem "/") viram Links /configuracoes/<key>; chaves
// de destino ("/…") eram hrefs legados e são remapeadas para as novas sub-rotas.
type TabKey = Exclude<SettingsNavKey, `/${string}`>;
type DestinationKey = Exclude<SettingsNavKey, TabKey>;

const tabLabels: Record<TabKey, string> = {
  workspace: "Geral",
  categorias: "Categorias",
  parceiros: "Parceiros",
  unidades: "Unidades",
  attendants: "Equipe de atendimento",
  "conversation-queues": "Filas de atendimento",
  "atendon-meet": "AtendON Meet",
  "google-meet": "Google Meet",
  "google-calendar": "Google Agenda",
  signature: "Assinatura do atendente",
  "panel-notifications": "Notificações do painel",
  "agenda-notifications": "Notificações de agendamento",
  armazenamento: "Armazenamento"
};

// Mesmos ícones do rail atual (resourceIcons do hub) — nada visual novo.
const tabIcons: Record<TabKey, Icon> = {
  workspace: SlidersHorizontal,
  categorias: TagSimple,
  parceiros: Handshake,
  unidades: Buildings,
  attendants: UserList,
  "conversation-queues": Queue,
  "atendon-meet": VideoCamera,
  "google-meet": GoogleLogo,
  "google-calendar": CalendarDots,
  signature: ChatCircleDots,
  "panel-notifications": BellSimple,
  "agenda-notifications": CalendarCheck,
  armazenamento: HardDrives
};

type Destination = {
  label: string;
  Icon: Icon;
  rootWorkspaceOnly?: boolean;
  permission?: string;
};

// Gating idêntico ao settingsDestinations do hub (rootWorkspaceOnly OU permissão).
const destinations: Record<DestinationKey, Destination> = {
  "/alertas": { label: "Alertas", Icon: BellRinging, rootWorkspaceOnly: true },
  "/conexao": { label: "Conexão", Icon: LinkIcon, permission: "connection.read" },
  "/workspace/members": { label: "Membros", Icon: UsersThree, permission: "members.read" },
  "/workspace/audit": { label: "Auditoria", Icon: Watch, permission: "audit.read" },
  "/workspace/roles": { label: "Funções", Icon: ShieldCheck, rootWorkspaceOnly: true },
  "/agente": { label: "Agente", Icon: Cpu, rootWorkspaceOnly: true },
  "/follow-ups": { label: "Follow-ups da IA", Icon: Sticker, rootWorkspaceOnly: true },
  "/humanizacao": { label: "Humanização", Icon: ClockCountdown, rootWorkspaceOnly: true },
  "/uso": { label: "Uso", Icon: ChartBar, rootWorkspaceOnly: true }
};

// Destinos legados → sub-rotas do hub.
const destinationHrefs: Record<DestinationKey, string> = {
  "/alertas": "/configuracoes/alertas",
  "/conexao": "/configuracoes/conexao",
  "/workspace/members": "/configuracoes/membros",
  "/workspace/audit": "/configuracoes/auditoria",
  "/workspace/roles": "/configuracoes/funcoes",
  "/agente": "/configuracoes/agente",
  "/follow-ups": "/configuracoes/follow-ups",
  "/humanizacao": "/configuracoes/humanizacao",
  "/uso": "/configuracoes/uso"
};

const settingsGroupSlug = (label: string) =>
  label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

type NavEntry = { key: string; href: string; label: string; Icon: Icon };

export function SettingsSidebar() {
  const pathname = usePathname();
  const { isEnabled } = useCapabilities();
  const leadsEnabled = isEnabled("leads_v1");
  const appointmentsEnabled = isEnabled("appointments_v1");
  const canUpdateWorkspace = usePermission("workspace.update");
  const canReadCategories = usePermission("categories.read");
  const canReadPartners = usePermission("partners.read");
  const canReadUnits = usePermission("units.read");
  const canManageUnits = usePermission("units.manage");
  const canReadSignature = usePermission("signature.read");
  const canManageStorage = usePermission("storage.manage");
  const hasAgendaNotificationsReadPermission = usePermission("scheduling_notifications.read");
  const canManageQueues = usePermission("conversations.queues.manage");
  const { data: session } = useSWR<PanelSession>("/me", (url: string) => api<PanelSession>(url), {
    revalidateOnFocus: false,
    dedupingInterval: 10_000
  });
  // Mesmo gating do pool de atendentes do hub (escopo amplo + unidades).
  const attendantAccess = attendantPoolAccess({
    hasWorkspaceScope: Boolean(session && hasWorkspaceWideCaseScope(session)),
    canReadUnits,
    canManageUnits
  });

  const tabVisible: Partial<Record<TabKey, boolean>> = {
    workspace: canUpdateWorkspace,
    categorias: leadsEnabled && canReadCategories,
    parceiros: leadsEnabled && canReadPartners,
    unidades: leadsEnabled && canReadUnits,
    attendants: attendantAccess.canRead,
    "conversation-queues": canManageQueues,
    "atendon-meet": appointmentsEnabled && canReadUnits,
    "google-meet": appointmentsEnabled && canReadUnits,
    "google-calendar": appointmentsEnabled && canReadUnits,
    signature: canReadSignature,
    "panel-notifications": Boolean(session?.activeWorkspace),
    "agenda-notifications": appointmentsEnabled && hasAgendaNotificationsReadPermission,
    armazenamento: canManageStorage
  };
  // Raiz legada /configuracoes exibe a primeira aba visível (visibleTabs[0]);
  // a sidebar marca essa mesma entrada como atual.
  const firstVisibleKey = Object.keys(tabVisible).find((key) => tabVisible[key as TabKey]);

  const destinationVisible = (destination: Destination) => {
    if (!session) return false;
    return destination.rootWorkspaceOnly
      ? canAccessRootWorkspace(session)
      : Boolean(destination.permission && canAccessWithSession(session, [destination.permission]));
  };

  const isActive = (href: string) =>
    pathname === href ||
    pathname.startsWith(`${href}/`) ||
    (pathname === "/configuracoes" && href === `/configuracoes/${firstVisibleKey}`);

  const groups = settingsNavGroups
    .map((group) => ({
      label: group.label,
      entries: group.keys.flatMap((key): NavEntry[] => {
        if (key.startsWith("/")) {
          const destination = destinations[key as DestinationKey];
          if (!destination || !destinationVisible(destination)) return [];
          return [{
            key,
            href: destinationHrefs[key as DestinationKey],
            label: destination.label,
            Icon: destination.Icon
          }];
        }
        if (!tabVisible[key as TabKey]) return [];
        return [{
          key,
          href: `/configuracoes/${key}`,
          label: tabLabels[key as TabKey],
          Icon: tabIcons[key as TabKey]
        }];
      })
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <nav className="settings-rail" aria-label="Configurações">
      {groups.map((group) => {
        const headId = `settings-group-${settingsGroupSlug(group.label)}`;
        return (
          <section key={group.label} className="settings-rail__group" aria-labelledby={headId}>
            <div className="settings-rail__grouphead">
              <h2 id={headId}>{group.label}</h2>
            </div>
            <div className="settings-rail__nav">
              {group.entries.map((entry) => (
                <Link
                  key={entry.key}
                  href={entry.href}
                  className="settings-rail__link"
                  aria-current={isActive(entry.href) ? "page" : undefined}
                >
                  <entry.Icon size={18} aria-hidden="true" />
                  <span><strong>{entry.label}</strong></span>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </nav>
  );
}
