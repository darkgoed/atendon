export const benignExternal = (url) => /^(https:\/\/fonts\.googleapis\.com|https:\/\/fonts\.gstatic\.com)\//.test(url);

/** Theme is part of the record identity; never interpolate an object. */
export function recordKey(record) {
  const theme = typeof record.theme === "string" ? record.theme : record.theme?.requested;
  const viewport = typeof record.viewport === "string" ? record.viewport : record.viewport?.name;
  return `${record.route}|${theme}|${viewport}`;
}
export function expectedPathFor(route, requested, contract) { return contract?.expectedPath ?? requested; }
const baseline = process.env.AUDIT_PHASE !== "final";
// Backgrounds computados aceitos por tema: tokens vigentes (tokens.css) primeiro,
// valores históricos mantidos para comparabilidade com auditorias antigas.
const knownBackgrounds = { dark: ["#0f1115", "rgb(15, 17, 21)", "#101719", "rgb(16, 23, 25)", "#0e1315"], light: baseline ? ["#f7f8fa", "rgb(247, 248, 250)", "#f7f7f5", "#F7F7F5", "#f4f3ee", "rgb(244, 243, 238)"] : ["#f7f8fa", "rgb(247, 248, 250)", "#f4f3ee", "rgb(244, 243, 238)"] };
export function validateRecord(record, contract) {
  const errors = [];
  if (!contract) errors.push("missing route fixture contract");
  const expectedPath = expectedPathFor(record.route, record.requested, contract);
  if (record.finalUrl !== expectedPath) errors.push(`landed URL ${record.finalUrl} != expected ${expectedPath}`);
  const requestedTheme = typeof record.theme === "string" ? record.theme : record.theme?.requested;
  if (record.theme?.dataset !== requestedTheme) errors.push("theme dataset mismatch");
  const backgrounds = knownBackgrounds[requestedTheme] ?? [];
  if (!record.theme?.background || (backgrounds.length > 0 && !backgrounds.includes(record.theme.background))) errors.push("missing computed theme background");
  if (!record.heading?.matched) errors.push("missing unique route heading");
  if (contract?.state === "populated" && !record.entity?.matched) errors.push("missing seeded nonempty entity marker");
  if (record.loading) errors.push("loading state");
  if (record.gaps?.length) errors.push("unhandled API request");
  if (record.pageErrors?.length || record.consoleErrors?.length) errors.push("console/page errors");
  if (record.axe?.error || record.axe?.violations?.length) errors.push(record.axe?.error ? "axe error" : "axe violations");
  if (record.errorText) errors.push("error state");
  if (record.metrics?.horizontalOverflow) errors.push("horizontal overflow");
  if (record.metrics?.clippedButtons) errors.push("clipped buttons");
  if (record.metrics?.postSalesDisclosure?.attempted && !record.metrics.postSalesDisclosure.reachable) errors.push("post-sales disclosure unreachable");
  if (!Number.isInteger(record.httpStatus) || record.httpStatus < 200 || record.httpStatus >= 400) errors.push(`HTTP status ${record.httpStatus ?? "missing"}`);
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
