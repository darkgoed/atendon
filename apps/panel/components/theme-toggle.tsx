"use client";

import { Moon, Sun } from "@/components/icons";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  currentTheme,
  elementOrigin,
  finishThemeTransition,
  THEME_SWEEP_MS,
  toggleThemeWithTransition,
  type PanelTheme
} from "@/lib/theme-transition";

/**
 * Botão único de troca de tema — usado na topbar mobile e no card de conta da
 * sidebar, para que a animação, o rótulo e o estado do ícone existam em UM
 * lugar só (antes o markup estava duplicado em dois pontos do Shell).
 *
 * Quem manda no tema é o atributo `data-theme` no `<html>`, setado antes da
 * hidratação pelo boot script do layout. O ícone é derivado dele por
 * MutationObserver (mesmo padrão de lib/use-chart-tokens.ts) e não pelo clique:
 * as duas instâncias coexistem no DOM, então clicar em uma precisa virar o
 * ícone da outra também — e o commit acontece no meio da onda, não no clique.
 */
export function ThemeToggle({
  className = "",
  iconSize = 20,
  iconWeight = "regular"
}: {
  className?: string;
  iconSize?: number;
  iconWeight?: "thin" | "light" | "regular" | "bold" | "fill" | "duotone";
}) {
  const [theme, setTheme] = useState<PanelTheme>("dark");
  const [swapping, setSwapping] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | null>(null);
  // Dois toggles coexistem: só quem começou a onda pode encerrá-la no unmount,
  // senão um desmonte aborta a animação disparada pelo outro no meio.
  const ownsTransition = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    setTheme(currentTheme());
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  // Desmontar no meio da onda (troca de rota) não pode deixar o overlay preso
  // na tela nem perder o tema já escolhido.
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    if (ownsTransition.current) finishThemeTransition();
  }, []);

  const toggle = useCallback(() => {
    ownsTransition.current = true;
    toggleThemeWithTransition(elementOrigin(buttonRef.current));
    setSwapping(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      ownsTransition.current = false;
      setSwapping(false);
    }, THEME_SWEEP_MS);
  }, []);

  const label = theme === "dark" ? "Tema claro" : "Tema escuro";
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={toggle}
      className={`theme-toggle${className ? ` ${className}` : ""}`}
      data-swapping={swapping ? "true" : "false"}
      aria-label="Alternar tema"
      title={label}
    >
      <span className="theme-toggle__icon" aria-hidden="true">
        {theme === "dark"
          ? <Sun size={iconSize} weight={iconWeight} />
          : <Moon size={iconSize} weight={iconWeight} />}
      </span>
    </button>
  );
}
