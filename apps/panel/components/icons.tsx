"use client";

/**
 * Biblioteca de ícones do AtendON — Design System v2.
 *
 * Fonte ÚNICA de ícones do painel: 100% Lucide (lucide-react), SVG de traço,
 * viewBox 24, fill none, linecap/linejoin round e UM traço para a família
 * inteira (1.75; 2 para `weight="bold"`). Nada desenhado à mão nem
 * preenchido — só os logos de marca que o Lucide não distribui (Instagram,
 * Facebook, Google) usam o mesmo vocabulário via createLucideIcon.
 *
 * Os nomes exportados mantêm a API antiga (Gauge, ChatsCircle, Kanban…) para
 * que as telas não mudem; `weight` é aceito por compatibilidade.
 */

import {
  ArrowLeftRight,
  ArrowRight as LArrowRight,
  Bell as LBell,
  CalendarClock as LCalendarClock,
  CalendarDays,
  ChartLine,
  CircleDollarSign,
  CircleDot,
  CircleHelp,
  CircleUser,
  ClipboardList,
  Ellipsis,
  Hand,
  Inbox as LInbox,
  EllipsisVertical,
  SquareKanban,
  LayoutGrid,
  ListFilter,
  LogOut,
  Maximize,
  MessageCircle,
  MessageSquare,
  Mic,
  Network,
  Paperclip as LPaperclip,
  Pause as LPause,
  Pencil,
  Play as LPlay,
  Search,
  Settings2,
  Sparkles,
  Split,
  SquareCheckBig,
  TagX,
  TextCursorInput,
  UserCheck,
  Users,
  X as LX,
  Archive as LArchive,
  ArrowDown as LArrowDown,
  ArrowDownToLine,
  GripVertical as LGripVertical,
  Palette as LPalette,
  Zap,
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
  /** Compat com a API antiga: bold engrossa o traço; os demais usam o traço único. */
  weight?: IconWeight;
  mirrored?: boolean;
};

export type Icon = ForwardRefExoticComponent<IconProps & RefAttributes<SVGSVGElement>>;

/** Traço único da família: 1.75 em qualquer tamanho; bold = 2. */
export function iconStroke(weight?: IconWeight): number {
  return weight === "bold" ? 2 : 1.75;
}

function wrap(Base: LucideIcon, name: string): Icon {
  const Wrapped = forwardRef<SVGSVGElement, IconProps>(function AtendonIcon(
    { weight, mirrored, size = 16, strokeWidth, style, ...props },
    ref
  ) {
    return (
      <Base
        ref={ref}
        size={size}
        strokeWidth={strokeWidth ?? iconStroke(weight)}
        style={mirrored ? { transform: "scaleX(-1)", ...style } : style}
        {...props}
      />
    );
  });
  Wrapped.displayName = name;
  return Wrapped as Icon;
}

type IconNode = Parameters<typeof createLucideIcon>[1];

/** Marca sem glifo no Lucide (o Lucide não distribui logos) — mesmo traço da família. */
function brand(name: string, node: IconNode): Icon {
  return wrap(createLucideIcon(name, node), name);
}

/* ------------------------------------------ glifos Lucide nomeados ------ */
// Todos os glifos de navegação, fluxo e ações vêm do Lucide oficial: nada
// desenhado à mão, nada preenchido, um único traço para a família inteira.
const HANDOFF_PAINEL = wrap(LayoutGrid, "Painel");
const HANDOFF_CONVERSAS = wrap(MessageSquare, "Conversas");
const HANDOFF_PIPELINE = wrap(SquareKanban, "Pipeline");
const HANDOFF_TAREFAS = wrap(SquareCheckBig, "Tarefas");
const HANDOFF_AGENTES = wrap(Bot, "AgentesIA");
const HANDOFF_AGENDA = wrap(CalendarDays, "Agenda");
const HANDOFF_MAIS = wrap(Ellipsis, "Mais");
const HANDOFF_MAIS_VERTICAL = wrap(EllipsisVertical, "MaisVertical");
const HANDOFF_CONTATOS = wrap(Users, "Contatos");
const HANDOFF_BUSCAR = wrap(Search, "Buscar");
const HANDOFF_OPCOES = wrap(Ellipsis, "Opcoes");
const HANDOFF_OPCOES_VERTICAL = wrap(EllipsisVertical, "OpcoesVertical");
const HANDOFF_TRANSFERIR = wrap(ArrowLeftRight, "Transferir");
const HANDOFF_CLIPBOARD = wrap(ClipboardList, "Briefing");
const HANDOFF_MIC = wrap(Mic, "GravarAudio");
const HANDOFF_PAUSE = wrap(LPause, "Pausar");
/* Blocos do fluxo */
const FLOW_GATILHO = wrap(LPlug, "BlocoGatilho");
const FLOW_OPCOES = wrap(LList, "BlocoOpcoes");
const FLOW_SIMNAO = wrap(Split, "BlocoSimNao");
const FLOW_TEXTO = wrap(TextCursorInput, "BlocoTexto");
const FLOW_FINALIZAR = wrap(LPower, "BlocoFinalizar");
const FLOW_ESPERA = wrap(LClock, "BlocoEspera");
const FLOW_AGUARDAR = wrap(LHourglass, "BlocoAguardar");
const FLOW_ADDTAG = wrap(LTag, "BlocoAddTag");
const FLOW_RMTAG = wrap(TagX, "BlocoRmTag");
const FLOW_AGENTE = wrap(UserCheck, "BlocoAgente");
const FLOW_WEBHOOK = wrap(Webhook, "BlocoWebhook");
// Canvas
const HANDOFF_MAIS_ZOOM = wrap(LPlus, "Aproximar");
const HANDOFF_MENOS_ZOOM = wrap(LMinus, "Afastar");
const HANDOFF_FECHAR = wrap(LX, "Fechar");
// Rail rodapé
const HANDOFF_ATENDON = wrap(CircleDot, "AtendON");
const HANDOFF_PERFIL = wrap(CircleUser, "Perfil");
const HANDOFF_SAIR = wrap(LogOut, "Sair");
// Topbar / listas / thread
const HANDOFF_SINO = wrap(LBell, "Notificacoes");
const HANDOFF_NOVIDADES = wrap(Sparkles, "Novidades");
const HANDOFF_FILTROS = wrap(ListFilter, "Filtros");
const HANDOFF_ETAPA = wrap(ChartLine, "EtapaComercial");
const HANDOFF_EDITAR = wrap(Pencil, "Editar");
const HANDOFF_ANEXAR = wrap(LPaperclip, "Anexar");
const HANDOFF_PLAY = wrap(LPlay, "Simular");
const HANDOFF_ORGANIZAR = wrap(Network, "Organizar");
const HANDOFF_AJUSTAR = wrap(Maximize, "AjustarATela");
const HANDOFF_AVANCAR = wrap(LArrowRight, "AvancarEtapa");
const HANDOFF_DETALHES = wrap(LArrowUpRight, "Detalhes");
const HANDOFF_PERSONALIZAR = wrap(Settings2, "Personalizar");
const HANDOFF_VENDAS = wrap(CircleCheck, "Vendas");
const HANDOFF_VALOR = wrap(CircleDollarSign, "ValorVendido");
// Canais: WhatsApp usa o balão do Lucide (o logo oficial fica no ChannelBadge).
const HANDOFF_WHATSAPP = wrap(MessageCircle, "WhatsApp");
const HANDOFF_INSTAGRAM = brand("Instagram", [
  ["rect", { x: "2", y: "2", width: "20", height: "20", rx: "5", key: "a" }],
  ["path", { d: "M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z", key: "b" }],
  ["path", { d: "M17.5 6.5h.01", key: "c" }]
]);
const BRAND_FACEBOOK = brand("Facebook", [
  ["path", { d: "M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z", key: "a" }]
]);
const BRAND_GOOGLE = brand("Google", [
  ["path", { d: "M21.5 12.2c0-.7-.1-1.4-.2-2.1H12v4h5.4a4.6 4.6 0 0 1-2 3", key: "a" }],
  ["path", { d: "M15.4 17.1A6 6 0 0 1 6.3 14", key: "b" }],
  ["path", { d: "M6.3 10a6 6 0 0 1 9.4-3", key: "c" }],
  ["path", { d: "M20.6 17A10 10 0 1 1 18.8 5.1", key: "d" }]
]);

/* ------------------------------------------------ API pública ------------ */
// Navegação principal
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
export const CalendarClock = wrap(LCalendarClock, "CalendarClock");
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

// Ações e utilitários
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
export const HandGrab = wrap(Hand, "HandGrab");
export const HandHeart = wrap(LHandHeart, "HandHeart");
export const HandPointing = wrap(Pointer, "HandPointing");
export const Handshake = wrap(LHandshake, "Handshake");
export const HardDrives = wrap(HardDrive, "HardDrives");
export const Hourglass = wrap(LHourglass, "Hourglass");
export const Image = wrap(LImage, "Image");
export const ImageSquare = wrap(LImage, "ImageSquare");
export const Inbox = wrap(LInbox, "Inbox");
export const Info = wrap(LInfo, "Info");
export const Question = wrap(CircleHelp, "Question");
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
export const GripVertical = wrap(LGripVertical, "GripVertical");
export const Palette = wrap(LPalette, "Palette");
export const Lightning = wrap(Zap, "Lightning");
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

/** Glifos dos blocos do fluxo por chave do editor. */
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

// Glifos do rail (usados pelo NavRail).
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
