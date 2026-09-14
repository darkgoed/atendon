#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { mergeRecords, summarize } from "./validate.mjs";
import { loadInventory } from "./inventory.mjs";
const output = resolve(process.env.OUTPUT ?? "qa-corrected-baseline");
const inputs = (process.env.AUDIT_INPUTS ?? "qa-browser-b1,qa-browser-b2,qa-browser-b3").split(",").map((p) => resolve(output, "..", p, "audit.json"));
const reports = await Promise.all(inputs.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const inventory = await loadInventory(process.env.ROUTE_INVENTORY, resolve(new URL(".", import.meta.url).pathname, "../../app"));
const routes = mergeRecords(reports);
const routeNames = new Set(routes.map((r) => r.route));
const result = { version: "design-audit-v2", baseline: reports[0]?.baseline ?? "baseline3499", buildMarker: reports[0]?.buildMarker ?? "unknown", baseURL: reports[0]?.baseURL, generatedAt: new Date().toISOString(), inventory: { total: inventory.length, verifiedRoutes: routeNames.size, records: routes.length, expectedRecords: inventory.length * 6, matrix: { themes: ["dark", "light"], viewports: ["360x800", "768x1024", "1440x900"] } }, counts: summarize(routes), unknownApiRequests: [...new Set(reports.flatMap((r) => r.unknownApiRequests ?? []))].sort(), routes };
await mkdir(output, { recursive: true }); await writeFile(resolve(output, "audit.json"), JSON.stringify(result, null, 2)); await writeFile(resolve(output, "summary.json"), JSON.stringify({ ...result, routes: undefined }, null, 2));
console.log(JSON.stringify({ output, verifiedRoutes: routeNames.size, inventoryRoutes: inventory.length, records: routes.length, counts: result.counts, unknownApiRequests: result.unknownApiRequests }, null, 2));
if (routeNames.size !== inventory.length || routes.length !== inventory.length * 6 || result.unknownApiRequests.length) process.exitCode = 2;
