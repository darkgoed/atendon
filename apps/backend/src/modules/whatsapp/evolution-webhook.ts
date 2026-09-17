import type { SessionMessage, MediaType, MessageDeliveryStatus, MessageReferral } from "../messages/types.js";

type Json = Record<string, unknown>;

function object(value: unknown): Json { return value && typeof value === "object" ? value as Json : {}; }
function phone(jid: string): string { return jid.split("@")[0].split(":")[0]; }

function clean(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const result = value.trim().slice(0, max);
  return result || undefined;
}

function webUrl(value: unknown, max = 1_000): string | undefined {
  const result = clean(value, max);
  if (!result) return undefined;
  try {
    const url = new URL(result);
    return url.protocol === "https:" || url.protocol === "http:" ? result : undefined;
  } catch {
    return undefined;
  }
}

function extractPrefilledFields(...containers: unknown[]): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  const add = (rawLabel: unknown, rawValue: unknown) => {
    if (Object.keys(fields).length >= 40) return;
    const label = clean(rawLabel, 180);
    const value = ["string", "number", "boolean"].includes(typeof rawValue) ? clean(String(rawValue), 600) : undefined;
    if (label && value) fields[label] = value;
  };
  const visit = (container: unknown, depth = 0) => {
    if (depth > 3 || Object.keys(fields).length >= 40) return;
    if (Array.isArray(container)) {
      for (const item of container) {
        const row = object(item);
        const values = Array.isArray(row.values) ? row.values.join(", ") : row.values;
        const label = row.label ?? row.question ?? row.name ?? row.key;
        const value = row.value ?? row.answer ?? values;
        if (label !== undefined && value !== undefined) add(label, value);
        else visit(item, depth + 1);
      }
      return;
    }
    const row = object(container);
    for (const [label, value] of Object.entries(row)) {
      if (["string", "number", "boolean"].includes(typeof value)) add(label, value);
      else visit(value, depth + 1);
    }
  };
  for (const container of containers) {
    visit(container);
  }
  return Object.keys(fields).length ? fields : undefined;
}

/** Mantém somente atribuição CTWA útil; nunca persiste o payload bruto da Meta. */
export function evolutionReferral(content: Json, providerContext?: unknown): MessageReferral | undefined {
  const extended = object(content.extendedTextMessage);
  const nestedContext = object(extended.contextInfo);
  const rootContext = object(providerContext);
  const contexts = [nestedContext, rootContext];
  const referral = contexts.map((context) => object(context.referralMessage))
    .find((candidate) => Object.keys(candidate).length) ?? {};
  const external = contexts.map((context) => object(context.externalAdReply))
    .find((candidate) => Object.keys(candidate).length) ?? {};
  const source = Object.keys(referral).length ? referral : external;
  const prefilledFields = extractPrefilledFields(
    source.prefilledFields, source.prefilled_fields,
    source.formData, source.form_data,
    source.leadData, source.lead_data,
    ...contexts.flatMap((context) => [
      context.prefilledFields, context.prefilled_fields,
      context.formData, context.form_data,
      context.leadData, context.lead_data
    ])
  );
  if (!Object.keys(source).length && !prefilledFields) return undefined;
  const sourceType = String(source.sourceType ?? source.source_type ?? "").toLowerCase();
  const mediaType = source.mediaType ?? source.media_type;
  const sourceApp = clean(
    source.sourceApp ?? source.source_app
      ?? nestedContext.entryPointConversionApp ?? rootContext.entryPointConversionApp,
    100
  );
  return {
    sourceType: sourceType.includes("ad") || Object.keys(external).length ? "ad" : sourceType.includes("post") ? "post" : "unknown",
    ...(clean(source.sourceId ?? source.source_id, 200) ? { sourceId: clean(source.sourceId ?? source.source_id, 200) } : {}),
    ...(webUrl(source.sourceUrl ?? source.source_url) ? { sourceUrl: webUrl(source.sourceUrl ?? source.source_url) } : {}),
    ...(clean(source.headline ?? source.title) ? { headline: clean(source.headline ?? source.title) } : {}),
    ...(clean(source.body) ? { body: clean(source.body) } : {}),
    ...(mediaType !== undefined && clean(String(mediaType), 100) ? { mediaType: clean(String(mediaType), 100) } : {}),
    ...(webUrl(source.mediaUrl ?? source.media_url) ? { mediaUrl: webUrl(source.mediaUrl ?? source.media_url) } : {}),
    ...(webUrl(source.thumbnailUrl ?? source.thumbnail_url) ? { thumbnailUrl: webUrl(source.thumbnailUrl ?? source.thumbnail_url) } : {}),
    ...(clean(source.ctwaClid ?? source.ctwa_clid, 300) ? { ctwaClid: clean(source.ctwaClid ?? source.ctwa_clid, 300) } : {}),
    ...(sourceApp ? { sourceApp: sourceApp.toLowerCase() } : {}),
    ...(prefilledFields ? { prefilledFields } : {})
  };
}

// Baileys reports message acks as the WAMessageStatus enum (numeric or its string
// name, depending on how Evolution API serializes the "messages.update" event).
// ERROR means WhatsApp rejected the send. PENDING/SERVER_ACK precede a real
// delivery and therefore remain represented as "sent".
const ACK_STATUS: Record<string, MessageDeliveryStatus> = {
  "0": "failed", ERROR: "failed",
  "1": "sent", PENDING: "sent",
  "2": "sent", SERVER_ACK: "sent",
  "3": "delivered", DELIVERY_ACK: "delivered",
  "4": "read", READ: "read",
  "5": "read", PLAYED: "read"
};

export interface EvolutionMessageStatusUpdate {
  externalId: string;
  status: MessageDeliveryStatus;
  /** WhatsApp rejeitou o envio (WAMessageStatus ERROR); a mensagem não chegou ao destinatário. */
  failed?: boolean;
  fromMe?: boolean;
}

export function evolutionMessageStatusUpdates(data: unknown): EvolutionMessageStatusUpdate[] {
  const entries = Array.isArray(data) ? data : [data];
  const updates: EvolutionMessageStatusUpdate[] = [];
  for (const entry of entries) {
    const row = object(entry);
    const key = object(row.key);
    const update = object(row.update);
    const externalId = String(key.id ?? row.keyId ?? row.id ?? "");
    const rawStatus = update.status ?? row.status;
    if (!externalId || rawStatus === undefined || rawStatus === null) continue;
    const normalized = String(rawStatus).toUpperCase();
    const status = ACK_STATUS[normalized];
    if (!status) {
      console.warn(`[evolution-webhook] Unrecognized message status: "${rawStatus}" for message ${externalId}`, { rawStatus, ACK_STATUS: Object.keys(ACK_STATUS) });
    }
    if (status) updates.push({
      externalId,
      status,
      ...(status === "failed" ? { failed: true } : {}),
      ...(key.fromMe !== undefined || row.fromMe !== undefined ? { fromMe: Boolean(key.fromMe ?? row.fromMe) } : {})
    });
  }
  return updates;
}

export interface EvolutionEvent {
  event: string;
  instanceName: string;
  data: Json;
}

export interface EvolutionContactUpdate {
  contactPhone: string;
  contactJid: string;
  avatarUrl: string | null;
}

export function evolutionContactUpdates(data: unknown): EvolutionContactUpdate[] {
  const rows = Array.isArray(data) ? data : [data];
  const updates: EvolutionContactUpdate[] = [];
  for (const rawRow of rows) {
    const row = object(rawRow);
    const contactJid = clean(row.remoteJid ?? row.id ?? row.wuid, 200);
    if (!contactJid || contactJid === "status@broadcast" || contactJid.endsWith("@g.us")) continue;
    const rawAvatar = row.profilePicUrl ?? row.profilePictureUrl ?? row.picture;
    updates.push({
      contactPhone: phone(contactJid),
      contactJid,
      avatarUrl: webUrl(rawAvatar) ?? null
    });
  }
  return updates;
}

export interface EvolutionStickerMessage {
  externalId: string;
  contactPhone: string;
  contactJid: string;
  fromMe: boolean;
}

export function evolutionStickerMessage(data: Json): EvolutionStickerMessage | null {
  const key = object(data.key);
  const remoteJid = String(key.remoteJid ?? data.remoteJid ?? "");
  const externalId = String(key.id ?? data.id ?? "");
  const content = object(data.message);
  if (!remoteJid || !externalId || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us") || !content.stickerMessage) return null;
  return {
    externalId,
    contactPhone: phone(remoteJid),
    contactJid: remoteJid,
    fromMe: Boolean(key.fromMe ?? data.fromMe)
  };
}

export type ContactPresence = "available" | "unavailable" | "composing" | "recording" | "paused";

export interface EvolutionPresenceUpdate {
  contactPhone: string;
  contactJid: string;
  presence: ContactPresence;
  lastSeenAt?: Date;
}

const CONTACT_PRESENCES = new Set<ContactPresence>(["available", "unavailable", "composing", "recording", "paused"]);

export function evolutionPresenceUpdates(data: unknown): EvolutionPresenceUpdate[] {
  const root = object(data);
  const rootJid = clean(root.id ?? root.remoteJid, 200);
  const presences = object(root.presences);
  const entries = Object.keys(presences).length
    ? Object.entries(presences)
    : rootJid ? [[rootJid, root]] as Array<[string, unknown]> : [];
  const updates: EvolutionPresenceUpdate[] = [];
  for (const [rawJid, rawPresence] of entries) {
    const contactJid = String(rawJid || rootJid || "");
    if (!contactJid || contactJid.endsWith("@g.us") || contactJid === "status@broadcast") continue;
    const presenceData = object(rawPresence);
    const rawStatus = String(presenceData.lastKnownPresence ?? presenceData.presence ?? "").toLowerCase();
    if (!CONTACT_PRESENCES.has(rawStatus as ContactPresence)) continue;
    const rawLastSeen = presenceData.lastSeen ?? presenceData.last_seen;
    const lastSeenSeconds = typeof rawLastSeen === "number" ? rawLastSeen : Number(rawLastSeen);
    updates.push({
      contactPhone: phone(contactJid),
      contactJid,
      presence: rawStatus as ContactPresence,
      ...(Number.isFinite(lastSeenSeconds) && lastSeenSeconds > 0 ? { lastSeenAt: new Date(lastSeenSeconds * 1_000) } : {})
    });
  }
  return updates;
}

export function parseEvolutionEvent(payload: unknown): EvolutionEvent | null {
  const root = object(payload);
  const event = String(root.event ?? "").replace(/[.-]/g, "_").toUpperCase();
  const instance = root.instance;
  const instanceName = typeof instance === "string" ? instance : String(object(instance).instanceName ?? "");
  if (!event || !instanceName) return null;
  return { event, instanceName, data: object(root.data) };
}

// Extrai só nome (FN:) e telefone(s) (TEL...:) de um vCard bruto — nunca o
// vCard inteiro, que pode carregar outros dados pessoais de terceiros além
// de nome/telefone.
function vcardContactLine(vcard: string): string {
  const lines = vcard.split(/\r\n|\r|\n/);
  let name = "";
  const phones: string[] = [];
  for (const line of lines) {
    if (/^FN:/i.test(line)) name = clean(line.slice(3), 180) ?? "";
    else if (/^TEL/i.test(line)) {
      const separator = line.indexOf(":");
      const value = separator === -1 ? "" : clean(line.slice(separator + 1), 60);
      if (value) phones.push(value);
    }
  }
  const phoneLabel = phones[0];
  if (name && phoneLabel) return `${name} — ${phoneLabel}`;
  return name || phoneLabel || "";
}

// WhatsApp entrega contato compartilhado (recurso "Compartilhar contato")
// como content.contactMessage (um contato) ou content.contactsArrayMessage
// (vários) — sem isto a mensagem inteira era descartada em silêncio porque
// nem `text` nem `mediaType` eram preenchidos (ver `else if (!text) return
// null` abaixo), e o encaminhamento de contato desaparecia sem deixar
// rastro no AtendON.
function contactShareText(content: Json): string | undefined {
  if (content.contactMessage !== undefined && content.contactMessage !== null) {
    const single = object(content.contactMessage);
    const vcard = typeof single.vcard === "string" ? vcardContactLine(single.vcard) : "";
    const label = vcard || clean(single.displayName, 180) || "Contato compartilhado";
    return `📇 Contato compartilhado: ${label}`;
  }
  const group = object(content.contactsArrayMessage);
  const contacts = Array.isArray(group.contacts) ? group.contacts : [];
  if (contacts.length) {
    const lines = contacts.slice(0, 5).map((rawContact) => {
      const contact = object(rawContact);
      const vcard = typeof contact.vcard === "string" ? vcardContactLine(contact.vcard) : "";
      return vcard || clean(contact.displayName, 180) || "Contato";
    });
    const extra = contacts.length > 5 ? ` (+${contacts.length - 5} contatos)` : "";
    return `📇 Contatos compartilhados:\n${lines.join("\n")}${extra}`;
  }
  return undefined;
}

// Melhor esforço para dar VISIBILIDADE operacional (logs) sobre um tipo de
// mensagem WhatsApp que evolutionMessage() não soube extrair — em vez de a
// mensagem simplesmente desaparecer sem rastro (era exatamente o sintoma do
// bug de vCard/vídeo corrigido nesta mesma rodada). Devolve só os NOMES das
// chaves de `message`, nunca conteúdo. Vazio/groups/broadcast/mensagens sem
// `message` (acks, etc.) não contam como "não reconhecido".
export function evolutionUnrecognizedMessageContentKeys(data: Json): string[] {
  const key = object(data.key);
  const remoteJid = String(key.remoteJid ?? data.remoteJid ?? "");
  if (!remoteJid || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) return [];
  const content = object(data.message);
  const keys = Object.keys(content);
  if (!keys.length) return [];
  if (evolutionMessage(data, { tenantId: "probe", sessionId: "probe" }) !== null) return [];
  return keys;
}

export function evolutionMessage(data: Json, identity: { tenantId: string; sessionId: string }): SessionMessage | null {
  const key = object(data.key);
  const remoteJid = String(key.remoteJid ?? data.remoteJid ?? "");
  const externalId = String(key.id ?? data.id ?? "");
  if (!remoteJid || !externalId || remoteJid === "status@broadcast" || remoteJid.endsWith("@g.us")) return null;
  const content = object(data.message);
  const extended = object(content.extendedTextMessage);
  const image = object(content.imageMessage);
  const document = object(content.documentMessage);
  const sticker = object(content.stickerMessage);
  const video = object(content.videoMessage);
  const text = String(content.conversation ?? extended.text ?? image.caption ?? document.caption ?? video.caption ?? "") || contactShareText(content) || "";
  let mediaType: MediaType | undefined;
  if (content.audioMessage) mediaType = "audio";
  else if (content.imageMessage) mediaType = "image";
  else if (content.documentMessage) mediaType = "document";
  else if (content.stickerMessage) mediaType = "image";
  else if (content.videoMessage) mediaType = "video";
  else if (!text) return null;
  const fromMe = Boolean(key.fromMe ?? data.fromMe);
  const mediaContent = mediaType === "audio" ? object(content.audioMessage)
    : mediaType === "image" ? (content.stickerMessage ? sticker : image)
      : mediaType === "document" ? document
        : mediaType === "video" ? video : {};
  const mediaMimeType = clean(mediaContent.mimetype, 200);
  const mediaFileName = clean(mediaContent.fileName ?? mediaContent.title, 180);
  const rawSize = mediaContent.fileLength ?? mediaContent.fileSize;
  const mediaSizeBytes = typeof rawSize === "number" ? rawSize : Number(rawSize);
  const referral = !fromMe ? evolutionReferral(content, data.contextInfo) : undefined;
  return {
    kind: fromMe ? "human" : "contact", externalId, ...identity,
    contactPhone: phone(remoteJid), contactJid: remoteJid,
    ...(!fromMe && data.pushName ? { contactName: String(data.pushName) } : {}),
    text, ...(mediaType ? { mediaType } : {}),
    ...(mediaMimeType ? { mediaMimeType } : {}),
    ...(mediaFileName ? { mediaFileName } : {}),
    ...(Number.isSafeInteger(mediaSizeBytes) && mediaSizeBytes >= 0 ? { mediaSizeBytes } : {}),
    ...(content.stickerMessage ? { mediaIsSticker: true } : {}),
    ...(referral ? { referral } : {})
  };
}
