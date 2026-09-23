"use client";

/**
 * Biblioteca de ícones do AtendON — Design System v2.
 *
 * O handoff (handoff/referencia/*.dc.html) desenha TODOS os ícones com o
 * vocabulário Lucide: viewBox 24, fill none, stroke currentColor, linecap e
 * linejoin round, stroke 1.8 nos ícones de 16–18px e 2 nos ícones pequenos
 * (≤15px). Este módulo é a ÚNICA fonte de ícones do painel:
 *
 * - glifos que o handoff desenha à mão (rail, topbar, composer, fluxo,
 *   pipeline) são copiados byte a byte dos .dc.html (HANDOFF_* abaixo);
 * - o resto vem do lucide-react, a mesma família do handoff.
 *
 * Os nomes exportados mantêm a API antiga (Gauge, ChatsCircle, Kanban…) para
 * que as telas troquem só o `from`; `weight` é aceito por compatibilidade e
 * traduzido para espessura de traço (bold = 2.2, demais = padrão do handoff).
 */

import {
  Archive as LArchive,
  ArrowDown as LArrowDown,
  ArrowDownToLine,
  ArrowLeft as LArrowLeft,
  ArrowUp as LArrowUp,
  ArrowUpRight as LArrowUpRight,
  Ban,
  BellOff,
  BellRing,
  Bookmark,
  Bot,
  Building2,
  Calendar,
  CalendarCheck as LCalendarCheck,
  CalendarX as LCalendarX,
  ChartColumn,
  Check as LCheck,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  CircleAlert,
  CircleCheck,
  Clock as LClock,
  Compass as LCompass,
  Contact,
  Copy as LCopy,
  Cpu as LCpu,
  CreditCard as LCreditCard,
  DoorOpen as LDoorOpen,
  Download,
  Eye as LEye,
  EyeOff,
  File as LFile,
  FileDown,
  FileImage as LFileImage,
  FileText as LFileText,
  FileUp,
  FileVideo as LFileVideo,
  Flag as LFlag,
  FlaskConical,
  GitBranch as LGitBranch,
  GitFork as LGitFork,
  Globe,
  HandHeart as LHandHeart,
  Handshake as LHandshake,
  HardDrive,
  History,
  Hourglass as LHourglass,
  Image as LImage,
  Info as LInfo,
  Key as LKey,
  Keyboard as LKeyboard,
  Link as LLink,
  List as LList,
  ListChecks as LListChecks,
  LoaderCircle,
  Lock as LLock,
  MapPin as LMapPin,
  Megaphone as LMegaphone,
  MessageCircleMore,
  MessageSquareText,
  Minus as LMinus,
  Moon as LMoon,
  MousePointerClick,
  NotebookPen,
  NotepadText,
  PanelLeft,
  PhoneCall as LPhoneCall,
  Plane,
  Plug as LPlug,
  PlugZap,
  Plus as LPlus,
  Pointer,
  Power as LPower,
  RefreshCw,
  Reply,
  RotateCcw,
  RotateCw,
  Rows3,
  Save,
  ScanFace,
  Send,
  Settings,
  ShieldCheck as LShieldCheck,
  ShieldOff,
  Smartphone,
  Square,
  Star as LStar,
  Sticker as LSticker,
  Sun as LSun,
  Tag as LTag,
  Target as LTarget,
  Timer,
  Trash2,
  TriangleAlert,
  Undo2,
  Unlink,
  Upload,
  User as LUser,
  UserCog,
  UserMinus as LUserMinus,
  UserPlus as LUserPlus,
  Vault as LVault,
  Video,
  Volume2,
  WandSparkles,
  Watch as LWatch,
  Webhook,
  Workflow,
  createLucideIcon,
  type LucideIcon,
  type LucideProps
} from "lucide-react";
import { forwardRef, type ForwardRefExoticComponent, type RefAttributes } from "react";

export type IconWeight = "thin" | "light" | "regular" | "bold" | "fill" | "duotone";

export type IconProps = Omit<LucideProps, "ref"> & {
  /** Compat com a API antiga: bold engrossa o traço; os demais usam o padrão do handoff. */
  weight?: IconWeight;
  mirrored?: boolean;
};

export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

/** Espessura do handoff: 1.8 em 16–18px (helper `I()` dos .dc.html), 2 nos pequenos. */
export function handoffStroke(size: number | string | undefined, weight?: IconWeight): number {
  if (weight === "bold") return 2.2;
  if (weight === "thin" || weight === "light") return 1.5;
  const px = typeof size === "number" ? size : Number.parseFloat(String(size ?? 24));
  return Number.isFinite(px) && px <= 15 ? 2 : 1.8;
}

function wrap(Base: LucideIcon, name: string): Icon {
  const Wrapped = forwardRef<SVGSVGElement, IconProps>(function HandoffIcon(
    { weight, mirrored, size = 16, strokeWidth, style, ...props },
    ref
  ) {
    return (
      <Base
        ref={ref}
        size={size}
        strokeWidth={strokeWidth ?? handoffStroke(size, weight)}
        style={mirrored ? { transform: "scaleX(-1)", ...style } : style}
        {...props}
      />
    );
  });
  Wrapped.displayName = name;
  return Wrapped as Icon;
}

type IconNode = Parameters<typeof createLucideIcon>[1];

/** Glifo desenhado à mão no handoff (copiado dos .dc.html, sem alteração de path). */
function handoff(name: string, node: IconNode): Icon {
  return wrap(createLucideIcon(name, node), name);
}

/* ------------------------------------------------ glifos do handoff ------ */
// Rail — Painel (Painel.dc.html RAIL[0])
const HANDOFF_PAINEL = handoff("Painel", [
  ["rect", { x: "3", y: "3", width: "7", height: "7", rx: "1.5", key: "a" }],
  ["rect", { x: "14", y: "3", width: "7", height: "7", rx: "1.5", key: "b" }],
  ["rect", { x: "14", y: "14", width: "7", height: "7", rx: "1.5", key: "c" }],
  ["rect", { x: "3", y: "14", width: "7", height: "7", rx: "1.5", key: "d" }]
]);
// Rail — Conversas / KPI "Conversas iniciadas" / "Conversar"
const HANDOFF_CONVERSAS = handoff("Conversas", [
  ["path", { d: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z", key: "a" }]
]);
// Rail — Pipeline (três colunas)
const HANDOFF_PIPELINE = handoff("Pipeline", [
  ["path", { d: "M6 5v11", key: "a" }],
  ["path", { d: "M12 5v6", key: "b" }],
  ["path", { d: "M18 5v14", key: "c" }]
]);
// Rail — Tarefas
const HANDOFF_TAREFAS = handoff("Tarefas", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "3", key: "a" }],
  ["path", { d: "m9 12 2 2 4-4", key: "b" }]
]);
// Rail — Agentes IA / Fluxos
const HANDOFF_AGENTES = handoff("AgentesIA", [
  ["path", { d: "M12 8V4H8", key: "a" }],
  ["rect", { x: "4", y: "8", width: "16", height: "12", rx: "2", key: "b" }],
  ["path", { d: "M2 14h2", key: "c" }],
  ["path", { d: "M20 14h2", key: "d" }],
  ["path", { d: "M15 13v2", key: "e" }],
  ["path", { d: "M9 13v2", key: "f" }]
]);
// Rail — Agenda / KPI "Agendamentos"
const HANDOFF_AGENDA = handoff("Agenda", [
  ["rect", { x: "3", y: "4", width: "18", height: "18", rx: "2", key: "a" }],
  ["path", { d: "M16 2v4", key: "b" }],
  ["path", { d: "M8 2v4", key: "c" }],
  ["path", { d: "M3 10h18", key: "d" }]
]);
// Rail — Mais
const HANDOFF_MAIS = handoff("Mais", [
  ["circle", { cx: "5", cy: "12", r: "1", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "1", key: "b" }],
  ["circle", { cx: "19", cy: "12", r: "1", key: "c" }]
]);
const HANDOFF_MAIS_VERTICAL = handoff("MaisVertical", [
  ["circle", { cx: "12", cy: "5", r: "1", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "1", key: "b" }],
  ["circle", { cx: "12", cy: "19", r: "1", key: "c" }]
]);
// Rail — Contatos (Conversas.dc.html RAIL[2]; difere do lucide-react 1.47 em 3.13/7.75)
const HANDOFF_CONTATOS = handoff("Contatos", [
  ["path", { d: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", key: "a" }],
  ["circle", { cx: "9", cy: "7", r: "4", key: "b" }],
  ["path", { d: "M22 21v-2a4 4 0 0 0-3-3.87", key: "c" }],
  ["path", { d: "M16 3.13a4 4 0 0 1 0 7.75", key: "d" }]
]);
// Rail/topbar/paleta — Buscar (4.3, não o 4.34 do lucide-react)
const HANDOFF_BUSCAR = handoff("Buscar", [
  ["circle", { cx: "11", cy: "11", r: "8", key: "a" }],
  ["path", { d: "m21 21-4.3-4.3", key: "b" }]
]);
// Menus de item ("Mais opções", "Opções da etapa"): pontos cheios r=1.7
const HANDOFF_OPCOES = handoff("Opcoes", [
  ["circle", { cx: "5", cy: "12", r: "1.7", fill: "currentColor", stroke: "none", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "1.7", fill: "currentColor", stroke: "none", key: "b" }],
  ["circle", { cx: "19", cy: "12", r: "1.7", fill: "currentColor", stroke: "none", key: "c" }]
]);
const HANDOFF_OPCOES_VERTICAL = handoff("OpcoesVertical", [
  ["circle", { cx: "12", cy: "5", r: "1.7", fill: "currentColor", stroke: "none", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "1.7", fill: "currentColor", stroke: "none", key: "b" }],
  ["circle", { cx: "12", cy: "19", r: "1.7", fill: "currentColor", stroke: "none", key: "c" }]
]);
// Thread — Transferir
const HANDOFF_TRANSFERIR = handoff("Transferir", [
  ["path", { d: "M8 3 4 7l4 4", key: "a" }],
  ["path", { d: "M4 7h16", key: "b" }],
  ["path", { d: "m16 21 4-4-4-4", key: "c" }],
  ["path", { d: "M20 17H4", key: "d" }]
]);
// Painel de contato — Briefing (clipboard)
const HANDOFF_CLIPBOARD = handoff("Briefing", [
  ["rect", { x: "8", y: "2", width: "8", height: "4", rx: "1", key: "a" }],
  ["path", { d: "M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2", key: "b" }]
]);
// Composer — Gravar áudio
const HANDOFF_MIC = handoff("GravarAudio", [
  ["rect", { x: "9", y: "2", width: "6", height: "13", rx: "3", key: "a" }],
  ["path", { d: "M19 10v2a7 7 0 0 1-14 0v-2", key: "b" }],
  ["path", { d: "M12 19v3", key: "c" }]
]);
// Pausar (player de áudio): barras cheias
const HANDOFF_PAUSE = handoff("Pausar", [
  ["rect", { x: "6", y: "4", width: "4", height: "16", rx: "1", fill: "currentColor", stroke: "none", key: "a" }],
  ["rect", { x: "14", y: "4", width: "4", height: "16", rx: "1", fill: "currentColor", stroke: "none", key: "b" }]
]);
/* Blocos do fluxo — Fluxo.dc.html `const K` (paths idênticos). */
const FLOW_GATILHO = handoff("BlocoGatilho", [
  ["path", { d: "M12 22v-5", key: "a" }],
  ["path", { d: "M9 8V2", key: "b" }],
  ["path", { d: "M15 8V2", key: "c" }],
  ["path", { d: "M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z", key: "d" }]
]);
const FLOW_OPCOES = handoff("BlocoOpcoes", [
  ["path", { d: "M8 6h13", key: "a" }],
  ["path", { d: "M8 12h13", key: "b" }],
  ["path", { d: "M8 18h13", key: "c" }],
  ["path", { d: "M3 6h.01", key: "d" }],
  ["path", { d: "M3 12h.01", key: "e" }],
  ["path", { d: "M3 18h.01", key: "f" }]
]);
const FLOW_SIMNAO = handoff("BlocoSimNao", [
  ["circle", { cx: "6", cy: "6", r: "3", key: "a" }],
  ["circle", { cx: "18", cy: "6", r: "3", key: "b" }],
  ["circle", { cx: "12", cy: "18", r: "3", key: "c" }],
  ["path", { d: "M6 9v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9", key: "d" }],
  ["path", { d: "M12 12v3", key: "e" }]
]);
const FLOW_TEXTO = handoff("BlocoTexto", [
  ["rect", { x: "2", y: "4", width: "20", height: "16", rx: "2", key: "a" }],
  ["path", { d: "M6 8h.01", key: "b" }],
  ["path", { d: "M10 8h.01", key: "c" }],
  ["path", { d: "M14 8h.01", key: "d" }],
  ["path", { d: "M7 16h10", key: "e" }]
]);
const FLOW_FINALIZAR = handoff("BlocoFinalizar", [
  ["path", { d: "M12 2v10", key: "a" }],
  ["path", { d: "M18.4 6.6a9 9 0 1 1-12.77.04", key: "b" }]
]);
const FLOW_ESPERA = handoff("BlocoEspera", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "a" }],
  ["path", { d: "M12 6v6l4 2", key: "b" }]
]);
const FLOW_AGUARDAR = handoff("BlocoAguardar", [
  ["path", { d: "M5 22h14", key: "a" }],
  ["path", { d: "M5 2h14", key: "b" }],
  ["path", { d: "M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22", key: "c" }],
  ["path", { d: "M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2", key: "d" }]
]);
const TAG_PATH = "M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z";
const FLOW_ADDTAG = handoff("BlocoAddTag", [
  ["path", { d: TAG_PATH, key: "a" }],
  ["circle", { cx: "7.5", cy: "7.5", r: ".5", fill: "currentColor", key: "b" }]
]);
const FLOW_RMTAG = handoff("BlocoRmTag", [
  ["path", { d: TAG_PATH, key: "a" }],
  ["path", { d: "M8 8l6 6", key: "b" }]
]);
const FLOW_AGENTE = handoff("BlocoAgente", [
  ["circle", { cx: "12", cy: "8", r: "4", key: "a" }],
  ["path", { d: "M4 21v-1a6 6 0 0 1 12 0v1", key: "b" }],
  ["path", { d: "m17 11 2 2 4-4", key: "c" }]
]);
const FLOW_WEBHOOK = handoff("BlocoWebhook", [
  ["path", { d: "M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2", key: "a" }],
  ["path", { d: "m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06", key: "b" }],
  ["path", { d: "m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8", key: "c" }]
]);
// Canvas — Aproximar / Afastar (Fluxo.dc.html, 14px traço 2)
const HANDOFF_MAIS_ZOOM = handoff("Aproximar", [
  ["path", { d: "M12 5v14", key: "a" }],
  ["path", { d: "M5 12h14", key: "b" }]
]);
const HANDOFF_MENOS_ZOOM = handoff("Afastar", [["path", { d: "M5 12h14", key: "a" }]]);
// Canvas — Remover bloco
const HANDOFF_FECHAR = handoff("Fechar", [
  ["path", { d: "M18 6 6 18", key: "a" }],
  ["path", { d: "m6 6 12 12", key: "b" }]
]);

// Rail rodapé — AtendON (marca)
const HANDOFF_ATENDON = handoff("AtendON", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "5", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "3.5", key: "b" }]
]);
// Rail rodapé — Perfil
const HANDOFF_PERFIL = handoff("Perfil", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "a" }],
  ["circle", { cx: "12", cy: "10", r: "3", key: "b" }],
  ["path", { d: "M7 20.662V19a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v1.662", key: "c" }]
]);
// Rail rodapé — Sair
const HANDOFF_SAIR = handoff("Sair", [
  ["path", { d: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", key: "a" }],
  ["path", { d: "m16 17 5-5-5-5", key: "b" }],
  ["path", { d: "M21 12H9", key: "c" }]
]);
// Topbar — Notificações
const HANDOFF_SINO = handoff("Notificacoes", [
  ["path", { d: "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9", key: "a" }],
  ["path", { d: "M10.3 21a1.94 1.94 0 0 0 3.4 0", key: "b" }]
]);
// Topbar — Novidades (sparkle de 4 pontas)
const HANDOFF_NOVIDADES = handoff("Novidades", [
  ["path", { d: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z", key: "a" }]
]);
// Lista de conversas — Filtros
const HANDOFF_FILTROS = handoff("Filtros", [
  ["path", { d: "M22 3H2l8 9.46V19l4 2v-8.54L22 3z", key: "a" }]
]);
// Thread — Etapa comercial / KPI "Taxa de conversão"
const HANDOFF_ETAPA = handoff("EtapaComercial", [
  ["path", { d: "M3 3v18h18", key: "a" }],
  ["path", { d: "m7 14 4-4 3 3 5-6", key: "b" }]
]);
// Próxima ação — Editar
const HANDOFF_EDITAR = handoff("Editar", [
  ["path", { d: "M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z", key: "a" }]
]);
// Composer — Anexar
const HANDOFF_ANEXAR = handoff("Anexar", [
  ["path", { d: "m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48", key: "a" }]
]);
// Fluxo — Simular / play
const HANDOFF_PLAY = handoff("Simular", [
  ["path", { d: "M6 3l14 9-14 9z", key: "a" }]
]);
// Fluxo — Organizar
const HANDOFF_ORGANIZAR = handoff("Organizar", [
  ["rect", { x: "3", y: "3", width: "7", height: "7", rx: "1.5", key: "a" }],
  ["rect", { x: "14", y: "14", width: "7", height: "7", rx: "1.5", key: "b" }],
  ["path", { d: "M10 6.5h4a2 2 0 0 1 2 2V14", key: "c" }]
]);
// Fluxo — Ajustar à tela
const HANDOFF_AJUSTAR = handoff("AjustarATela", [
  ["path", { d: "M8 3H5a2 2 0 0 0-2 2v3", key: "a" }],
  ["path", { d: "M21 8V5a2 2 0 0 0-2-2h-3", key: "b" }],
  ["path", { d: "M3 16v3a2 2 0 0 0 2 2h3", key: "c" }],
  ["path", { d: "M16 21h3a2 2 0 0 0 2-2v-3", key: "d" }]
]);
// Pipeline — Avançar etapa
const HANDOFF_AVANCAR = handoff("AvancarEtapa", [
  ["path", { d: "M5 12h14", key: "a" }],
  ["path", { d: "m12 5 7 7-7 7", key: "b" }]
]);
// Pipeline — Detalhes
const HANDOFF_DETALHES = handoff("Detalhes", [
  ["path", { d: "M7 7h10v10", key: "a" }],
  ["path", { d: "M7 17 17 7", key: "b" }]
]);
// Painel — Personalizar painel
const HANDOFF_PERSONALIZAR = handoff("Personalizar", [
  ["path", { d: "M20 7h-9", key: "a" }],
  ["path", { d: "M14 17H5", key: "b" }],
  ["circle", { cx: "17", cy: "17", r: "3", key: "c" }],
  ["circle", { cx: "7", cy: "7", r: "3", key: "d" }]
]);
// Painel — KPI "Vendas"
const HANDOFF_VENDAS = handoff("Vendas", [
  ["circle", { cx: "12", cy: "12", r: "10", key: "a" }],
  ["path", { d: "m9 12 2 2 4-4", key: "b" }]
]);
// Painel — KPI "Valor vendido"
const HANDOFF_VALOR = handoff("ValorVendido", [
  ["path", { d: "M12 2v20", key: "a" }],
  ["path", { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6", key: "b" }]
]);
// Canais (Conversas.dc.html const WA / const IG)
const HANDOFF_WHATSAPP = handoff("WhatsApp", [
  ["path", { d: "M7.9 20A9 9 0 1 0 4 16.1L2 22Z", fill: "currentColor", stroke: "none", key: "a" }]
]);
const HANDOFF_INSTAGRAM = handoff("Instagram", [
  ["rect", { x: "3", y: "3", width: "18", height: "18", rx: "5", key: "a" }],
  ["circle", { cx: "12", cy: "12", r: "4", key: "b" }]
]);
// Marcas sem glifo no handoff nem no Lucide 1.x — mesmo traço da família.
const BRAND_FACEBOOK = handoff("Facebook", [
  ["path", { d: "M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z", key: "a" }]
]);
const BRAND_GOOGLE = handoff("Google", [
  ["path", { d: "M21.5 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3", key: "a" }],
  ["path", { d: "M15.4 17.1A6 6 0 0 1 6.3 14", key: "b" }],
  ["path", { d: "M6.3 10a6 6 0 0 1 9.4-3", key: "c" }],
  ["path", { d: "M20.6 17A10 10 0 1 1 18.8 5.1", key: "d" }]
]);

/* ------------------------------------------------ API pública ------------ */
// Navegação principal (glifos do rail do handoff)
export const Gauge = HANDOFF_PAINEL;
export const ChatsCircle = HANDOFF_CONVERSAS;
export const ChatText = wrap(MessageSquareText, "ChatText");
export const ChatCircleDots = wrap(MessageCircleMore, "ChatCircleDots");
export const Kanban = HANDOFF_PIPELINE;
export const CheckSquare = HANDOFF_TAREFAS;
export const Robot = HANDOFF_AGENTES;
export const FlowArrow = wrap(Workflow, "FlowArrow");
export const CalendarDots = HANDOFF_AGENDA;
export const CalendarBlank = wrap(Calendar, "CalendarBlank");
export const CalendarCheck = wrap(LCalendarCheck, "CalendarCheck");
export const CalendarX = wrap(LCalendarX, "CalendarX");
export const DotsThree = HANDOFF_OPCOES;
export const DotsThreeVertical = HANDOFF_OPCOES_VERTICAL;
export const UsersThree = HANDOFF_CONTATOS;
export const UserCircle = HANDOFF_PERFIL;
export const SignOut = HANDOFF_SAIR;
export const MagnifyingGlass = HANDOFF_BUSCAR;
export const Sun = wrap(LSun, "Sun");
export const Moon = wrap(LMoon, "Moon");
export const Bell = HANDOFF_SINO;
export const BellSimple = HANDOFF_SINO;
export const BellRinging = wrap(BellRing, "BellRinging");
export const BellSlash = wrap(BellOff, "BellSlash");
export const Sparkle = HANDOFF_NOVIDADES;
export const Funnel = HANDOFF_FILTROS;
export const ChartLineUp = HANDOFF_ETAPA;
export const ChartBar = wrap(ChartColumn, "ChartBar");
export const PencilSimple = HANDOFF_EDITAR;
export const NotePencil = wrap(NotebookPen, "NotePencil");
export const Notepad = wrap(NotepadText, "Notepad");
export const Paperclip = HANDOFF_ANEXAR;
export const Microphone = HANDOFF_MIC;
export const PaperPlaneRight = wrap(Send, "PaperPlaneRight");
export const PaperPlaneTilt = wrap(Send, "PaperPlaneTilt");
export const ArrowsLeftRight = HANDOFF_TRANSFERIR;
export const Play = HANDOFF_PLAY;
export const ArrowsDownUp = HANDOFF_ORGANIZAR;
export const ArrowRight = HANDOFF_AVANCAR;
export const ArrowSquareOut = HANDOFF_DETALHES;
export const SlidersHorizontal = HANDOFF_PERSONALIZAR;
export const SealCheck = HANDOFF_VENDAS;
export const CurrencyCircleDollar = HANDOFF_VALOR;
export const WhatsappLogo = HANDOFF_WHATSAPP;
export const InstagramLogo = HANDOFF_INSTAGRAM;
export const FacebookLogo = BRAND_FACEBOOK;
export const GoogleLogo = BRAND_GOOGLE;
export const Vault = wrap(LVault, "Vault");

// Ações e utilitários (Lucide — mesma família do handoff)
export const AirplaneTilt = wrap(Plane, "AirplaneTilt");
export const Archive = wrap(LArchive, "Archive");
export const ArrowBendUpLeft = wrap(Reply, "ArrowBendUpLeft");
export const ArrowClockwise = wrap(RotateCw, "ArrowClockwise");
export const ArrowCounterClockwise = wrap(RotateCcw, "ArrowCounterClockwise");
export const ArrowDown = wrap(LArrowDown, "ArrowDown");
export const ArrowLeft = wrap(LArrowLeft, "ArrowLeft");
export const ArrowLineDown = wrap(ArrowDownToLine, "ArrowLineDown");
export const ArrowUp = wrap(LArrowUp, "ArrowUp");
export const ArrowUUpLeft = wrap(Undo2, "ArrowUUpLeft");
export const ArrowUpRight = wrap(LArrowUpRight, "ArrowUpRight");
export const ArrowsClockwise = wrap(RefreshCw, "ArrowsClockwise");
export const BookmarkSimple = wrap(Bookmark, "BookmarkSimple");
export const Buildings = wrap(Building2, "Buildings");
export const CaretDown = wrap(ChevronDown, "CaretDown");
export const CaretUp = wrap(ChevronUp, "CaretUp");
export const CaretRight = wrap(ChevronRight, "CaretRight");
export const CaretLineLeft = wrap(ChevronsLeft, "CaretLineLeft");
export const CaretLineRight = wrap(ChevronsRight, "CaretLineRight");
export const Check = wrap(LCheck, "Check");
export const Checks = wrap(CheckCheck, "Checks");
export const CheckCircle = wrap(CircleCheck, "CheckCircle");
export const ClipboardText = HANDOFF_CLIPBOARD;
export const Clock = wrap(LClock, "Clock");
export const ClockCountdown = wrap(Timer, "ClockCountdown");
export const ClockCounterClockwise = wrap(History, "ClockCounterClockwise");
export const Compass = wrap(LCompass, "Compass");
export const Copy = wrap(LCopy, "Copy");
export const CopySimple = wrap(LCopy, "CopySimple");
export const Cpu = wrap(LCpu, "Cpu");
export const CreditCard = wrap(LCreditCard, "CreditCard");
export const CursorClick = wrap(MousePointerClick, "CursorClick");
export const DeviceMobile = wrap(Smartphone, "DeviceMobile");
export const DoorOpen = wrap(LDoorOpen, "DoorOpen");
export const DownloadSimple = wrap(Download, "DownloadSimple");
export const Eye = wrap(LEye, "Eye");
export const EyeSlash = wrap(EyeOff, "EyeSlash");
export const File = wrap(LFile, "File");
export const FileArrowDown = wrap(FileDown, "FileArrowDown");
export const FileArrowUp = wrap(FileUp, "FileArrowUp");
export const FileImage = wrap(LFileImage, "FileImage");
export const FilePdf = wrap(LFileText, "FilePdf");
export const FileText = wrap(LFileText, "FileText");
export const FileVideo = wrap(LFileVideo, "FileVideo");
export const Flag = wrap(LFlag, "Flag");
export const Flask = wrap(FlaskConical, "Flask");
export const FloppyDisk = wrap(Save, "FloppyDisk");
export const GearSix = wrap(Settings, "GearSix");
export const GitBranch = wrap(LGitBranch, "GitBranch");
export const GitFork = wrap(LGitFork, "GitFork");
export const GlobeHemisphereWest = wrap(Globe, "GlobeHemisphereWest");
export const HandHeart = wrap(LHandHeart, "HandHeart");
export const HandPointing = wrap(Pointer, "HandPointing");
export const Handshake = wrap(LHandshake, "Handshake");
export const HardDrives = wrap(HardDrive, "HardDrives");
export const Hourglass = wrap(LHourglass, "Hourglass");
export const Image = wrap(LImage, "Image");
export const ImageSquare = wrap(LImage, "ImageSquare");
export const Info = wrap(LInfo, "Info");
export const Key = wrap(LKey, "Key");
export const Keyboard = wrap(LKeyboard, "Keyboard");
export const Link = wrap(LLink, "Link");
export const LinkBreak = wrap(Unlink, "LinkBreak");
export const LinkSimple = wrap(LLink, "LinkSimple");
export const List = wrap(LList, "List");
export const ListBullets = wrap(LList, "ListBullets");
export const ListChecks = wrap(LListChecks, "ListChecks");
export const Lock = wrap(LLock, "Lock");
export const LockSimple = wrap(LLock, "LockSimple");
export const MagicWand = wrap(WandSparkles, "MagicWand");
export const MapPin = wrap(LMapPin, "MapPin");
export const Megaphone = wrap(LMegaphone, "Megaphone");
export const Minus = wrap(LMinus, "Minus");
export const Pause = HANDOFF_PAUSE;
export const PhoneCall = wrap(LPhoneCall, "PhoneCall");
export const Plug = wrap(LPlug, "Plug");
export const Plugs = wrap(PlugZap, "Plugs");
export const Plus = wrap(LPlus, "Plus");
export const Power = wrap(LPower, "Power");
export const Prohibit = wrap(Ban, "Prohibit");
export const Queue = wrap(Rows3, "Queue");
export const ShieldCheck = wrap(LShieldCheck, "ShieldCheck");
export const ShieldSlash = wrap(ShieldOff, "ShieldSlash");
export const SidebarSimple = wrap(PanelLeft, "SidebarSimple");
export const SpeakerHigh = wrap(Volume2, "SpeakerHigh");
export const SpinnerGap = wrap(LoaderCircle, "SpinnerGap");
export const Star = wrap(LStar, "Star");
export const Sticker = wrap(LSticker, "Sticker");
export const Stop = wrap(Square, "Stop");
export const Tag = wrap(LTag, "Tag");
export const TagSimple = wrap(LTag, "TagSimple");
export const Target = wrap(LTarget, "Target");
export const Trash = wrap(Trash2, "Trash");
export const UploadSimple = wrap(Upload, "UploadSimple");
export const User = wrap(LUser, "User");
export const UserFocus = wrap(ScanFace, "UserFocus");
export const UserList = wrap(Contact, "UserList");
export const UserMinus = wrap(LUserMinus, "UserMinus");
export const UserPlus = wrap(LUserPlus, "UserPlus");
export const UserSwitch = wrap(UserCog, "UserSwitch");
export const VideoCamera = wrap(Video, "VideoCamera");
export const Warning = wrap(TriangleAlert, "Warning");
export const WarningCircle = wrap(CircleAlert, "WarningCircle");
export const Watch = wrap(LWatch, "Watch");
export const WebhooksLogo = wrap(Webhook, "WebhooksLogo");
export const X = HANDOFF_FECHAR;

/** Glifos dos blocos do fluxo por chave do handoff (Fluxo.dc.html `const K`). */
export const FlowIcons = {
  gatilho: FLOW_GATILHO,
  mensagem: HANDOFF_CONVERSAS,
  opcoes: FLOW_OPCOES,
  simnao: FLOW_SIMNAO,
  texto: FLOW_TEXTO,
  finalizar: FLOW_FINALIZAR,
  espera: FLOW_ESPERA,
  aguardar: FLOW_AGUARDAR,
  addtag: FLOW_ADDTAG,
  rmtag: FLOW_RMTAG,
  etapa: HANDOFF_PIPELINE,
  agente: FLOW_AGENTE,
  webhook: FLOW_WEBHOOK
} as const;

// Glifos do rail por nome do handoff (usados pelo NavRail).
export const RailIcons = {
  painel: HANDOFF_PAINEL,
  conversas: HANDOFF_CONVERSAS,
  contatos: HANDOFF_CONTATOS,
  pipeline: HANDOFF_PIPELINE,
  tarefas: HANDOFF_TAREFAS,
  agentes: HANDOFF_AGENTES,
  agenda: HANDOFF_AGENDA,
  mais: HANDOFF_MAIS,
  maisVertical: HANDOFF_MAIS_VERTICAL,
  atendon: HANDOFF_ATENDON,
  buscar: MagnifyingGlass,
  tema: Sun,
  perfil: HANDOFF_PERFIL,
  sair: HANDOFF_SAIR,
  ajustar: HANDOFF_AJUSTAR,
  aproximar: HANDOFF_MAIS_ZOOM,
  afastar: HANDOFF_MENOS_ZOOM,
  bot: wrap(Bot, "Bot")
} as const;
