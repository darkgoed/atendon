#!/usr/bin/env node
/**
 * Detector de APAGAMENTO de design (não de remoção legítima).
 *
 *   node scripts/ds-orphan-classes.mjs [ref]      # ref padrão: HEAD
 *
 * A v1 deste refactor foi revertida porque a migração APAGOU design em vez de
 * portá-lo: `auth.css` caiu de 256 para 74 linhas e o split-screen do login
 * virou um card genérico. Nenhum gate pegou — tsc, lint, build e as auditorias
 * de contraste/paridade passaram todas.
 *
 * Este script responde às duas perguntas que pegariam aquilo:
 *
 *  1. ÓRFÃOS: existe classe no markup (app/**, components/**) que NENHUM CSS
 *     define? É um elemento sem estilo — invisível para todos os outros gates.
 *  2. PERDIDAS: existe classe que o `ref` definia, que o markup ainda usa, e
 *     que hoje nenhum CSS define? É apagamento.
 *
 * Utilitários do Tailwind são ignorados por lista de prefixos conhecidos.
 */
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const REF = process.argv[2] || "HEAD";
const SKIP = new Set(["node_modules", ".next", "graphify-out", "test-results", "public", ".git"]);

function walk(dir, test, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, test, acc);
    else if (test(entry)) acc.push(full);
  }
  return acc;
}

/** Classes definidas por qualquer CSS do projeto (global + modules). */
function definedClasses() {
  const out = new Set();
  for (const file of walk(ROOT, (f) => f.endsWith(".css"))) {
    for (const m of readFileSync(file, "utf8").matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(m[1]);
  }
  return out;
}

/* Prefixos/nomes de utilitário do Tailwind — não precisam de regra própria. */
const TW_EXACT = new Set(["flex", "grid", "block", "inline", "hidden", "relative", "absolute",
  "fixed", "sticky", "truncate", "contents", "table", "isolate", "visible", "invisible",
  "uppercase", "lowercase", "capitalize", "italic", "antialiased", "underline", "group", "peer",
  "sr-only", "mono", "container", "static",
  // utilitários compostos do Tailwind que a regra de prefixo não cobre
  "inline-block", "inline-flex", "inline-grid", "inline-table", "flow-root",
  "list-item", "table-cell", "table-row", "sr-only", "not-sr-only",
  "line-through", "no-underline", "overline", "break-words", "break-all",
  "whitespace-nowrap", "pointer-events-none", "pointer-events-auto",
  "shrink-0", "grow-0", "flex-1", "flex-auto", "flex-none", "flex-wrap",
  "flex-col", "flex-row", "flex-nowrap", "flex-col-reverse", "flex-row-reverse",
  "min-w-0", "min-h-0", "max-w-full", "w-full", "h-full", "h-auto"]);
const TW_PREFIX = /^(gap|p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|w|h|min|max|top|left|right|bottom|inset|z|order|basis|grow|shrink|flex|col|row|grid|space|divide|size|leading|tracking|opacity|rounded|border|shadow|ring|text|bg|font|items|justify|self|content|place|align|overflow|whitespace|break|object|cursor|select|pointer|resize|list|transition|duration|ease|delay|animate|transform|scale|rotate|translate|origin|backdrop|filter|aspect|columns|auto|first|last|odd|even|hover|focus|focus-visible|focus-within|active|disabled|group|group-hover|peer|dark|print|motion|motion-safe|motion-reduce|supports|data|aria|has|not|only|empty|before|after|placeholder|file|marker|selection|caret|accent|fill|stroke|outline|sm|md|lg|xl|2xl|indent|scroll|snap|touch|overscroll|appearance|user|tabular|blur|grayscale|invert|saturate|contrast|brightness|sepia|float|clear|box|line|vertical|word|hyphens|writing|subpixel|will|mix|gradient|from|via|to|underline-offset|decoration|aspect-ratio|backface|isolation|object-position|place-content|place-items|place-self|row-span|col-span|col-start|col-end|row-start|row-end|auto-cols|auto-rows|grid-flow|grid-cols|grid-rows|justify-items|justify-self|content-start|content-center|content-end|self-start|self-center|self-end|items-start|items-center|items-end|items-baseline|items-stretch)([-:[]|$)/;
const isUtility = (c) => TW_EXACT.has(c) || TW_PREFIX.test(c);

/** Classes citadas em className="…" / className={`…`} no markup.
 *  Retorna { used, concatPrefixes }. */
function usedClasses() {
  const used = new Map();
  const concatPrefixes = new Set();
  const files = walk(join(ROOT, "app"), (f) => /\.tsx?$/.test(f))
    .concat(walk(join(ROOT, "components"), (f) => /\.tsx?$/.test(f)));
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
      // NÃO dividir em ":" — isso quebraria `md:grid-cols-2` em `md` + resto e
      // inventaria órfãos. Divide só em espaço e na sintaxe de template.
      for (const raw of (m[1] ?? m[2] ?? "").split(/[\s${}?'"]+/)) {
        const tok = raw.trim().replace(/^[:(]+|[:)]+$/g, "");
        // Só nomes COMPOSTOS em kebab-case: é a forma de uma classe do design
        // system (`pipeline-card__name`, `admin-badge--warn`). Uma palavra só
        // quase sempre é um ramo de ternário (`"day"`, `"mine"`) concatenado a
        // uma base, e produziria ruído puro.
        if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+(__[a-z0-9-]+)?(--[a-z0-9-]*)?$/.test(tok)) continue;
        if (isUtility(tok)) continue;
        // Prefixo de classe concatenada em runtime (`agenda-appointment--${st}`):
        // o token termina no separador, então o nome real só existe no browser.
        // Registramos o PREFIXO para checar que existe ao menos uma variante.
        if (/(--|__)$/.test(tok)) { concatPrefixes.add(tok); continue; }
        if (!used.has(tok)) used.set(tok, new Set());
        used.get(tok).add(relative(ROOT, file));
      }
    }
  }
  return { used, concatPrefixes };
}

/* Exceções legítimas: classes que existem como ÂNCORA/HOOK, não como estilo.
   Codificadas aqui para que um run limpo tenha significado.
     - channels-ai-page: âncora das regras `:global(.channels-ai-*)` do
       app/channels-ai.module.css (aplicada junto de styles.channelsAiPage).
     - conversation-referral / conversation-status-picker: hooks de teste e de
       seleção em e2e; o estilo vem de utilitários/tokens no próprio componente. */
const ANCHOR_ONLY = new Set(["channels-ai-page", "conversation-referral", "conversation-status-picker"]);

const defined = definedClasses();
const { used, concatPrefixes } = usedClasses();
for (const anchor of ANCHOR_ONLY) used.delete(anchor);
const definedList = [...defined];

/* Prefixo concatenado sem NENHUMA variante definida = família sem tratamento. */
const prefixesWithoutVariant = [...concatPrefixes]
  .filter((prefix) => !definedList.some((c) => c.startsWith(prefix) && c.length > prefix.length))
  .sort();

const orphans = [...used.keys()].filter((c) => !defined.has(c)).sort();

/* Classes que o ref definia e que hoje ninguém define. */
let lostButUsed = [];
try {
  const refCss = execSync(
    `git ls-tree -r --name-only ${REF} -- apps/atendon/apps/panel | grep '\\.css$' | while read f; do git show ${REF}:"$f"; done`,
    { cwd: "/var/www", encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: "/bin/bash" }
  );
  const refDefined = new Set([...refCss.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]));
  lostButUsed = [...used.keys()]
    .filter((c) => refDefined.has(c) && !defined.has(c))
    .sort();
} catch (error) {
  console.warn(`aviso: não foi possível comparar com ${REF} (${String(error).slice(0, 80)})`);
}

console.log(`=== 1. Classes no markup sem NENHUMA regra de CSS (${orphans.length}) ===`);
for (const c of orphans) console.log(`  ${c}  <- ${[...used.get(c)].slice(0, 3).join(", ")}`);
if (!orphans.length) console.log("  ok");

console.log(`\n=== 1b. Famílias concatenadas em runtime sem nenhuma variante definida (${prefixesWithoutVariant.length}) ===`);
for (const p of prefixesWithoutVariant) console.log(`  ${p}*`);
if (!prefixesWithoutVariant.length) console.log("  ok");

console.log(`\n=== 2. APAGAMENTO: definidas em ${REF}, ainda usadas, hoje sem regra (${lostButUsed.length}) ===`);
for (const c of lostButUsed) console.log(`  ${c}  <- ${[...used.get(c)].slice(0, 3).join(", ")}`);
if (!lostButUsed.length) console.log("  ok");

process.exitCode = orphans.length || lostButUsed.length || prefixesWithoutVariant.length ? 1 : 0;
