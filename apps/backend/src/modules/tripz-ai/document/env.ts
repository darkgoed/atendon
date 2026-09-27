/** Feature flags locais do pipeline editorial (sem dependência externa). */

export function TRIPZ_PDF_DISABLE_CHROMIUM(environment: NodeJS.ProcessEnv): boolean {
  return environment.TRIPZ_PDF_DISABLE_CHROMIUM === "1" || environment.TRIPZ_PDF_DISABLE_CHROMIUM === "true";
}

export function APP_PANEL_URL(environment: NodeJS.ProcessEnv): string | undefined {
  const value = environment.APP_PANEL_URL?.trim() || environment.PANEL_URL?.trim() || undefined;
  return value ? value.replace(/\/$/, "") : undefined;
}
