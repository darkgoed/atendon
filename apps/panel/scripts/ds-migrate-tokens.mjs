#!/usr/bin/env node
/**
 * Sweep determinístico de tokens legados → camada semântica.
 *
 *   node scripts/ds-migrate-tokens.mjs [--dry]
 *
 * Por que existe: quando agentes (ou pessoas) reportam "zero tokens legados",
 * costumam estar errados. Esta varredura é ordenada (chave mais longa primeiro,
 * `--warn-border` antes de `--warn`) e ciente de propriedade: cor de status como
 * TEXTO vira `--{status}-text`, como fill/borda vira `--{status}`.
 *
 * Não toca styles/tokens.css (onde os aliases são definidos) nem node_modules.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const DRY = process.argv.includes("--dry");
const SKIP_DIRS = new Set(["node_modules", ".next", "graphify-out", "test-results", "public", ".git", "tests", "e2e"]);
const SKIP_FILES = new Set(["styles/tokens.css"]);

/* Mapa base: legado → semântico. Status ficam de fora (ver STATUS abaixo). */
const MAP = {
  // superfícies
  "--app": "--bg",
  "--surface-2": "--surface-sunken",
  "--surface-3": "--surface-elevated",
  "--panel-secondary": "--surface-sunken",
  "--panel-raised": "--surface-elevated",
  "--panel": "--surface",
  "--side": "--sidebar",
  "--topbar": "--surface",
  "--sticky": "--surface",
  "--scroll-surface": "--bg",
  "--hover": "--surface-hover",
  "--active": "--surface-active",
  "--bubble-ai": "--primary-subtle",
  "--bubble": "--surface-elevated",
  "--ai-bg": "--primary-subtle",
  "--input": "--surface",
  "--dialog": "--surface-elevated",
  "--tooltip": "--surface-elevated",
  "--toast": "--surface-elevated",
  "--disabled-bg": "--surface-sunken",
  // bordas
  "--border-2": "--border-subtle",
  "--border-3": "--border",
  "--border-hover": "--border-strong",
  "--border-ai": "--primary-border",
  "--strong": "--border-strong",
  "--divider-dash-hover": "--border",
  "--divider-dash": "--border-subtle",
  // texto — a escala de 9 cinzas colapsa em 3 papéis reais
  "--heading": "--text",
  "--body": "--text-secondary",
  "--muted": "--text-secondary",
  "--faint-text": "--text-muted",
  "--faint": "--text-muted",
  "--text-2": "--text",
  "--text-3": "--text-secondary",
  "--text-4": "--text-secondary",
  "--text-5": "--text-secondary",
  "--text-6": "--text-muted",
  "--text-7": "--text-muted",
  "--text-8": "--text-muted",
  "--text-9": "--text-muted",
  // marca
  "--primary-fg": "--primary-foreground",
  "--primary-accent": "--primary",
  "--primary-tint-bg": "--primary-subtle",
  "--primary-tint-border": "--primary-border",
  "--accent-bg-strong": "--primary-subtle-hover",
  "--accent-bg": "--primary-subtle",
  "--accent-surface": "--primary-subtle",
  "--accent-dim": "--primary-subtle",
  "--accent-strong": "--primary-active",
  "--accent-fg": "--primary-foreground",
  "--accent-soft": "--primary-text",
  "--accent": "--primary",
  // status: variantes de fundo/borda não são ambíguas
  "--ok-bg": "--success-subtle",
  "--ok-border": "--success-border",
  "--warn-bg": "--warning-subtle",
  "--warn-border": "--warning-border",
  "--warn-muted": "--warning-text",
  "--danger-bg": "--danger-subtle",
  "--info-bg": "--info-subtle",
  // categóricas
  "--cat-demo-bg": "--cat-1-subtle",
  "--cat-demo-border": "--cat-1-border",
  "--cat-demo": "--cat-1-text",
  "--cat-follow-bg": "--cat-2-subtle",
  "--cat-follow-border": "--cat-2-border",
  "--cat-follow": "--cat-2-text",
  "--cat-referral-bg": "--cat-3-subtle",
  "--cat-referral-border": "--cat-3-border",
  "--cat-referral": "--cat-3-text",
  "--today-head-bg": "--primary-subtle-hover",
  "--today-body-bg": "--primary-subtle",
  "--appointment-color": "--primary",
  // tipografia
  "--font-size-body-lg": "--text-body-lg",
  "--font-size-body": "--text-body",
  "--font-size-caption": "--text-meta",
  "--font-size-label": "--text-label",
  "--font-size-control": "--text-control",
  "--font-size-title": "--text-page-title",
  "--font-caption": "--text-meta",
  "--text-xs": "--text-meta",
  "--text-md": "--text-body",
  "--text-2xl": "--text-metric",
  // foco
  "--ring": "--focus-ring"
};

/**
 * Tokens de status cuja resolução depende do papel: como `color` precisam da
 * variante AA (`-text`); como fill/borda/indicador usam o valor puro.
 */
const STATUS = { "--ok": "success", "--warn": "warning", "--overdue": "warning", "--urgent": "danger" };

/* Propriedades CSS que pintam TEXTO (ou herdam para texto). */
const TEXT_PROPS = /(^|[;{]|\s)(color|caret-color|text-decoration-color|-webkit-text-fill-color)\s*:[^;{}]*$/;

const keys = Object.keys(MAP).sort((a, b) => b.length - a.length);
const statusKeys = Object.keys(STATUS).sort((a, b) => b.length - a.length);

function migrate(text, isCss) {
  let out = text;
  for (const k of keys) {
    out = out.split(`var(${k})`).join(`var(${MAP[k]})`);
    // `var(--x, fallback)` também precisa ser convertido
    out = out.replace(new RegExp(`var\\(${k}\\s*,`, "g"), `var(${MAP[k]},`);
  }
  for (const k of statusKeys) {
    const family = STATUS[k];
    const re = new RegExp(`var\\(${k}(\\s*,|\\))`, "g");
    out = out.replace(re, (match, tail, offset) => {
      const before = out.slice(Math.max(0, offset - 220), offset);
      // Em TSX a pista é o utilitário: text-[var(--warn)] é texto.
      const isText = isCss
        ? TEXT_PROPS.test(before)
        : /\btext-\[$|\bplaceholder-\[$|\bdecoration-\[$/.test(before);
      return `var(--${family}${isText ? "-text" : ""}${tail}`;
    });
  }
  return out;
}

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(css|tsx|ts)$/.test(entry)) acc.push(full);
  }
  return acc;
}

let changed = 0;
let refs = 0;
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (SKIP_FILES.has(rel)) continue;
  const before = readFileSync(file, "utf8");
  const after = migrate(before, file.endsWith(".css"));
  if (after === before) continue;
  const delta = [...keys, ...statusKeys].reduce(
    (n, k) => n + (before.split(`var(${k})`).length - 1),
    0
  );
  refs += delta;
  changed += 1;
  console.log(`${DRY ? "would fix" : "fixed"}  ${rel}  (${delta} refs)`);
  if (!DRY) writeFileSync(file, after);
}
console.log(`\n${changed} file(s), ~${refs} legacy refs ${DRY ? "pending" : "migrated"}.`);
