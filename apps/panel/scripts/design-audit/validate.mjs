import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
export const benignExternal = (url) => /^(https:\/\/fonts\.googleapis\.com|https:\/\/fonts\.gstatic\.com)\//.test(url);

// Optional cache contains the real Google stylesheet and font bytes, never an empty substitute.
export function fontFixture(url, manifestPath = process.env.AUDIT_FONT_CACHE) {
  if (!manifestPath || !benignExternal(url)) return null;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const asset = manifest[url];
  if (!asset) throw new Error(`font cache missing: ${url}`);
  const body = readFileSync(resolve(dirname(manifestPath), asset.path));
  const sha256 = createHash("sha256").update(body).digest("hex");
  if (sha256 !== asset.sha256) throw new Error(`font cache integrity mismatch: ${url}`);
  return { status: 200, contentType: asset.contentType, body, headers: { "access-control-allow-origin": "*", "x-audit-font-sha256": sha256 } };
}

/** Theme is part of the record identity; never interpolate an object. */
export function recordKey(record) {
  const theme = typeof record.theme === "string" ? record.theme : record.theme?.requested;
  const viewport = typeof record.viewport === "string" ? record.viewport : record.viewport?.name;
  return `${record.route}|${theme}|${viewport}`;
}
export function expectedPathFor(route, requested, contract) { return contract?.expectedPath ?? requested; }
const tokensCss = readFileSync(new URL("../../styles/tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function tokenBackground(selector) {
  for (const [, selectors, body] of tokensCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const hex = selectors.trim() === selector ? body.match(/--bg:\s*(#[0-9a-f]{6})\s*;/i)?.[1].toLowerCase() : null;
    if (hex) return [hex, `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")})`];
  }
  throw new Error(`tokens.css: --bg missing in ${selector}`);
}
const knownBackgrounds = { dark: tokenBackground(':root[data-theme="dark"]'), light: tokenBackground(":root") };
export function validateRecord(record, contract) {
  const errors = [];
  if (!contract) errors.push("missing route fixture contract");
  const expectedPath = expectedPathFor(record.route, record.requested, contract);
  if (record.finalUrl !== expectedPath) errors.push(`landed URL ${record.finalUrl} != expected ${expectedPath}`);
  const requestedTheme = typeof record.theme === "string" ? record.theme : record.theme?.requested;
  if (record.theme?.dataset !== requestedTheme) errors.push("theme dataset mismatch");
  const backgrounds = knownBackgrounds[requestedTheme] ?? [];
  if (!record.theme?.background || (backgrounds.length > 0 && !backgrounds.includes(record.theme.background))) errors.push("missing computed theme background");
  if (!record.heading?.matched && !contract?.headingOptional) errors.push("missing unique route heading");
  // R5: "populated" e "expected-error" exigem marker dentro da entidade —
  // sem isso a rota não pode ser declarada populated/auditada em erro esperado.
  // D2/P3: alinhado ao drift-check — contrato com entitySelector+marker valida a
  // entidade em QUALQUER estado (antes só populated/expected-error eram exigidos).
  if (contract?.entitySelector && contract?.marker && !record.entity?.matched) errors.push("missing seeded entity marker");
  if (record.loading) errors.push("loading state");
  if (record.gaps?.length) errors.push("unhandled API request");
  if (record.pageErrors?.length || record.consoleErrors?.length) errors.push("console/page errors");
  if (record.axe?.error || record.axe?.violations?.length) errors.push(record.axe?.error ? "axe error" : "axe violations");
  if (record.errorText) errors.push("error state");
  if (record.metrics?.horizontalOverflow) errors.push("horizontal overflow");
  if (record.metrics?.clippedButtons) errors.push("clipped buttons");
  if (record.metrics?.postSalesDisclosure?.attempted && !record.metrics.postSalesDisclosure.reachable) errors.push("post-sales disclosure unreachable");
  // R1(a): estado "not-found" EXIGE HTTP 404 (rota inexistente renderizando o boundary).
  const notFoundState = contract?.state === "not-found";
  const statusOk = notFoundState
    ? record.httpStatus === 404
    : Number.isInteger(record.httpStatus) && record.httpStatus >= 200 && record.httpStatus < 400;
  if (!statusOk) errors.push(`HTTP status ${record.httpStatus ?? "missing"}${notFoundState ? " (not-found state requires 404)" : ""}`);
  if (!record.assets?.js?.length || !record.assets?.css?.length) errors.push("missing loaded JS/CSS assets");
  return { valid: errors.length === 0, errors };
}
export function mergeRecords(reports) {
  const byKey = new Map();
  for (const record of reports.flatMap((report) => report.routes ?? [])) {
    const key = recordKey(record);
    if (byKey.has(key)) throw new Error(`duplicate audit record key: ${key}`);
    byKey.set(key, record);
  }
  return [...byKey.values()];
}
export function summarize(records) { return Object.fromEntries([...new Set(records.map((r) => r.status))].map((status) => [status, records.filter((r) => r.status === status).length])); }
