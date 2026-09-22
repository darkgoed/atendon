#!/usr/bin/env node
/** R1 diff programático de matriz: rotas (page.tsx + estados + variantes) ×
 *  registros do audit.json, nos DOIS sentidos, e recomputação independente do
 *  expected (N rotas × temas × viewports) — nunca hardcoded. Uso:
 *    node scripts/design-audit/matrix-diff.mjs [caminho/para/audit.json]
 *  Saída: matrix-diff.json ao lado do audit.json; exit 1 em divergência. */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverInventory } from "./inventory.mjs";
import { ROUTE_CONTRACTS } from "./contracts.mjs";
import { SETTINGS_OPTIONAL_CONTRACTS } from "./optionalcontracts-settings.mjs";
import { ROOT_ROUTE_CONTRACTS } from "./contracts-root.mjs";

const auditPath = process.argv[2] ?? process.env.AUDIT_JSON ?? resolve(process.env.OUTPUT ?? process.env.QA_OUTPUT ?? "/tmp/atendon-frontend-redesign/qa-browser/audit", "audit.json");
const appRoot = process.env.PANEL_APP_ROOT ?? resolve(new URL(".", import.meta.url).pathname, "../../app");
const allContracts = { ...ROUTE_CONTRACTS, ...SETTINGS_OPTIONAL_CONTRACTS, ...ROOT_ROUTE_CONTRACTS };

const inventory = await discoverInventory(appRoot);
const pageRoutes = inventory.filter((entry) => !entry.routeState).map((entry) => entry.route);
const stateRoutes = inventory.filter((entry) => entry.routeState).map((entry) => ({ route: entry.route, state: entry.routeState, file: entry.file }));
// Variantes: mesma regra de expansão do runner (contratos "<rota>#<variante>").
const variantRoutes = [];
for (const route of pageRoutes) for (const key of Object.keys(allContracts)) if (key.startsWith(`${route}#`)) variantRoutes.push(key);

const reportData = JSON.parse(await readFile(auditPath, "utf8"));
const records = reportData.routes ?? [];
const recordRoutes = [...new Set(records.map((record) => record.route))];
const auditedStates = reportData.inventory?.routeStates?.audited ?? [];
const expectedRoutes = [...pageRoutes, ...variantRoutes, ...auditedStates];

const missingRecords = expectedRoutes.filter((route) => !recordRoutes.includes(route));
const unknownRecords = recordRoutes.filter((route) => !expectedRoutes.includes(route));
const matrixPerRoute = reportData.inventory?.matrixPerRoute ?? 6;
const expectedRecords = expectedRoutes.length * matrixPerRoute;
// Chaves duplicadas são contadas por identidade completa do registro
// (route|theme|viewport) — subtrair rotas únicas do total contaria a própria
// matriz (6 registros por rota) como duplicação.
const recordKeyOf = (record) => `${record.route}|${typeof record.theme === "string" ? record.theme : record.theme?.requested}|${typeof record.viewport === "string" ? record.viewport : (record.viewport?.name ?? `${record.viewport?.width}x${record.viewport?.height}`)}`;
const seenRecordKeys = new Set();
let duplicateKeys = 0;
for (const record of records) { const key = recordKeyOf(record); if (seenRecordKeys.has(key)) duplicateKeys += 1; else seenRecordKeys.add(key); }
const passed = missingRecords.length === 0 && unknownRecords.length === 0
  && records.length === expectedRecords
  && reportData.inventory?.expectedRecords === expectedRecords
  && duplicateKeys === 0;
const result = { auditPath, appRoot, pageRoutes: pageRoutes.length, stateRoutes, variantRoutes, expectedRoutes: expectedRoutes.length, matrixPerRoute, expectedRecords, records: records.length, runnerExpectedRecords: reportData.inventory?.expectedRecords ?? null, duplicateKeys, missingRecords, unknownRecords, passed };
await writeFile(resolve(auditPath, "..", "matrix-diff.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
