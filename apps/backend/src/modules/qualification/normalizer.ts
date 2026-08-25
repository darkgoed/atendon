import type { FlowStep } from "./flow.js";

export function normalizeText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

const WORD_NUMBERS: Record<string, number> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7,
  oito: 8, nove: 9, dez: 10, quinze: 15, vinte: 20, trinta: 30, quarenta: 40,
  cinquenta: 50, sessenta: 60, setenta: 70, oitenta: 80, noventa: 90, cem: 100,
  meio: 0.5, meia: 0.5
};

/** Extrai valores numéricos ("45 mil", "R$ 45.000", "dois", "1,5 milhão") do texto. */
export function extractNumbers(text: string): number[] {
  const normalized = normalizeText(text)
    .replace(/r\$\s*/g, "")
    .split(" ")
    .map((word) => WORD_NUMBERS[word]?.toString() ?? word)
    .join(" ");
  const values: number[] = [];
  for (const match of normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*(mil(?:hao|hoes)?|k\b)?/g)) {
    let value = Number.parseFloat(match[1].replace(/\.(?=\d{3}\b)/g, "").replace(",", "."));
    if (Number.isNaN(value)) continue;
    if (match[2]) value *= /milh/.test(match[2]) ? 1_000_000 : 1_000;
    values.push(value);
  }
  return values;
}

function adjustForBounds(normalized: string, value: number): number {
  if (/menos de|abaixo de|nem chega|no maximo|quase/.test(normalized)) return value - 0.01;
  if (/mais de|acima de|passa de|mais que/.test(normalized)) return value + 0.01;
  return value;
}

/** Anos de mercado, considerando meses e frases como "quase 3 anos". Null quando não dá para inferir. */
export function classifyYears(text: string): number | null {
  const normalized = normalizeText(text);
  const numbers = extractNumbers(text);
  if (!numbers.length) return null;
  // "faz um tempinho" contém a palavra-número "um", mas não fala de anos/meses: ambíguo.
  const mentionsUnit = /\b(ano|anos|mes|meses)\b/.test(normalized);
  const bareNumber = /^\d+([.,]\d+)?$/.test(normalized);
  if (!mentionsUnit && !bareNumber) return null;
  let value = Math.max(...numbers);
  if (/\bmes(es)?\b/.test(normalized) && !/\bano(s)?\b/.test(normalized)) value /= 12;
  return adjustForBounds(normalized, value);
}

export function yearsBand(value: number): number {
  if (value < 1) return 0;
  if (value <= 3) return 1;
  if (value <= 5) return 2;
  return 3;
}

/** Faturamento mensal em reais. Null quando ambíguo (ex.: "500" sem unidade). */
export function classifyRevenue(text: string): number | null {
  const normalized = normalizeText(text);
  const numbers = extractNumbers(text);
  if (!numbers.length) return null;
  // Palavras-número soltas ("um pouco") sem dígitos nem unidade monetária são ambíguas.
  if (!/\d/.test(normalized) && !/(mil|milhao|milhoes|reais|r\$|\bk\b)/.test(normalized)) return null;
  let value = Math.max(...numbers);
  // ponytail: "faturo uns 45" quase sempre significa 45 mil; valores intermediários sem unidade ficam ambíguos.
  if (value < 1_000) {
    if (value > 150) return null;
    value *= 1_000;
  }
  return adjustForBounds(normalized, value);
}

export function revenueBand(value: number): number {
  if (value <= 10_000) return 0;
  if (value <= 20_000) return 1;
  if (value < 30_000) return 2; // 30 mil em diante já conta como a faixa qualificada
  if (value <= 50_000) return 3;
  if (value <= 100_000) return 4;
  return 5;
}

export function classifyBoolean(text: string): "SIM" | "NÃO" | null {
  const normalized = normalizeText(text);
  if (/nao sei|talvez|depende|acho que|pode ser que nao/.test(normalized)) return null;
  // Negação domina: "não consigo" precisa virar NÃO mesmo contendo "consigo".
  if (/\bn(ao|em)\b|\bnunca\b|sem condic(ao|oes)|impossivel|infelizmente|\bnop\b/.test(normalized)) return "NÃO";
  if (/\bsim\b|\bclaro\b|com certeza|\bconsigo\b|\bposso\b|conseguiria|poderia|\bteria\b|tenho como|tenho interesse|\bbora\b|\bvamos\b|pode ser|positivo|obvio|logico|uhum|aham|\bisso\b|to dentro|topo\b/.test(normalized)) return "SIM";
  return null;
}

function matchesOptionLabel(normalized: string, label: string): boolean {
  const escaped = normalizeText(label).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(normalized);
}

export function normalizeInstagram(text: string): string | null {
  const trimmed = text.trim().slice(0, 200);
  const normalized = normalizeText(trimmed);
  if (/^(nao (tenho|possuo|tem)|sem instagram|nao uso|nao possui)$/.test(normalized)) return "NÃO POSSUI";
  if (/^@[a-z0-9._]{1,30}$/i.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (["http:", "https:"].includes(url.protocol) && /(^|\.)instagram\.com$/i.test(url.hostname)) return url.toString();
  } catch { /* resposta não é URL */ }
  return null;
}

export function matchAnswerCandidates(step: FlowStep, text: string): string[] {
  const normalized = normalizeText(text);
  const matches = new Set<string>();
  for (const option of step.options ?? []) {
    if (matchesOptionLabel(normalized, option.value)) matches.add(option.value);
    if (option.keywords?.some((keyword) => new RegExp(keyword, "u").test(normalized))) matches.add(option.value);
  }
  return [...matches];
}

/**
 * Normaliza a resposta livre para uma opção do formulário.
 * Retorna null quando ambígua — nunca inventa uma resposta.
 */
export function matchAnswer(step: FlowStep, text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (step.kind === "text") return step.field === "instagram" ? normalizeInstagram(trimmed) : trimmed.slice(0, 200);

  const options = step.options ?? [];
  const candidates = matchAnswerCandidates(step, text);
  if (candidates.length > 1) return null;
  if (candidates.length === 1) return candidates[0];

  switch (step.kind) {
    case "years": {
      const value = classifyYears(trimmed);
      return value === null ? null : options[yearsBand(value)]?.value ?? null;
    }
    case "revenue": {
      const value = classifyRevenue(trimmed);
      return value === null ? null : options[revenueBand(value)]?.value ?? null;
    }
    case "boolean":
      return classifyBoolean(trimmed);
    default:
      return null;
  }
}
