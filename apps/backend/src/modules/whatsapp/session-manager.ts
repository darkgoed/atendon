import type { Pool } from "pg";
import type { Logger } from "pino";
import type { MessageGateway, QuotedMessage, ReadReceipt } from "../messages/types.js";
import type { AppConfig } from "../../config.js";
import { EvolutionClient, isEvolutionConnectionClosedError } from "./evolution-client.js";
import type { OutboundMediaPayload } from "./evolution-client.js";
import { SessionRepository } from "./session-repository.js";
import { isWithinBusinessHours, loadBusinessHoursConfig } from "./business-hours.js";
import { isQuarantinedPhone } from "../../phone.js";

const PRESENCE_REFRESH_INTERVAL_MS = 30_000;
const PRESENCE_REFRESH_MAX_BACKOFF_MS = 10 * 60_000;
const PRESENCE_FAILURE_LOG_INTERVAL_MS = 5 * 60_000;

export class WhatsAppSessionManager implements MessageGateway {
  private readonly sessions: SessionRepository;
  private readonly evolution: EvolutionClient;
  private readonly presenceRefreshTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly presenceRefreshFailures: Map<string, number> = new Map();
  private readonly presenceFailureLastLoggedAt: Map<string, number> = new Map();
  private readonly instanceRecoveries: Map<string, Promise<void>> = new Map();

  constructor(private readonly db: Pool, private readonly config: AppConfig, private readonly logger: Logger) {
    this.sessions = new SessionRepository(db);
    this.evolution = new EvolutionClient(config);
  }

  async startAll(): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) {
      this.logger.info("WhatsApp integration disabled");
      return;
    }
    const sessions = await this.sessions.listRunnable();
    const results = await Promise.allSettled(sessions.map((session) => this.start(session.id, session.instanceName)));
    const failed = results.filter((result) => result.status === "rejected").length;
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        this.logger.warn({ err: result.reason, sessionId: sessions[index].id,
          instanceName: sessions[index].instanceName }, "Evolution tenant instance provisioning failed");
      }
    });
    this.logger.info({ count: sessions.length - failed, failed }, "Evolution tenant instances provisioned");
  }

  async start(sessionId: string, instanceName?: string): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    const name = instanceName ?? await this.sessions.instanceName(sessionId);
    await this.evolution.ensureInstance(name);
    const connection = await this.evolution.connect(name);
    const code = String(connection.code ?? object(connection).pairingCode ?? "");
    if (code) await this.sessions.updateStatus(sessionId, "qr_pending", undefined, code);
    // Set presence to available after successful connect (not during ensureInstance which fails during pairing).
    // Outside business hours the tenant should reconnect already offline instead of flashing online.
    try {
      const tenantId = await this.sessions.tenantId(sessionId);
      const hours = await loadBusinessHoursConfig(this.db, tenantId);
      if (isWithinBusinessHours(new Date(), hours)) {
        await this.evolution.setPresence(name, "available");
        this.startPresenceRefresh(sessionId);
      } else {
        await this.evolution.setPresence(name, "unavailable");
      }
    } catch (error) {
      this.logger.warn({ err: error, sessionId, name }, "setPresence after connect failed, will retry on CONNECTION_UPDATE");
    }
    try {
      await this.syncStoredContactAvatars(sessionId, name);
    } catch (error) {
      this.logger.warn({ err: error, sessionId, name }, "Could not synchronize stored WhatsApp contact avatars");
    }
  }

  /** Traz a sessão de volta para "disponível" e retoma o auto-refresh de presença (início do horário comercial). */
  async goOnline(sessionId: string): Promise<void> {
    await this.setPresence(sessionId, "available");
    this.startPresenceRefresh(sessionId);
  }

  async stop(sessionId: string): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) return;
    this.stopPresenceRefresh(sessionId);
    await this.evolution.logout(await this.sessions.instanceName(sessionId));
    await this.sessions.updateStatus(sessionId, "disconnected");
  }

  async reconnect(sessionId: string): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    const instanceName = await this.sessions.instanceName(sessionId);
    try {
      await this.evolution.logout(instanceName);
    } catch (error) {
      this.logger.warn({ err: error, sessionId }, "Evolution logout failed while reconnecting");
    }
    this.stopPresenceRefresh(sessionId);
    await this.sessions.prepareReconnect(sessionId);
    await this.start(sessionId, instanceName);
  }

  async sendText(sessionId: string, contactPhone: string, text: string, quoted?: QuotedMessage): Promise<{ externalId: string }> {
    this.assertRoutableDestination(contactPhone);
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    return this.sendWithConnectionRecovery(sessionId, "text", (instanceName) =>
      this.evolution.sendText(instanceName, contactPhone, text, quoted));
  }

  async deleteMessageForEveryone(sessionId: string, destination: string, receipt: ReadReceipt): Promise<void> {
    this.assertRoutableDestination(destination);
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    return this.sendWithConnectionRecovery(sessionId, "update", (instanceName) =>
      this.evolution.deleteMessageForEveryone(instanceName, receipt));
  }

  async updateText(
    sessionId: string,
    destination: string,
    externalMessageId: string,
    text: string
  ): Promise<void> {
    this.assertRoutableDestination(destination);
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    return this.sendWithConnectionRecovery(sessionId, "update", (instanceName) =>
      this.evolution.updateText(instanceName, destination, externalMessageId, text));
  }

  async sendMedia(sessionId: string, contactPhone: string, media: OutboundMediaPayload): Promise<{ externalId: string }> {
    this.assertRoutableDestination(contactPhone);
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    return this.sendWithConnectionRecovery(sessionId, "media", (instanceName) =>
      this.evolution.sendMedia(instanceName, contactPhone, media));
  }

  async sendSticker(sessionId: string, contactPhone: string, sticker: { dataBase64: string }): Promise<{ externalId: string }> {
    this.assertRoutableDestination(contactPhone);
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    return this.sendWithConnectionRecovery(sessionId, "sticker", (instanceName) =>
      this.evolution.sendSticker(instanceName, contactPhone, sticker.dataBase64));
  }

  private assertRoutableDestination(destination: string): void {
    if (isQuarantinedPhone(destination)) {
      throw new Error("Outbound delivery blocked for a quarantined legacy phone");
    }
  }

  private async sendWithConnectionRecovery<T>(
    sessionId: string,
    operation: "text" | "media" | "sticker" | "update",
    send: (instanceName: string) => Promise<T>
  ): Promise<T> {
    const instanceName = await this.sessions.instanceName(sessionId);
    try {
      return await send(instanceName);
    } catch (error) {
      if (!isEvolutionConnectionClosedError(error)) throw error;
      try {
        await this.recoverClosedConnection(sessionId, instanceName, operation, error);
      } catch (recoveryError) {
        this.logger.error(
          { err: recoveryError, originalError: error, sessionId, instanceName, operation },
          "Evolution connection recovery failed"
        );
        throw error;
      }
      return send(instanceName);
    }
  }

  private async recoverClosedConnection(
    sessionId: string,
    instanceName: string,
    operation: "text" | "media" | "sticker" | "update",
    cause: unknown
  ): Promise<void> {
    const pending = this.instanceRecoveries.get(instanceName);
    if (pending) return pending;

    const recovery = (async () => {
      this.logger.warn(
        { err: cause, sessionId, instanceName, operation },
        "Evolution socket closed; restarting instance before one send retry"
      );
      await this.evolution.restart(instanceName);
      this.logger.info(
        { sessionId, instanceName, operation },
        "Evolution instance restarted after closed socket"
      );
    })();
    this.instanceRecoveries.set(instanceName, recovery);
    try {
      await recovery;
    } finally {
      if (this.instanceRecoveries.get(instanceName) === recovery) {
        this.instanceRecoveries.delete(instanceName);
      }
    }
  }

  async downloadMedia(sessionId: string, externalId: string): Promise<{
    base64: string;
    mimeType: string;
    fileName?: string;
  }> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    return this.evolution.downloadMedia(await this.sessions.instanceName(sessionId), externalId);
  }

  async refreshContactAvatar(sessionId: string, contactPhone: string): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) return;
    const claimed = await this.db.query<{ tenant_id: string }>(
      `UPDATE conversations SET contact_avatar_updated_at=now()
       WHERE session_id=$1 AND contact_phone=$2
         AND (contact_avatar_updated_at IS NULL OR contact_avatar_updated_at < now() - interval '6 hours')
       RETURNING tenant_id`,
      [sessionId, contactPhone]
    );
    if (!claimed.rows[0]) return;
    try {
      const avatarUrl = await this.evolution.fetchProfilePicture(
        await this.sessions.instanceName(sessionId),
        contactPhone
      );
      await this.db.query(
        `UPDATE conversations SET contact_avatar_url=$3,contact_avatar_updated_at=now()
         WHERE tenant_id=$1 AND session_id=$2 AND contact_phone=$4`,
        [claimed.rows[0].tenant_id, sessionId, avatarUrl, contactPhone]
      );
    } catch (error) {
      await this.db.query(
        `UPDATE conversations SET contact_avatar_updated_at=now() - interval '5 hours 45 minutes'
         WHERE tenant_id=$1 AND session_id=$2 AND contact_phone=$3`,
        [claimed.rows[0].tenant_id, sessionId, contactPhone]
      );
      throw error;
    }
  }

  private async syncStoredContactAvatars(sessionId: string, instanceName: string): Promise<void> {
    const contacts = (await this.evolution.fetchContacts(instanceName))
      .filter((contact) => contact.profilePicUrl)
      .map((contact) => ({
        phone: contact.remoteJid.split("@")[0].split(":")[0],
        jid: contact.remoteJid,
        avatarUrl: contact.profilePicUrl
      }));
    if (!contacts.length) return;
    const tenantId = await this.sessions.tenantId(sessionId);
    await this.db.query(
      `WITH contact_avatar AS (
         SELECT phone,jid,avatar_url
         FROM jsonb_to_recordset($3::jsonb) AS item(phone text,jid text,avatar_url text)
       )
       UPDATE conversations conversation SET
         contact_jid=COALESCE(conversation.contact_jid,contact_avatar.jid),
         contact_avatar_url=contact_avatar.avatar_url,
         contact_avatar_updated_at=now()
       FROM contact_avatar
       WHERE conversation.tenant_id=$1 AND conversation.session_id=$2
         AND regexp_replace(conversation.contact_phone,'\\D','','g')=
             regexp_replace(contact_avatar.phone,'\\D','','g')`,
      [tenantId, sessionId, JSON.stringify(contacts.map((contact) => ({
        phone: contact.phone,
        jid: contact.jid,
        avatar_url: contact.avatarUrl
      })))]
    );
  }

  async sendPresence(sessionId: string, contactPhone: string, presence: "composing" | "paused", delayMs?: number): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    try {
      await this.evolution.sendPresence(await this.sessions.instanceName(sessionId), contactPhone, presence, delayMs);
    } catch (error) {
      this.logger.warn({ err: error, sessionId, presence }, "Evolution sendPresence failed");
    }
  }

  async markMessageAsRead(sessionId: string, receipts: ReadReceipt | ReadReceipt[]): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    try {
      await this.evolution.markMessageAsRead(await this.sessions.instanceName(sessionId), receipts);
    } catch (error) {
      this.logger.warn({ err: error, sessionId, receiptCount: Array.isArray(receipts) ? receipts.length : 1 }, "Evolution markMessageAsRead failed");
      throw error;
    }
  }

  async setPresence(sessionId: string, presence: "available" | "unavailable", retries = 1): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    // Going offline must stop the refresh loop even when Evolution is currently
    // unreachable, otherwise the next timer could publish "available" again.
    if (presence === "unavailable") this.stopPresenceRefresh(sessionId);
    await this.trySetPresence(sessionId, presence, retries);
  }

  private async trySetPresence(sessionId: string, presence: "available" | "unavailable", retries: number): Promise<boolean> {
    let lastError: Error | undefined;
    const attempts = Math.max(1, retries);
    let instanceName: string;
    try {
      instanceName = await this.sessions.instanceName(sessionId);
    } catch (error) {
      this.logPresenceFailure(sessionId, presence, error, attempts);
      return false;
    }

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.evolution.setPresence(instanceName, presence);
        this.presenceFailureLastLoggedAt.delete(`${sessionId}:${presence}`);
        return true;
      } catch (error) {
        lastError = error as Error;
        if (attempt < attempts) {
          this.logger.debug({ sessionId, presence, attempt }, "Evolution setPresence failed; retrying");
          await new Promise((resolve) => setTimeout(resolve, 1_000 * attempt));
        }
      }
    }
    this.logPresenceFailure(sessionId, presence, lastError, attempts);
    return false;
  }

  private logPresenceFailure(sessionId: string, presence: "available" | "unavailable", error: unknown, attempts: number): void {
    const key = `${sessionId}:${presence}`;
    const now = Date.now();
    const lastLoggedAt = this.presenceFailureLastLoggedAt.get(key) ?? 0;
    if (now - lastLoggedAt < PRESENCE_FAILURE_LOG_INTERVAL_MS) return;
    this.presenceFailureLastLoggedAt.set(key, now);
    this.logger.warn(
      { err: error, sessionId, presence, attempts },
      "Evolution presence unavailable; continuing without presence confirmation"
    );
  }

  async sendReaction(sessionId: string, contactPhone: string, receipt: ReadReceipt, emoji: string): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    try {
      await this.sendReactionStrict(sessionId, contactPhone, receipt, emoji);
    } catch (error) {
      this.logger.warn({ err: error, sessionId }, "Evolution sendReaction failed");
    }
  }

  async sendReactionStrict(sessionId: string, contactPhone: string, receipt: ReadReceipt, emoji: string): Promise<void> {
    if (!this.config.WHATSAPP_ENABLED) throw new Error("WhatsApp integration is disabled");
    await this.evolution.sendReaction(await this.sessions.instanceName(sessionId), contactPhone, receipt, emoji);
  }

  async stopAll(): Promise<void> {
    for (const sessionId of this.presenceRefreshTimers.keys()) {
      this.stopPresenceRefresh(sessionId);
    }
  }

  private startPresenceRefresh(sessionId: string): void {
    if (this.presenceRefreshTimers.has(sessionId)) return;
    this.presenceRefreshFailures.set(sessionId, 0);
    this.schedulePresenceRefresh(sessionId, PRESENCE_REFRESH_INTERVAL_MS);
    this.logger.info({ sessionId, intervalMs: PRESENCE_REFRESH_INTERVAL_MS }, "Started periodic presence refresh");
  }

  private schedulePresenceRefresh(sessionId: string, delayMs: number): void {
    const timer = setTimeout(async () => {
      const refreshed = await this.trySetPresence(sessionId, "available", 1);
      // stopPresenceRefresh may have run while the provider request was pending.
      if (this.presenceRefreshTimers.get(sessionId) !== timer) return;

      const failures = refreshed ? 0 : (this.presenceRefreshFailures.get(sessionId) ?? 0) + 1;
      this.presenceRefreshFailures.set(sessionId, failures);
      if (refreshed) this.logger.debug({ sessionId }, "Periodic presence refresh sent");
      const nextDelay = refreshed
        ? PRESENCE_REFRESH_INTERVAL_MS
        : Math.min(PRESENCE_REFRESH_INTERVAL_MS * 2 ** Math.min(failures, 5), PRESENCE_REFRESH_MAX_BACKOFF_MS);
      this.schedulePresenceRefresh(sessionId, nextDelay);
    }, delayMs);
    timer.unref();
    this.presenceRefreshTimers.set(sessionId, timer);
  }

  private stopPresenceRefresh(sessionId: string): void {
    const timer = this.presenceRefreshTimers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.presenceRefreshTimers.delete(sessionId);
      this.presenceRefreshFailures.delete(sessionId);
      this.logger.info({ sessionId }, "Stopped periodic presence refresh");
    }
  }
}

function object(value: unknown): Record<string, unknown> { return value && typeof value === "object" ? value as Record<string, unknown> : {}; }
