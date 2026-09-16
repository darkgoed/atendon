import type { FastifyReply, FastifyRequest } from "fastify";
import {
  normalizeInstagramWebhook,
  verifyInstagramSignature
} from "./provider.js";
import type { NormalizedInstagramEvent } from "./types.js";

export type InstagramWebhookOwner = {
  tenantId: string;
  sessionId: string;
};

export type InstagramWebhookRepository = {
  persistEvent(
    tenantId: string,
    sessionId: string,
    event: NormalizedInstagramEvent,
    rawBody: Buffer
  ): Promise<unknown>;
};

export type InstagramWebhookOptions = {
  repository: InstagramWebhookRepository;
  appSecret: string;
  resolveAccount(accountId: string): Promise<InstagramWebhookOwner | null>;
  rawBody: Buffer;
};

function signatureHeader(request: FastifyRequest): string | undefined {
  const value = request.headers["x-hub-signature-256"];
  return typeof value === "string" ? value : undefined;
}

export async function handleInstagramWebhook(
  request: FastifyRequest,
  reply: FastifyReply,
  options: InstagramWebhookOptions
): Promise<FastifyReply> {
  const rawBody = options.rawBody;
  if (!Buffer.isBuffer(rawBody)) {
    return reply.code(400).send({ error: "raw body required" });
  }
  if (!verifyInstagramSignature(rawBody, signatureHeader(request), options.appSecret)) {
    return reply.code(401).send({ error: "invalid signature" });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return reply.code(400).send({ error: "invalid payload" });
  }

  const events = normalizeInstagramWebhook(payload);
  for (const event of events) {
    const owner = await options.resolveAccount(event.accountId);
    if (!owner) return reply.code(404).send({ error: "unknown account" });
    await options.repository.persistEvent(
      owner.tenantId,
      owner.sessionId,
      event,
      rawBody
    );
  }
  return reply.code(200).send({ ok: true });
}
