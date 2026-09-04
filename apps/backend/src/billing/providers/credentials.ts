import { encryptSecret, decryptSecret, type SecretKeyring } from "../../modules/ai-router/secret-box.js";
export function credentialsHint(value: string): string { return `••••${value.slice(-4)}`; }
export function encryptCredentials(credentials: string | Record<string, unknown>, secret: string): string { return encryptSecret(typeof credentials === "string" ? credentials : JSON.stringify(credentials), secret); }
export function decryptCredentials<T = Record<string, unknown>>(encrypted: string, keys: string | SecretKeyring): T { return JSON.parse(decryptSecret(encrypted, keys)) as T; }
export function encryptWebhookSecret(value: string, secret: string): string { return encryptSecret(value, secret); }
export function decryptWebhookSecret(encrypted: string, keys: string | SecretKeyring): string { return decryptSecret(encrypted, keys); }
