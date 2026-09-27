import { z } from "zod";

/**
 * Proposal Brand — identidade visual persistida POR TENANT.
 * A identidade Tripz vive apenas no registro do tenant Tripz; o default
 * aqui é deliberadamente neutro para nunca contaminar outras empresas.
 */

export const proposalBrandTokensSchema = z.object({
  background: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  primary: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  secondary: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  sand: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  /** Texto corrido sobre o fundo marfim. */
  ink: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  /** Texto secundário/notas. */
  muted: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  /** Cartões informativos claros (ex.: "IMPORTANTE"). */
  info: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/)
}).strict();

export type ProposalBrandTokens = z.infer<typeof proposalBrandTokensSchema>;

export const proposalBrandConfigSchema = z.object({
  /** "editorial-v1" é o único template suportado; campo reserva evolução. */
  activeTemplate: z.literal("editorial-v1").default("editorial-v1"),
  tokens: proposalBrandTokensSchema,
  fonts: z.object({
    serif: z.string().trim().min(1).max(80).default("Noto Serif Display"),
    sans: z.string().trim().min(1).max(80).default("Noto Sans")
  }).strict().default({}),
  /** Logo em data URL (png/jpeg/svg), usado na capa/fechamento quando presente. */
  logo: z.object({
    dataUrl: z.string().trim().regex(/^data:image\/(png|jpeg|svg\+xml);base64,[A-Za-z0-9+/=]+$/),
    alt: z.string().trim().min(1).max(120).default("logo")
  }).strict().optional(),
  footer: z.object({
    company: z.string().trim().min(1).max(120).default("Agência"),
    register: z.string().trim().min(1).max(160).optional(),
    phone: z.string().trim().min(1).max(60).optional(),
    email: z.string().trim().email().max(200).optional(),
    site: z.string().trim().max(200).optional()
  }).strict().default({ company: "Agência" }),
  commercial: z.object({
    defaultCurrency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("BRL"),
    defaultPaymentSummary: z.string().trim().min(1).max(600).optional(),
    defaultDifferentials: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
    defaultPriceNotes: z.array(z.string().trim().min(1).max(400)).max(6).default([]),
    commercialWarnings: z.array(z.string().trim().min(1).max(400)).max(6).default([])
  }).strict().default({}),
  /** Orientação de voz para a IA escrever a narrativa (por tenant). */
  styleNotes: z.string().trim().min(1).max(2000).optional(),
  /** Linha de créditos visuais default (complementa sources do spec). */
  creditsLine: z.string().trim().min(1).max(600).optional()
}).strict();

export type ProposalBrandConfig = z.infer<typeof proposalBrandConfigSchema>;

/** Default NEUTRO (nunca usar tokens de uma empresa específica aqui). */
export const NEUTRAL_PROPOSAL_BRAND: ProposalBrandConfig = proposalBrandConfigSchema.parse({
  tokens: {
    background: "#F4F4F2",
    primary: "#1F2937",
    secondary: "#475569",
    accent: "#9A6B4F",
    sand: "#DDD9D0",
    ink: "#252C33",
    muted: "#6B7280",
    info: "#EBEEF1"
  },
  commercial: {}
});

/** Identidade editorial Tripz (extraída das referências Manus aprovadas). */
export const TRIPZ_PROPOSAL_BRAND: ProposalBrandConfig = proposalBrandConfigSchema.parse({
  tokens: {
    background: "#F7F3EB",
    primary: "#123047",
    secondary: "#315C73",
    accent: "#B8654A",
    sand: "#D8C5A2",
    ink: "#25333D",
    muted: "#6E7B84",
    info: "#E7EEF0"
  },
  footer: { company: "Tripz Turismo" },
  styleNotes: 'Voz Tripz: premium, elegante, humana e descritiva. Narrativa em pt-BR, segunda pessoa do plural ("vocês") quando falar com os viajantes. Headlines editoriais com progressão emocional e geográfica; eyebrows em caixa alta com tracking; nada de clichês de marketing ("experiência inesquecível", "jornada dos sonhos") salvo uso proposital; preferir frases curtas e concretas; comercial sempre informativo, com diferenciais de atendimento (check-in personalizado, emergencial bilíngue, acompanhamento de voo e assistência).',
  commercial: {
    defaultCurrency: "BRL",
    defaultDifferentials: [
      "Check-in personalizado na chegada",
      "Atendimento emergencial em português, inglês ou espanhol",
      "Acompanhamento do voo",
      "Assessoria completa durante toda a viagem",
      "Assistência jurídica gratuita, se necessário"
    ],
    defaultPriceNotes: [
      "Os valores cotados podem sofrer alterações tarifárias e/ou cambiais no momento da reserva."
    ],
    commercialWarnings: []
  }
});

export function isTripzTenantName(name: string | null | undefined): boolean {
  return /\btripz\b/i.test(name ?? "");
}
