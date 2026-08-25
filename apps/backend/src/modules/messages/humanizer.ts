export interface Range { min: number; max: number }

export interface DebounceConfig {
  initialWindowMs: Range;
  silenceWindowMs: Range;
  extensionMs: Range;
}

export interface HumanizerConfig {
  readDelay: Range;
  readingPause: Range;
  composing: { wpm: number; jitterMs: number; minMs: number; maxMs: number; resendIntervalMs: number };
  presence: {
    onlineSessionMin: Range;
    offlineGapMin: Range;
    inactivityBeforeUnavailableMin: number;
    activeHours: { start: number; end: number };
  };
  debounce: DebounceConfig;
  messageSplit: { maxWordsPerBubble: number; pauseBetweenBubblesMs: Range };
  timeOfDayMultiplier: { outsideActiveHours: number };
  reaction: { probability: number; emojis: string[] };
  rateLimit: { maxMessagesPerContactPerMinute: number };
}

function isDebounceConfig(value: unknown): value is DebounceConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return "initialWindowMs" in v && "silenceWindowMs" in v && "extensionMs" in v;
}

// Values at or above this threshold were used to neutralize the split while it
// was disabled; treat them as "unset" so those tenants regain active bubbles.
const LEGACY_SPLIT_DISABLED_THRESHOLD = 1_000;

export function migrateHumanizerConfig(raw: unknown): HumanizerConfig {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_HUMANIZER_CONFIG };
  const cfg = raw as Record<string, unknown>;
  const split = cfg.messageSplit as { maxWordsPerBubble?: number } | undefined;
  if (!split || typeof split.maxWordsPerBubble !== "number" || split.maxWordsPerBubble >= LEGACY_SPLIT_DISABLED_THRESHOLD) {
    cfg.messageSplit = { ...DEFAULT_HUMANIZER_CONFIG.messageSplit };
  }
  // Normalize legacy debounce formats until every tenant has crossed the DB migration.
  if (!isDebounceConfig(cfg.debounce)) {
    const old = cfg.debounce as Record<string, unknown> | undefined;
    const silence = old?.silenceWindowMs as Range | undefined;
    const initial = old?.initialWindowMs as Range | undefined;
    const extension = old?.extensionMs as Range | undefined;
    const legacyMaximum = old?.maxWindowMs as number | undefined;
    cfg.debounce = {
      initialWindowMs: initial ?? (silence
        ? { min: Math.round(silence.min / 3), max: Math.round(silence.max / 3) }
        : DEFAULT_HUMANIZER_CONFIG.debounce.initialWindowMs),
      silenceWindowMs: silence ?? extension ?? DEFAULT_HUMANIZER_CONFIG.debounce.silenceWindowMs,
      extensionMs: extension ?? (legacyMaximum
        ? { min: legacyMaximum, max: legacyMaximum }
        : DEFAULT_HUMANIZER_CONFIG.debounce.extensionMs)
    };
  }
  return cfg as unknown as HumanizerConfig;
}

export const DEFAULT_HUMANIZER_CONFIG: HumanizerConfig = {
  readDelay: { min: 350, max: 900 },
  readingPause: { min: 300, max: 850 },
  composing: { wpm: 165, jitterMs: 350, minMs: 700, maxMs: 4_000, resendIntervalMs: 5_000 },
  presence: {
    onlineSessionMin: { min: 12, max: 40 },
    offlineGapMin: { min: 4, max: 15 },
    inactivityBeforeUnavailableMin: 4,
    activeHours: { start: 9, end: 19 }
  },
  // initialWindowMs must be at least as long as silenceWindowMs: it is the
  // window the FIRST message of a burst waits alone. A shorter window let a
  // fast-typed first bubble flush and start its own AI turn before the next
  // bubble arrived, splitting one thought into separate, uncoalesced replies.
  debounce: {
    initialWindowMs: { min: 1_600, max: 2_800 },
    silenceWindowMs: { min: 1_600, max: 2_800 },
    extensionMs: { min: 8_000, max: 16_000 }
  },
  messageSplit: { maxWordsPerBubble: 30, pauseBetweenBubblesMs: { min: 150, max: 500 } },
  timeOfDayMultiplier: { outsideActiveHours: 1 },
  reaction: { probability: 0.12, emojis: ["👍", "❤️", "😊"] },
  rateLimit: { maxMessagesPerContactPerMinute: 20 }
};

export function randomBetween(range: Range): number {
  return Math.floor(Math.random() * (range.max - range.min + 1)) + range.min;
}

export function isActiveHour(config: HumanizerConfig, date = new Date()): boolean {
  const hour = date.getHours();
  const { start, end } = config.presence.activeHours;
  return start <= end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function humanizedDelay(ms: number, config: HumanizerConfig, date = new Date()): number {
  return isActiveHour(config, date) ? ms : Math.round(ms * config.timeOfDayMultiplier.outsideActiveHours);
}

export function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

export function composingDuration(text: string, config: HumanizerConfig): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const base = (words / config.composing.wpm) * 60_000;
  const jitter = config.composing.jitterMs === 0 ? 0 : randomBetween({ min: -config.composing.jitterMs, max: config.composing.jitterMs });
  return humanizedDelay(Math.min(config.composing.maxMs, Math.max(config.composing.minMs, Math.round(base + jitter))), config);
}

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function finishBubble(text: string): string {
  return text.trim().replace(/[,;:]\s*$/u, "");
}

function splitAtNaturalWordBoundary(text: string, maxWords: number): string[] {
  const remaining = text.trim().split(/\s+/).filter(Boolean);
  const parts: string[] = [];
  const weakEndings = new Set(["a", "as", "o", "os", "de", "da", "das", "do", "dos", "e", "ou", "com", "em", "na", "nas", "no", "nos", "para", "pra"]);
  const connectiveStarts = new Set(["além", "assim", "como", "então", "mas", "ou", "porque", "porém", "pra", "quando", "que", "se"]);

  while (remaining.length > maxWords) {
    const minimumCut = Math.max(1, Math.floor(maxWords * 0.6));
    let cut = maxWords;

    for (let index = maxWords - 1; index >= minimumCut; index -= 1) {
      const normalized = remaining[index].normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^\W+|\W+$/g, "").toLowerCase();
      if (connectiveStarts.has(normalized)) {
        cut = index;
        break;
      }
    }

    while (cut > minimumCut) {
      const ending = remaining[cut - 1].normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/^\W+|\W+$/g, "").toLowerCase();
      if (!weakEndings.has(ending)) break;
      cut -= 1;
    }

    parts.push(finishBubble(remaining.splice(0, cut).join(" ")));
  }
  if (remaining.length) parts.push(finishBubble(remaining.join(" ")));
  return parts.filter(Boolean);
}

// A comma between digits is a decimal/thousands separator (e.g. "R$ 7.900,00"),
// not a clause boundary; protect it with a sentinel so clause splitting never
// cuts a number in half, then restore it once clauses are resolved.
const DECIMAL_COMMA_SENTINEL = "\u0000";
function protectDecimalCommas(text: string): string {
  return text.replace(/(\d),(\d)/g, `$1${DECIMAL_COMMA_SENTINEL}$2`);
}
function restoreDecimalCommas(text: string): string {
  return text.split(DECIMAL_COMMA_SENTINEL).join(",");
}

function splitLongSentence(sentence: string, maxWords: number): string[] {
  const clauses = protectDecimalCommas(sentence).match(/[^,;:]+(?:[,;:]|$)/gu)
    ?.map((part) => restoreDecimalCommas(part).trim()).filter(Boolean) ?? [sentence];
  if (clauses.length === 1) return splitAtNaturalWordBoundary(sentence, maxWords);

  const parts: string[] = [];
  let current = "";
  for (const clause of clauses) {
    if (wordCount(clause) > maxWords) {
      if (current) parts.push(finishBubble(current));
      parts.push(...splitAtNaturalWordBoundary(clause, maxWords));
      current = "";
      continue;
    }
    const candidate = `${current} ${clause}`.trim();
    if (current && wordCount(candidate) > maxWords) {
      parts.push(finishBubble(current));
      current = clause;
    } else {
      current = candidate;
    }
  }
  if (current) parts.push(finishBubble(current));
  return parts.filter(Boolean);
}

export function splitResponse(text: string, maxWords: number): string[] {
  const bubbles: string[] = [];
  for (const paragraph of text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)) {
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    let current = "";
    for (const sentence of sentences) {
      const sentenceParts = wordCount(sentence) > maxWords ? splitLongSentence(sentence, maxWords) : [sentence];
      for (const part of sentenceParts) {
        const candidate = `${current} ${part}`.trim();
        if (current && wordCount(candidate) > maxWords) {
          bubbles.push(finishBubble(current));
          current = part;
        } else {
          current = candidate;
        }
      }
    }
    if (current) bubbles.push(finishBubble(current));
  }
  return bubbles.filter(Boolean);
}

function replaceDashesOutsideUrls(text: string): string {
  return text.split(/(https?:\/\/[^\s]+)/giu).map((part, index) => {
    if (index % 2 === 1) return part;
    return part
      // A list marker becomes a real bubble boundary instead of looking like
      // generated Markdown or being glued to the preceding sentence.
      .replace(/(^|\n)[\t ]*-[\t ]+/g, "$1\n")
      .replace(/[\t ]+-[\t ]+/g, "\n\n")
      .replace(/\s*[–—]\s*/gu, ", ")
      // The customer-facing copy must never contain an ASCII hyphen. Compound
      // words are kept readable with a space; URL segments were protected above.
      .replace(/-/g, " ");
  }).join("");
}

// Removes tool/log envelopes and fenced JSON while preserving ordinary prose.
export function sanitizeOutbound(text: string, emptyFallback = "Desculpe, não consegui concluir essa resposta. Pode tentar novamente?"): string {
  let value = text
    // WhatsApp doesn't render Markdown links; flatten [label](url) to the raw URL.
    .replace(/\[[^\]\r\n]*\]\((https?:\/\/[^\s)]+)\)/g, "$1")
    .replace(/<tool(?:_call)?\b[^>]*>[\s\S]*?<\/tool(?:_call)?>/gi, "")
    .replace(/<function(?:_call)?\b[^>]*>[\s\S]*?<\/function(?:_call)?>/gi, "")
    // Bracket-style pseudo tool-call markers a model may narrate, e.g. "[verificar_horarios]".
    // Case-sensitive lowercase requirement keeps the [[HANDOFF]] marker (uppercase) untouched.
    .replace(/\[[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?:\([^\]\r\n]*\))?\]\s?/g, "")
    .replace(/```json[\s\S]*$/i, "")
    .replace(/```(?:json)?\s*[\[{][\s\S]*?[\]}]\s*```/gi, "")
    .replace(/^\s*(?:tool|function|internal|debug|log)(?:_call|_result)?\s*:\s*.*$/gim, "")
    .replace(/^\s*\{\s*"(?:lead|tool|function|arguments|name|payload)"[\s\S]*\}\s*$/i, "")
    // Commands can arrive inside Markdown code spans and may contain nested objects.
    // Remove from the command onward, preserving useful prose before an inline call.
    .replace(/(?:^|\s)`*\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*\([^\r\n]*$/gimu, "")
    .replace(/`+\s*`+/g, "")
    .trim();
  value = replaceDashesOutsideUrls(value)
    .replace(/[\t ]{2,}/g, " ")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n[\t ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return value || emptyFallback;
}

export function selectContextualReaction(text: string, allowed: string[]): string | undefined {
  const normalized = text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const choose = (...preferred: string[]) => preferred.find((emoji) => allowed.includes(emoji));
  if (/\b(obrigad[oa]?|valeu|agradeco|gratidao)\b/.test(normalized)) return choose("❤️", "😊", "👍");
  if (/\b(ok|okay|sim|pode|manda|envia|certo|beleza|combinado|fechado)\b/.test(normalized)) return choose("👍", "😊");
  if (/\b(otimo|perfeito|adorei|gostei|maravilha|excelente|legal)\b/.test(normalized)) return choose("😊", "❤️", "👍");
  return undefined;
}

// In-memory rate limiter (for tests and fallback)
const rateWindows = new Map<string, { count: number; startedAt: number }>();

export function consumeRateLimit(key: string, maximum: number, now = Date.now()): boolean {
  const current = rateWindows.get(key);
  if (!current || now - current.startedAt >= 60_000) {
    rateWindows.set(key, { count: 1, startedAt: now });
    return true;
  }
  if (current.count >= maximum) return false;
  current.count += 1;
  return true;
}

// Redis-backed rate limiter for multi-worker environments
export async function consumeRateLimitRedis(key: string, maximum: number, windowMs = 60_000): Promise<boolean> {
  const { consumeRateLimitRedis } = await import("./rate-limiter.js");
  return consumeRateLimitRedis(key, maximum, windowMs);
}

// Redis-backed per-conversation lock (see conversation-lock.ts for why this exists).
export async function acquireConversationLock(
  key: string,
  options?: { ttlMs?: number; waitMs?: number; pollIntervalMs?: number }
): Promise<import("./conversation-lock.js").ConversationLock | null> {
  const { acquireConversationLock } = await import("./conversation-lock.js");
  return acquireConversationLock(key, options);
}

export async function extendConversationLock(lock: import("./conversation-lock.js").ConversationLock, ttlMs?: number): Promise<boolean> {
  const { extendConversationLock } = await import("./conversation-lock.js");
  return extendConversationLock(lock, ttlMs);
}

export async function releaseConversationLock(lock: import("./conversation-lock.js").ConversationLock): Promise<void> {
  const { releaseConversationLock } = await import("./conversation-lock.js");
  return releaseConversationLock(lock);
}

export async function isConversationLocked(key: string): Promise<boolean> {
  const { isConversationLocked } = await import("./conversation-lock.js");
  return isConversationLocked(key);
}

export async function withComposingRefresh<T>(intervalMs: number, refresh: () => Promise<void>, operation: () => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  if (intervalMs > 0) timer = setInterval(() => void refresh(), intervalMs);
  try { return await operation(); }
  finally { if (timer) clearInterval(timer); }
}

interface PendingDebounce {
  texts: string[];
  timer: NodeJS.Timeout;
  waiters: Array<(result: { text: string; process: boolean }) => void>;
  maximumDeadline: number;
}
const pendingDebounces = new Map<string, PendingDebounce>();

export function debounceInbound(
  key: string,
  text: string,
  config: { initialWindowMs: number; silenceWindowMs: number; extensionMs: number }
): Promise<{ text: string; process: boolean }> {
  return new Promise((resolve) => {
    const current = pendingDebounces.get(key);
    if (current) {
      clearTimeout(current.timer);
      current.texts.push(text);
      current.waiters.push(resolve);
      const now = Date.now();
      const remaining = Math.max(0, Math.min(now + config.silenceWindowMs, current.maximumDeadline) - now);
      current.timer = setTimeout(() => flushDebounce(key), remaining);
      return;
    }
    pendingDebounces.set(key, {
      texts: [text],
      waiters: [resolve],
      maximumDeadline: Date.now() + config.initialWindowMs + config.extensionMs,
      timer: setTimeout(() => flushDebounce(key), config.initialWindowMs)
    });
  });
}

function flushDebounce(key: string): void {
  const pending = pendingDebounces.get(key);
  if (!pending) return;
  pendingDebounces.delete(key);
  const combined = pending.texts.join("\n");
  pending.waiters.forEach((resolve, index) => resolve({ text: combined, process: index === pending.waiters.length - 1 }));
}
