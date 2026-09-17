import type { AppConfig } from "../../config.js";
import type { ReadReceipt } from "../messages/types.js";

type Json = Record<string, unknown>;
export const EVOLUTION_MAX_RESPONSE_BYTES = 48 * 1024 * 1024;
const EVOLUTION_ERROR_DETAIL_MAX_LENGTH = 500;

function normalizeEvolutionErrorDetail(value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("; ")
    .slice(0, EVOLUTION_ERROR_DETAIL_MAX_LENGTH);
}

function evolutionErrorDetail(body: string): string {
  if (!body.trim()) return "";
  try {
    const candidate: unknown = JSON.parse(body);
    if (!candidate || typeof candidate !== "object") return "";
    const parsed = candidate as Record<string, unknown>;
    const response = parsed.response && typeof parsed.response === "object"
      ? parsed.response as Record<string, unknown>
      : undefined;
    return normalizeEvolutionErrorDetail(response?.message ?? parsed.message ?? parsed.error);
  } catch {
    return normalizeEvolutionErrorDetail(body);
  }
}

export class EvolutionApiError extends Error {
  readonly statusCode = 502;
  readonly detail: string;

  constructor(readonly upstreamStatus: number, body: string) {
    const detail = evolutionErrorDetail(body);
    super(`Evolution API recusou a operação (HTTP ${upstreamStatus})${detail ? `: ${detail}` : ""}`);
    this.name = "EvolutionApiError";
    this.detail = detail;
  }
}

export function isEvolutionConnectionClosedError(error: unknown): error is EvolutionApiError {
  return error instanceof EvolutionApiError
    && /(?:^|\b)connection closed(?:\b|$)/i.test(error.detail);
}

async function limitedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > EVOLUTION_MAX_RESPONSE_BYTES) {
    throw new Error("Evolution API response exceeded the configured size limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > EVOLUTION_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Evolution API response exceeded the configured size limit");
    }
    chunks.push(chunk.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

export interface OutboundMediaPayload {
  mediaType: "audio" | "image" | "document";
  mimeType: string;
  fileName: string;
  dataBase64: string;
  caption?: string;
}

export type PresenceType = "composing" | "paused" | "available" | "unavailable";

interface EvolutionInstance {
  name?: string;
  instanceName?: string;
  instance?: { instanceName?: string; connectionStatus?: string; state?: string; status?: string };
  connectionStatus?: string;
  state?: string;
  status?: string;
}

export interface EvolutionContact {
  remoteJid: string;
  profilePicUrl: string | null;
}

export class EvolutionClient {
  private readonly instanceCache = new Map<string, { exists: boolean; expiresAt: number }>();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly config: Pick<AppConfig, "EVOLUTION_API_URL" | "EVOLUTION_API_KEY" | "EVOLUTION_WEBHOOK_URL" | "EVOLUTION_WEBHOOK_SECRET" | "EVOLUTION_TIMEOUT_MS">) {}

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.config.EVOLUTION_API_URL}${path}`, {
      ...init,
      headers: { apikey: this.config.EVOLUTION_API_KEY, "content-type": "application/json", ...init.headers },
      signal: AbortSignal.timeout(this.config.EVOLUTION_TIMEOUT_MS)
    });
    const body = await limitedResponseText(response);
    if (!response.ok) throw new EvolutionApiError(response.status, body);
    return (body ? JSON.parse(body) : {}) as T;
  }

  private getCachedInstance(instanceName: string): boolean | null {
    const cached = this.instanceCache.get(instanceName);
    if (cached && Date.now() < cached.expiresAt) return cached.exists;
    if (cached) this.instanceCache.delete(instanceName);
    return null;
  }

  private setInstanceCache(instanceName: string, exists: boolean): void {
    this.instanceCache.set(instanceName, { exists, expiresAt: Date.now() + this.CACHE_TTL_MS });
  }

  async sendPresence(instanceName: string, number: string, presence: PresenceType, delay = 1_000): Promise<void> {
    await this.request(`/chat/sendPresence/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ number: number.split("@")[0], presence, delay })
    });
  }

  async markMessageAsRead(instanceName: string, receipts: ReadReceipt | ReadReceipt[]): Promise<void> {
    const list = Array.isArray(receipts) ? receipts : [receipts];
    await this.request(`/chat/markMessageAsRead/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ readMessages: list })
    });
  }

  async downloadMedia(instanceName: string, externalId: string): Promise<{
    base64: string;
    mimeType: string;
    fileName?: string;
  }> {
    const result = await this.request<{
      base64?: unknown;
      mimetype?: unknown;
      fileName?: unknown;
    }>(`/chat/getBase64FromMediaMessage/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ message: { key: { id: externalId } }, convertToMp4: false })
    });
    if (typeof result.base64 !== "string" || !result.base64.trim()) {
      throw new Error("Evolution API did not return media base64");
    }
    return {
      base64: result.base64,
      mimeType: typeof result.mimetype === "string" && result.mimetype ? result.mimetype : "application/octet-stream",
      ...(typeof result.fileName === "string" && result.fileName ? { fileName: result.fileName } : {})
    };
  }

  async sendReaction(instanceName: string, number: string, receipt: ReadReceipt, emoji: string): Promise<void> {
    await this.request(`/message/sendReaction/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ key: receipt, reaction: emoji, number: number.split("@")[0] })
    });
  }

  async fetchGroups(instanceName: string): Promise<{ id: string; subject: string }[]> {
    const result = await this.request<Array<{ id?: unknown; subject?: unknown }>>(
      `/group/fetchAllGroups/${encodeURIComponent(instanceName)}?getParticipants=false`
    );
    return (Array.isArray(result) ? result : [])
      .filter((group): group is { id: string; subject?: unknown } => typeof group.id === "string")
      .map((group) => ({ id: group.id, subject: typeof group.subject === "string" && group.subject ? group.subject : group.id }));
  }

  async fetchProfilePicture(instanceName: string, number: string): Promise<string | null> {
    const result = await this.request<{ profilePictureUrl?: unknown }>(
      `/chat/fetchProfilePictureUrl/${encodeURIComponent(instanceName)}`,
      { method: "POST", body: JSON.stringify({ number: number.split("@")[0] }) }
    );
    return this.httpUrl(result.profilePictureUrl);
  }

  async fetchContacts(instanceName: string): Promise<EvolutionContact[]> {
    const result = await this.request<unknown>(
      `/chat/findContacts/${encodeURIComponent(instanceName)}`,
      { method: "POST", body: JSON.stringify({}) }
    );
    return (Array.isArray(result) ? result : []).flatMap((rawContact) => {
      const contact = rawContact && typeof rawContact === "object" ? rawContact as Record<string, unknown> : {};
      if (typeof contact.remoteJid !== "string" || !contact.remoteJid || contact.remoteJid.endsWith("@g.us")) return [];
      return [{
        remoteJid: contact.remoteJid,
        profilePicUrl: this.httpUrl(contact.profilePicUrl ?? contact.profilePictureUrl)
      }];
    });
  }

  private httpUrl(value: unknown): string | null {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? value : null;
    } catch {
      return null;
    }
  }

  async setPresence(instanceName: string, presence: "available" | "unavailable"): Promise<void> {
    await this.request(`/instance/setPresence/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ presence })
    });
  }

  async ensureInstance(instanceName: string): Promise<void> {
    // Check cache first
    const cached = this.getCachedInstance(instanceName);
    if (cached === true) return;

    // Fetch instances with typed response
    const response = await this.request<EvolutionInstance[] | { instances?: EvolutionInstance[] }>("/instance/fetchInstances");
    const instances = Array.isArray(response) ? response : response.instances ?? [];
    const found = instances.some((item: EvolutionInstance) =>
      item.name === instanceName || item.instanceName === instanceName || item.instance?.instanceName === instanceName
    );

    try {
      if (!found) {
        await this.request("/instance/create", {
          method: "POST",
          body: JSON.stringify({ instanceName, integration: "WHATSAPP-BAILEYS", qrcode: true })
        });
      }
      // The instance is only ready after both callbacks and runtime settings are
      // confirmed. Caching earlier would turn a partial setup failure into a
      // false-positive cache hit and prevent the next attempt from repairing it.
      await Promise.all([
        this.request(`/webhook/set/${encodeURIComponent(instanceName)}`, {
          method: "POST",
          body: JSON.stringify({ webhook: {
            enabled: true,
            url: `${this.config.EVOLUTION_WEBHOOK_URL.replace(/\/$/, "")}/webhooks/evolution`,
            headers: { "x-atendon-webhook-secret": this.config.EVOLUTION_WEBHOOK_SECRET },
            webhookByEvents: false,
            base64: false,
            events: [
              "QRCODE_UPDATED", "CONNECTION_UPDATE", "MESSAGES_UPSERT", "MESSAGES_UPDATE",
              "CONTACTS_UPSERT", "CONTACTS_UPDATE", "PRESENCE_UPDATE"
            ]
          } })
        }),
        this.request(`/settings/set/${encodeURIComponent(instanceName)}`, {
          method: "POST",
          body: JSON.stringify({ rejectCall: false, groupsIgnore: true, alwaysOnline: true,
            readMessages: false, readStatus: true, syncFullHistory: false })
        })
      ]);
      this.setInstanceCache(instanceName, true);
    } catch (error) {
      this.instanceCache.delete(instanceName);
      throw error;
    }
    // Don't call setPresence here - it fails during pairing. Let the caller handle it after connect().
  }

  async connect(instanceName: string): Promise<Json> {
    return this.request(`/instance/connect/${encodeURIComponent(instanceName)}`);
  }

  /** Estado real (open/close/connecting) de cada instância, por nome de instância. */
  async fetchInstanceStates(): Promise<Map<string, string>> {
    const response = await this.request<EvolutionInstance[] | { instances?: EvolutionInstance[] }>("/instance/fetchInstances");
    const instances = Array.isArray(response) ? response : response.instances ?? [];
    const states = new Map<string, string>();
    for (const item of instances) {
      const name = item.name ?? item.instanceName ?? item.instance?.instanceName;
      const state = item.connectionStatus ?? item.state ?? item.status
        ?? item.instance?.connectionStatus ?? item.instance?.state ?? item.instance?.status;
      if (name && typeof state === "string") states.set(name, state.toLowerCase());
    }
    return states;
  }

  async restart(instanceName: string): Promise<void> {
    const result = await this.request<Json>(`/instance/restart/${encodeURIComponent(instanceName)}`, {
      method: "POST"
    });
    if (result.error === true) {
      const detail = normalizeEvolutionErrorDetail(result.message);
      throw new Error(`Evolution API não conseguiu reiniciar a instância${detail ? `: ${detail}` : ""}`);
    }
  }

  async logout(instanceName: string): Promise<void> {
    await this.request(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
  }

  async deleteInstance(instanceName: string): Promise<void> {
    try {
      await this.request(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: "DELETE" });
    } catch (error) {
      if (error instanceof EvolutionApiError && error.upstreamStatus === 404) return;
      throw error;
    } finally {
      this.instanceCache.delete(instanceName);
    }
  }

  async sendText(instanceName: string, number: string, text: string, quoted?: { key: ReadReceipt; text: string }): Promise<{ externalId: string }> {
    const result = await this.request<{ key?: Json; id?: string | number }>(`/message/sendText/${encodeURIComponent(instanceName)}`, {
      method: "POST", body: JSON.stringify({
        number: number.split("@")[0], text,
        ...(quoted ? { quoted: { key: quoted.key, message: { conversation: quoted.text } } } : {})
      })
    });
    const key = result.key as Json | undefined;
    const externalId = String(key?.id ?? result.id ?? "");
    if (!externalId) throw new Error("Evolution API did not return a message id");
    return { externalId };
  }

  async deleteMessageForEveryone(instanceName: string, receipt: ReadReceipt): Promise<void> {
    await this.request(`/chat/deleteMessageForEveryone/${encodeURIComponent(instanceName)}`, {
      method: "DELETE",
      body: JSON.stringify(receipt)
    });
  }

  async updateText(
    instanceName: string,
    destination: string,
    externalMessageId: string,
    text: string
  ): Promise<void> {
    await this.request(`/chat/updateMessage/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({
        number: destination.split("@")[0],
        key: {
          remoteJid: destination,
          fromMe: true,
          id: externalMessageId
        },
        text
      })
    });
  }

  async sendMedia(instanceName: string, number: string, media: OutboundMediaPayload): Promise<{ externalId: string }> {
    const result = media.mediaType === "audio"
      ? await this.request<{ key?: Json; id?: string | number }>(`/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({
          number: number.split("@")[0],
          audio: media.dataBase64,
          // Evolution API v2.3.7-baileys-rc13 requires this flag to emit a voice note.
          ptt: true
        })
      })
      : await this.request<{ key?: Json; id?: string | number }>(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({
          number: number.split("@")[0],
          mediatype: media.mediaType,
          mimetype: media.mimeType,
          media: media.dataBase64,
          fileName: media.fileName,
          ...(media.caption ? { caption: media.caption } : {})
        })
      });
    const key = result.key as Json | undefined;
    const externalId = String(key?.id ?? result.id ?? "");
    if (!externalId) throw new Error("Evolution API did not return a message id");
    return { externalId };
  }

  async sendSticker(instanceName: string, number: string, dataBase64: string): Promise<{ externalId: string }> {
    const result = await this.request<{ key?: Json; id?: string | number }>(`/message/sendSticker/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({ number: number.split("@")[0], sticker: dataBase64 })
    });
    const key = result.key as Json | undefined;
    const externalId = String(key?.id ?? result.id ?? "");
    if (!externalId) throw new Error("Evolution API did not return a sticker message id");
    return { externalId };
  }
}
