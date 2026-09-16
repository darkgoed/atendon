"use client";

import { useEffect, useState } from "react";

/**
 * Cores resolvidas do design system para consumo por bibliotecas que não
 * entendem `var(--token)` (ECharts recebe strings de cor literais). Os
 * tokens em styles/tokens.css são valores literais por tema — basta ler
 * `getPropertyValue` no elemento raiz, sem precisar resolver a cascata.
 */
export type ChartTokens = {
  text: string;
  textSecondary: string;
  textMuted: string;
  textSubtle: string;
  border: string;
  borderSubtle: string;
  surface: string;
  surfaceElevated: string;
  surfaceHover: string;
  primary: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  cat: string[];
  fontSans: string;
  fontMono: string;
};

function readTokens(): ChartTokens {
  if (typeof document === "undefined") {
    return {
      text: "#181B20",
      textSecondary: "#667085",
      textMuted: "#667085",
      textSubtle: "#7E8AA0",
      border: "#DDE2E7",
      borderSubtle: "#E8ECF0",
      surface: "#FFFFFF",
      surfaceElevated: "#FFFFFF",
      surfaceHover: "#ECEFF3",
      primary: "#2563EB",
      success: "#16875B",
      warning: "#B7791F",
      danger: "#D14343",
      info: "#2563EB",
      cat: ["#2563EB", "#16875B", "#7C4DCB", "#B7791F", "#0E7490"],
      fontSans: "Geist, ui-sans-serif, system-ui, sans-serif",
      fontMono: "ui-monospace, SFMono-Regular, monospace"
    };
  }
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    text: read("--text", "#181B20"),
    textSecondary: read("--text-secondary", "#667085"),
    textMuted: read("--text-muted", "#667085"),
    textSubtle: read("--text-subtle", "#7E8AA0"),
    border: read("--border", "#DDE2E7"),
    borderSubtle: read("--border-subtle", "#E8ECF0"),
    surface: read("--surface", "#FFFFFF"),
    surfaceElevated: read("--surface-elevated", "#FFFFFF"),
    surfaceHover: read("--surface-hover", "#ECEFF3"),
    primary: read("--primary", "#2563EB"),
    success: read("--success", "#16875B"),
    warning: read("--warning", "#B7791F"),
    danger: read("--danger", "#D14343"),
    info: read("--info", "#2563EB"),
    cat: [
      read("--cat-1", "#2563EB"),
      read("--cat-2", "#16875B"),
      read("--cat-3", "#7C4DCB"),
      read("--cat-4", "#B7791F"),
      read("--cat-5", "#0E7490")
    ],
    fontSans: read("--font-sans", "Geist, ui-sans-serif, system-ui, sans-serif"),
    fontMono: read("--font-mono", "ui-monospace, SFMono-Regular, monospace")
  };
}

/** Recalcula os tokens quando o tema (`data-theme` no `<html>`) muda. */
export function useChartTokens(): ChartTokens {
  const [tokens, setTokens] = useState<ChartTokens>(readTokens);

  useEffect(() => {
    setTokens(readTokens());
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTokens(readTokens()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return tokens;
}
