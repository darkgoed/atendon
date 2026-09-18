"use client";

import { useEffect, useState } from "react";
import {
  ACCENT_PRESETS,
  DENSITY_PRESETS,
  applyAppearanceToDocument,
  persistAppearancePreferences,
  writeStoredAppearance,
  type AppearanceDensity
} from "@/lib/appearance";
import { applyThemeWithTransition, currentTheme, elementOrigin, type PanelTheme } from "@/lib/theme-transition";
import styles from "@/components/appearance-preferences.module.css";

/**
 * R16 — Preferências individuais (tema/densidade/accent) na página Perfil.
 * - Tema: integra com o ThemeToggle — a troca usa a MESMA onda
 *   (lib/theme-transition) e o ícone da topbar/sidebar acompanha por
 *   MutationObserver (o estado segue data-theme, não o clique).
 * - Densidade/accent: data-density / data-accent no <html> + tokens.css.
 * - Persistência: localStorage imediato (boot script aplica antes da pintura)
 *   + PATCH /me/appearance-preferences em silêncio (a API pode 404 até o
 *   backend integrar; sem toast de erro).
 */

type Origin = Parameters<typeof elementOrigin>[0];

export function AppearancePreferences() {
  const [theme, setTheme] = useState<PanelTheme>("dark");
  const [accent, setAccent] = useState<string | null>(null);
  const [density, setDensity] = useState<AppearanceDensity | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    setTheme(currentTheme());
    setAccent(root.getAttribute("data-accent"));
    setDensity(root.getAttribute("data-density") === "compact" ? "compact" : null);
    if (typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const changeTheme = (next: PanelTheme, origin: Origin) => {
    // O tema em runtime é do ThemeToggle: mesma onda, mesmo localStorage.
    if (currentTheme() !== next) applyThemeWithTransition(next, elementOrigin(origin));
    void persistAppearancePreferences({ theme: next });
  };

  const changeDensity = (next: AppearanceDensity) => {
    setDensity(next);
    applyAppearanceToDocument(document.documentElement, { density: next });
    writeStoredAppearance(localStorage, { density: next });
    void persistAppearancePreferences({ density: next });
  };

  const changeAccent = (next: string) => {
    setAccent(next);
    applyAppearanceToDocument(document.documentElement, { accent: next });
    writeStoredAppearance(localStorage, { accent: next });
    void persistAppearancePreferences({ accent: next });
  };

  return (
    <section className={styles.group} aria-label="Preferências de aparência">
      <div className={styles.optionGroup}>
        <span className={styles.optionLabel} id="appearance-theme-label">Tema</span>
        <div className={styles.options} role="group" aria-labelledby="appearance-theme-label">
          {([["light", "Claro"], ["dark", "Escuro"]] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`${styles.option}${theme === value ? ` ${styles.optionActive}` : ""}`}
              aria-pressed={theme === value}
              onClick={(event) => changeTheme(value, event.currentTarget)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.optionGroup}>
        <span className={styles.optionLabel} id="appearance-density-label">Densidade</span>
        <div className={styles.options} role="group" aria-labelledby="appearance-density-label">
          {DENSITY_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={`${styles.option}${density === preset.key ? ` ${styles.optionActive}` : ""}`}
              aria-pressed={density === preset.key}
              onClick={() => changeDensity(preset.key)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.optionGroup}>
        <span className={styles.optionLabel} id="appearance-accent-label">Cor de destaque</span>
        <div className={styles.options} role="group" aria-labelledby="appearance-accent-label">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              className={`${styles.option}${accent === preset.key ? ` ${styles.optionActive}` : ""}`}
              aria-pressed={accent === preset.key}
              title={preset.label}
              onClick={() => changeAccent(preset.key)}
            >
              <span className={styles.swatch} style={{ background: preset.swatch }} aria-hidden="true" />
              {preset.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}