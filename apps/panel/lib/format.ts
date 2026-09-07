import { formatBrazilianPhone } from "./phone";
import { leadStatusLabel } from "./labels";
export function formatBRLFromCents(cents: number, locale = "pt-BR", currency = "BRL") { return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100); }
export function formatPanelDateTime(value: string | Date, options: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" }, locale = "pt-BR", timeZone?: string) { return new Intl.DateTimeFormat(locale, { ...options, ...(timeZone ? { timeZone } : {}) }).format(new Date(value)); }
export function formatTimeInZone(value: string | Date, timeZone: string, options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" }, locale = "pt-BR") { return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(value)); }
export function formatPhone(value: string) { return formatBrazilianPhone(value); }
export const formatLeadStatusLabel = leadStatusLabel;
export { leadStatusLabel };
