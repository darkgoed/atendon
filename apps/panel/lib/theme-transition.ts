"use client";

/**
 * Troca de tema com transição visual — wipe diagonal (View Transition API).
 *
 * O CSS do produto reage a `data-theme` no `<html>`. Trocar o atributo direto
 * repinta a tela inteira em um único frame. Aqui a troca acontece dentro de
 * `document.startViewTransition`: o navegador congela um snapshot da página no
 * tema ANTIGO, o atributo muda, e o snapshot do tema NOVO é revelado por cima
 * com um `clip-path` diagonal que atravessa a viewport (theme-fx.css). Mesmo
 * efeito do modo "Wipe" do showcase de View Transitions do Jhey Tompkins:
 * - para o escuro a faixa entra do canto superior esquerdo; para o claro, do
 *   canto inferior direito — direções opostas;
 * - o snapshot antigo fica estático por baixo (sem crossfade).
 *
 * Decisões:
 * - A página INTEIRA é um snapshot só (`root`): sidebar, NavRail, modais,
 *   portals, toasts e qualquer `position: fixed` entram na mesma captura, então
 *   nada escapa por cima do wipe nem troca de cor antes/depois dele. Por isso
 *   nenhum elemento do painel pode declarar `view-transition-name`.
 * - `data-theme-switching` desliga as `transition`s de cor enquanto o tema
 *   muda: sem isso cada componente animaria a própria cor no snapshot novo e o
 *   wipe revelaria partes "atrasadas".
 * - Sem `startViewTransition` (Firefox antigo, Safari < 18): troca direta.
 * - `prefers-reduced-motion`: troca direta, sem wipe.
 */

export type PanelTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "atendon-theme";
/** Duração do wipe; espelhada em --theme-wipe-duration (tokens.css). */
export const THEME_WIPE_MS = 800;

type ViewTransitionLike = {
  finished: Promise<void>;
  skipTransition?: () => void;
};

type StartViewTransition = (update: () => Promise<void> | void) => ViewTransitionLike;

type RunningTransition = {
  theme: PanelTheme;
  committed: boolean;
  onCommit?: (theme: PanelTheme) => void;
  view: ViewTransitionLike | null;
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

function viewTransitionApi(): StartViewTransition | null {
  const start = (document as Document & { startViewTransition?: StartViewTransition }).startViewTransition;
  return typeof start === "function" ? start.bind(document) : null;
}

function suspendTransitions() {
  document.documentElement.setAttribute("data-theme-switching", "");
}

function resumeTransitions() {
  document.documentElement.removeAttribute("data-theme-switching");
}

/** Um macrotask: deixa o React renderizar o que os MutationObservers de
 *  `data-theme` agendaram (ícone do toggle, cores do ECharts) ANTES do
 *  snapshot novo ser capturado — o wipe revela a tela já pronta. */
function settleRenders() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Encerra a transição em andamento imediatamente: comita o tema pendente (a
 * troca nunca se perde) e pula o wipe.
 */
export function finishThemeTransition() {
  const transition = running;
  if (!transition) return;
  running = null;
  commitTheme(transition);
  try {
    transition.view?.skipTransition?.();
  } catch {
    // Transição já encerrada pelo navegador.
  }
  resumeTransitions();
}

export function applyThemeWithTransition(theme: PanelTheme, onCommit?: (theme: PanelTheme) => void) {
  if (typeof document === "undefined") return;
  finishThemeTransition();

  const transition: RunningTransition = { theme, committed: false, onCommit, view: null };
  const start = viewTransitionApi();

  if (!start || prefersReducedMotion()) {
    // Troca direta. As transitions de cor ficam suspensas por um frame para o
    // tema virar de uma vez, e não componente por componente.
    suspendTransitions();
    commitTheme(transition);
    void window.getComputedStyle(document.documentElement).color;
    const resume = typeof requestAnimationFrame === "function" ? requestAnimationFrame : (fn: () => void) => setTimeout(fn, 0);
    resume(() => { if (!running) resumeTransitions(); });
    return;
  }

  running = transition;
  suspendTransitions();
  try {
    transition.view = start(async () => {
      commitTheme(transition);
      await settleRenders();
    });
  } catch {
    // Documento oculto ou API bloqueada: nunca perde a troca.
    running = null;
    commitTheme(transition);
    resumeTransitions();
    return;
  }
  const cleanup = () => {
    if (running !== transition) return;
    running = null;
    commitTheme(transition);
    resumeTransitions();
  };
  transition.view.finished.then(cleanup, cleanup);
}

/** Alterna o tema e devolve o tema escolhido. */
export function toggleThemeWithTransition(onCommit?: (theme: PanelTheme) => void): PanelTheme {
  const next: PanelTheme = currentTheme() === "dark" ? "light" : "dark";
  applyThemeWithTransition(next, onCommit);
  return next;
}
