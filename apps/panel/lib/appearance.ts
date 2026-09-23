/**
 * R16 — Preferências individuais de aparência (tema/densidade/accent).
 * Contrato (specs/active/v6-evolucao-estrutural-atendon.md — Contratos de API):
 *   GET/PATCH /me/appearance-preferences →
 *   { theme: 'light'|'dark'|null, accent: string|null, density: 'comfortable'|'compact'|null }
 *
 * O tema do RUNTIME continua pertencendo ao ThemeToggle/lib/theme-transition
 * (localStorage "atendon-theme" + data-theme no <html>). Aqui o tema só entra
 * como fallback de primeiro dispositivo e é persistido junto na API.
 * A API pode 404 até o backend integrar: toda falha é silenciosa e o
 * localStorage é a fonte imediata (boot script do layout aplica antes da pintura).
 */

import { api } from "@/lib/api";

export type AppearanceTheme = "light" | "dark";
export type AppearanceDensity = "comfortable" | "compact";

export type AppearancePreferences = {
  theme: AppearanceTheme | null;
  accent: string | null;
  density: AppearanceDensity | null;
};

export type AppearancePreferencesPayload = {
  theme?: AppearanceTheme | null;
  accent?: string | null;
  density?: AppearanceDensity | null;
};

export const APPEARANCE_STORAGE_KEY = "atendon-appearance";
export const THEME_STORAGE_KEY = "atendon-theme";

// DS v2: ciano é o acento padrão da marca (tokens.css, sem bloco data-accent).
// "blue"/"violet" da v1 saíram — valores salvos antigos normalizam para null
// e caem no padrão ciano.
export const ACCENT_PRESETS: readonly { key: string; label: string; swatch: string }[] = [
  { key: "cyan", label: "Ciano", swatch: "#22D3EE" },
  { key: "green", label: "Verde", swatch: "#16875B" }
];

export const DENSITY_PRESETS: readonly { key: AppearanceDensity; label: string }[] = [
  { key: "comfortable", label: "Confortável" },
  { key: "compact", label: "Compacta" }
];

const ACCENT_KEYS = new Set(ACCENT_PRESETS.map((preset) => preset.key));
const DENSITY_KEYS = new Set<string>(DENSITY_PRESETS.map((preset) => preset.key));
const THEME_KEYS = new Set<string>(["light", "dark"]);

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function normalizeAccent(accent: string | null | undefined): string | null {
  if (typeof accent !== "string") return null;
  const key = accent.trim();
  return ACCENT_KEYS.has(key) ? key : null;
}

export function normalizeDensity(density: string | null | undefined): AppearanceDensity | null {
  if (typeof density !== "string") return null;
  const key = density.trim();
  return DENSITY_KEYS.has(key) ? (key as AppearanceDensity) : null;
}

/** localStorage é tolerante a lixo: JSON inválido/valores desconhecidos = pref ausente. */
export function readStoredAppearance(storage: StorageLike | null): AppearancePreferences {
  if (!storage) return { theme: null, accent: null, density: null };
  try {
    const raw = JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    if (!raw || typeof raw !== "object") return { theme: null, accent: null, density: null };
    const theme = typeof raw.theme === "string" && THEME_KEYS.has(raw.theme) ? (raw.theme as AppearanceTheme) : null;
    const density = normalizeDensity(typeof raw.density === "string" ? raw.density : null);
    return { theme, accent: normalizeAccent(typeof raw.accent === "string" ? raw.accent : null), density };
  } catch {
    return { theme: null, accent: null, density: null };
  }
}

export function writeStoredAppearance(storage: StorageLike | null, patch: AppearancePreferencesPayload): void {
  if (!storage) return;
  try {
    const current = readStoredAppearance(storage);
    const next: AppearancePreferences = {
      theme: patch.theme !== undefined ? patch.theme : current.theme,
      accent: patch.accent !== undefined ? normalizeAccent(patch.accent) : current.accent,
      density: patch.density !== undefined ? patch.density : current.density
    };
    if (!next.theme && !next.accent && !next.density) storage.removeItem(APPEARANCE_STORAGE_KEY);
    else storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Sem storage (modo privado antigo): a preferência vale só na sessão.
  }
}

/** Aplica data-accent/data-density no <html>; null/remove volta ao padrão. */
export function applyAppearanceToDocument(root: HTMLElement | null, prefs: AppearancePreferencesPayload): void {
  if (!root || typeof root.setAttribute !== "function") return;
  const accent = normalizeAccent(prefs.accent);
  if (accent) root.setAttribute("data-accent", accent);
  else root.removeAttribute("data-accent");
  if (prefs.density === "compact") root.setAttribute("data-density", "compact");
  else root.removeAttribute("data-density");
}

export async function fetchAppearancePreferences(): Promise<AppearancePreferences | null> {
  try {
    const response = await api<AppearancePreferences>("/me/appearance-preferences", undefined, { reportErrors: false });
    if (!response || typeof response !== "object") return null;
    return {
      theme: typeof response.theme === "string" && THEME_KEYS.has(response.theme) ? (response.theme as AppearanceTheme) : null,
      accent: normalizeAccent(response.accent),
      density: normalizeDensity(response.density)
    };
  } catch {
    // Backend pode ainda não ter a rota (404) ou sessão sem auth: fallback silencioso.
    return null;
  }
}

export async function persistAppearancePreferences(patch: AppearancePreferencesPayload): Promise<AppearancePreferences | null> {
  try {
    return await api<AppearancePreferences>("/me/appearance-preferences", {
      method: "PATCH",
      body: JSON.stringify(patch)
    }, { reportErrors: false });
  } catch {
    // Sem backend integrado: a cópia em localStorage já foi aplicada; silêncio.
    return null;
  }
}

/**
 * Hidratação aditiva chamada no layout raiz: aplica o localStorage primeiro
 * (cobre o caso do boot script não ter rodado/em navegadores sem storage),
 * depois consulta a API como fonte de verdade e re-aplica se divergir.
 * Tema: só assume o do servidor quando não há preferência local (o dono do
 * tema em runtime é o ThemeToggle).
 */
export async function hydrateAppearance(options: { storage?: StorageLike | null } = {}): Promise<void> {
  const storage = options.storage !== undefined ? options.storage : typeof localStorage !== "undefined" ? localStorage : null;
  const stored = readStoredAppearance(storage);
  applyAppearanceToDocument(typeof document !== "undefined" ? document.documentElement : null, stored);
  const remote = await fetchAppearancePreferences();
  if (!remote) return;
  applyAppearanceToDocument(typeof document !== "undefined" ? document.documentElement : null, remote);
  if (storage) {
    // Fonte de verdade remota por campo: valor salvo no servidor vence, null
    // (campo ainda não salvo) preserva a escolha local deste dispositivo.
    const merged: AppearancePreferences = {
      theme: stored.theme ?? (storage.getItem(THEME_STORAGE_KEY) ? null : remote.theme),
      accent: remote.accent ?? stored.accent,
      density: remote.density ?? stored.density
    };
    if (!merged.theme && !merged.accent && !merged.density) {
      try { storage.removeItem(APPEARANCE_STORAGE_KEY); } catch { /* sem storage */ }
    } else {
      try { storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(merged)); } catch { /* sem storage */ }
    }
  }
}