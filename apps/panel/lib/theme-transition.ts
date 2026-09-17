"use client";

/**
 * Troca de tema com transição visual.
 *
 * O CSS do produto reage a `data-theme` no `<html>`. Trocar o atributo direto
 * repinta a tela inteira em um único frame — é funcional, mas é o momento mais
 * violento do painel: fundo, texto, bordas e gráficos invertem de uma vez.
 *
 * Aqui a troca vira uma onda: um disco com a cor do PRÓXIMO tema cresce a
 * partir do botão clicado até cobrir a viewport; o atributo só muda quando a
 * tela já está coberta (ninguém vê o repaint); depois o véu desaparece e o novo
 * tema aparece por baixo, já pintado.
 *
 * Decisões:
 * - DOM imperativo, não um portal React: a animação não pode depender de
 *   re-render, precisa funcionar a partir de qualquer botão (topbar mobile e
 *   card de conta) e sobrevive a troca de rota.
 * - Os timers são a fonte da verdade (não `animationend`): navegador com
 *   animação desligada, aba em background ou `animation` não suportada ainda
 *   assim comita o tema e limpa o overlay.
 * - Sem `clip-path` (Safari antigo): degrada para crossfade, nunca para nada.
 * - `prefers-reduced-motion`: comita na hora, sem overlay.
 */

export type PanelTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "atendon-theme";
/** Duração do avanço da onda; espelhada em --theme-fx-sweep (shell.css). */
export const THEME_SWEEP_MS = 460;
/** Duração do desaparecimento do véu; espelhada em --theme-fx-settle. */
export const THEME_SETTLE_MS = 300;

type Origin = { x: number; y: number };

type RunningTransition = {
  node: HTMLElement;
  theme: PanelTheme;
  committed: boolean;
  onCommit?: (theme: PanelTheme) => void;
  timers: number[];
};

let running: RunningTransition | null = null;

export function currentTheme(): PanelTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function persistTheme(theme: PanelTheme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Sem storage (modo privado antigo), sem persistência — a troca vale na sessão.
  }
}

function commitTheme(transition: RunningTransition) {
  if (transition.committed) return;
  transition.committed = true;
  document.documentElement.dataset.theme = transition.theme;
  persistTheme(transition.theme);
  transition.onCommit?.(transition.theme);
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** `clip-path: circle()` cobre Safari 13.1+/Chrome 55+; o prefixo cobre Safari 9–13. */
function supportsCircleClip(): boolean {
  const css = typeof window === "undefined" ? undefined : window.CSS;
  if (!css || typeof css.supports !== "function") return false;
  try {
    return css.supports("clip-path", "circle(10px at 0px 0px)")
      || css.supports("-webkit-clip-path", "circle(10px at 0px 0px)");
  } catch {
    return false;
  }
}

/** Raio que cobre a viewport inteira a partir da origem: o canto mais distante. */
function coverRadius(origin: Origin, width: number, height: number) {
  return Math.max(
    Math.sqrt(origin.x ** 2 + origin.y ** 2),
    Math.sqrt((width - origin.x) ** 2 + origin.y ** 2),
    Math.sqrt(origin.x ** 2 + (height - origin.y) ** 2),
    Math.sqrt((width - origin.x) ** 2 + (height - origin.y) ** 2)
  );
}

function layer(className: string) {
  const node = document.createElement("span");
  node.className = className;
  return node;
}

/**
 * Encerra a transição em andamento imediatamente: comita o tema pendente (a
 * troca nunca se perde por um segundo clique) e remove o overlay.
 */
export function finishThemeTransition() {
  const transition = running;
  if (!transition) return;
  running = null;
  transition.timers.forEach((timer) => clearTimeout(timer));
  commitTheme(transition);
  const parent = transition.node.parentNode;
  if (parent) parent.removeChild(transition.node);
}

export function applyThemeWithTransition(
  theme: PanelTheme,
  origin?: Origin | null,
  onCommit?: (theme: PanelTheme) => void
) {
  if (typeof document === "undefined") return;
  finishThemeTransition();

  const width = window.innerWidth || document.documentElement.clientWidth || 0;
  const height = window.innerHeight || document.documentElement.clientHeight || 0;
  if (prefersReducedMotion() || width === 0 || height === 0) {
    const immediate: RunningTransition = { node: document.createElement("div"), theme, committed: false, onCommit, timers: [] };
    commitTheme(immediate);
    return;
  }

  const point: Origin = {
    x: origin ? Math.min(Math.max(origin.x, 0), width) : width / 2,
    y: origin ? Math.min(Math.max(origin.y, 0), height) : height / 2
  };
  const radius = Math.ceil(coverRadius(point, width, height));

  const node = document.createElement("div");
  node.className = supportsCircleClip() ? "theme-fx" : "theme-fx theme-fx--fade";
  node.setAttribute("data-theme-fx", theme);
  node.setAttribute("aria-hidden", "true");
  node.style.setProperty("--theme-fx-x", `${Math.round(point.x)}px`);
  node.style.setProperty("--theme-fx-y", `${Math.round(point.y)}px`);
  node.style.setProperty("--theme-fx-r", `${radius}px`);
  node.appendChild(layer("theme-fx__veil"));
  node.appendChild(layer("theme-fx__ring"));
  node.appendChild(layer("theme-fx__core"));
  document.body.appendChild(node);

  const transition: RunningTransition = { node, theme, committed: false, onCommit, timers: [] };
  running = transition;
  transition.timers.push(
    window.setTimeout(() => {
      commitTheme(transition);
      // A tela já está coberta pelo véu: o repaint do tema acontece invisível.
      node.className += " theme-fx--settle";
    }, THEME_SWEEP_MS),
    window.setTimeout(finishThemeTransition, THEME_SWEEP_MS + THEME_SETTLE_MS)
  );
}

/** Alterna o tema a partir de um ponto da viewport e devolve o tema escolhido. */
export function toggleThemeWithTransition(
  origin?: Origin | null,
  onCommit?: (theme: PanelTheme) => void
): PanelTheme {
  const next: PanelTheme = currentTheme() === "dark" ? "light" : "dark";
  applyThemeWithTransition(next, origin, onCommit);
  return next;
}

/** Centro do elemento acionador — origem natural da onda. */
export function elementOrigin(element: Element | null | undefined): Origin | null {
  if (!element || typeof element.getBoundingClientRect !== "function") return null;
  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height && !rect.left && !rect.top) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
