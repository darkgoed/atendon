import { NotImplementedError } from "./types.js";
export const HOMOLOGATED_PROVIDER_CODES = ["mercadopago"] as const;
export const REGISTERED_BUT_BLOCKED_PROVIDER_CODES = ["stripe", "pagbank"] as const;
export type HomologatedProviderCode = typeof HOMOLOGATED_PROVIDER_CODES[number];
export function isHomologatedProvider(code: string): code is HomologatedProviderCode { return (HOMOLOGATED_PROVIDER_CODES as readonly string[]).includes(code); }
export function providerNotHomologated(code: string): Error & { code: string; statusCode: number } { const e = new NotImplementedError(`Provedor não homologado: ${code}`) as Error & { code: string; statusCode: number }; e.code = "PROVIDER_NOT_HOMOLOGATED"; e.statusCode = 400; return e; }
/**
 * Homologação é DADO (billing_providers.homologated); esta lista existe só para
 * o que não tem linha no banco — a factory e a rota pública de webhook, que
 * recebem um código cru vindo de fora.
 */
export function assertHomologatedProvider(code: string): void { if (!isHomologatedProvider(code)) throw providerNotHomologated(code); }
/**
 * Cobrança automática exige um gateway que confirme pagamento sozinho.
 * `manual_pix` é confirmado à mão pelo ROOT (handleWebhook lança
 * NotImplementedError), então nunca pode ser escolhido para cobrar.
 * Os demais códigos são validados pela coluna `homologated` na própria linha
 * travada em charges.ts — por isso aqui só barramos o PIX manual.
 */
export function assertAutomaticProvider(code: string): void { if (code === "manual_pix") throw providerNotHomologated(code); }
