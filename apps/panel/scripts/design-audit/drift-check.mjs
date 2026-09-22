#!/usr/bin/env node
/** R5 drift-check: valida cada entitySelector+marker (e heading) de contrato
 *  contra o DOM dump correspondente gravado pelo runner. Falha se o marker não
 *  aparecer DENTRO da entidade — sem isso a rota não pode ser declarada
 *  "populated"/"expected-error". Uso:
 *    node scripts/design-audit/drift-check.mjs [caminho/para/audit.json]
 *  Saída: drift-check.json ao lado do audit.json; exit 1 em divergência. */
import { chromium } from "playwright";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { ROUTE_CONTRACTS } from "./contracts.mjs";
import { SETTINGS_OPTIONAL_CONTRACTS } from "./optionalcontracts-settings.mjs";
import { ROOT_ROUTE_CONTRACTS } from "./contracts-root.mjs";

const auditPath = process.argv[2] ?? process.env.AUDIT_JSON ?? resolve(process.env.OUTPUT ?? process.env.QA_OUTPUT ?? "/tmp/atendon-frontend-redesign/qa-browser/audit", "audit.json");
// Mesma precedência efetiva do runner (loadDomainContracts): root > settings > base.
const allContracts = { ...ROUTE_CONTRACTS, ...SETTINGS_OPTIONAL_CONTRACTS, ...ROOT_ROUTE_CONTRACTS };
const report = { auditPath, checked: 0, entityChecked: 0, results: [], entityFailed: [], headingFailed: [], withoutContract: [], dumpCountMismatch: null, passed: false };

const reportData = JSON.parse(await readFile(auditPath, "utf8"));
const records = reportData.routes ?? [];
const domDir = resolve(auditPath, "..", "dom");
const dumpFiles = (await readdir(domDir)).filter((file) => file.endsWith(".html")).sort();
if (dumpFiles.length !== records.length) report.dumpCountMismatch = { dumps: dumpFiles.length, records: records.length };

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
// Dumps são HTML estático: nenhuma rede é permitida (validação de conteúdo puro).
await context.route("**/*", (route) => route.abort());
const page = await context.newPage();
try {
  for (const [index, record] of records.entries()) {
    const contract = allContracts[record.route];
    if (!contract) { report.withoutContract.push(record.route); continue; }
    const dump = await readFile(resolve(domDir, `${String(index + 1).padStart(4, "0")}.html`), "utf8");
    await page.setContent(dump, { waitUntil: "domcontentloaded" });
    const outcome = await page.evaluate(({ selector, marker, heading }) => {
      const pattern = marker ? new RegExp(marker, "i") : null;
      const headingPattern = heading ? new RegExp(`^(?:${heading})$`, "i") : null;
      const nodes = selector ? [...document.querySelectorAll(selector)] : [];
      // Mesma regra de match do runner (textContent + aria-label + title + inputs).
      const entityMatched = pattern
        ? nodes.some((node) => pattern.test(`${node.textContent ?? ""} ${node.getAttribute("aria-label") ?? ""} ${node.getAttribute("title") ?? ""} ${[...node.querySelectorAll("input,textarea,select")].map((input) => input.value).join(" ")}`))
        : null;
      const headings = [...document.querySelectorAll("h1,h2,[role=heading]")];
      return {
        entityMatched,
        entityCount: nodes.length,
        headingMatched: headingPattern ? headings.some((node) => headingPattern.test((node.textContent ?? "").trim())) : null,
        headingCount: headings.length
      };
    }, { selector: contract.entitySelector ?? null, marker: contract.marker ?? null, heading: contract.heading ?? null });
    const entry = { route: record.route, theme: record.theme?.requested ?? record.theme, viewport: record.viewport?.name ?? record.viewport, ...outcome };
    report.results.push(entry);
    report.checked += 1;
    if (contract.entitySelector && contract.marker) {
      report.entityChecked += 1;
      if (!outcome.entityMatched) report.entityFailed.push({ ...entry, selector: contract.entitySelector, marker: contract.marker, state: contract.state });
    }
    if (!contract.headingOptional && contract.heading && !outcome.headingMatched) report.headingFailed.push({ ...entry, heading: contract.heading });
  }
} finally { await browser.close(); }
// Regra R5: populated/expected-error SEMPRE passa pelo check de entidade —
// e um registro sem contrato é falha (nenhuma rota fora dos contratos).
report.stateEntries = records.filter((record) => { const contract = allContracts[record.route]; return contract && (contract.state === "populated" || contract.state === "expected-error"); }).length;
report.passed = report.entityFailed.length === 0 && report.headingFailed.length === 0 && report.withoutContract.length === 0 && !report.dumpCountMismatch;
await writeFile(resolve(auditPath, "..", "drift-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ checked: report.checked, entityChecked: report.entityChecked, stateEntries: report.stateEntries, entityFailed: report.entityFailed.length, headingFailed: report.headingFailed.length, withoutContract: report.withoutContract.length, dumpCountMismatch: report.dumpCountMismatch, passed: report.passed }, null, 2));
if (!report.passed) process.exitCode = 1;
