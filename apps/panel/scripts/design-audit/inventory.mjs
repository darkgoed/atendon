import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
const dynamic = /\[([^\]]+)\]/g;
async function pages(dir, root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await pages(path, root, out);
    else if (entry.name === "page.tsx") out.push(path);
  }
  return out;
}
export async function discoverInventory(appRoot) {
  const files = await pages(appRoot, appRoot);
  return (await Promise.all(files.map(async (file) => {
    const rel = relative(appRoot, file).split(sep).join("/");
    const route = `/${rel.replace(/page\.tsx$/, "").replace(/\/index$/, "").replaceAll("/", "/")}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
    return { route: route.replace(dynamic, "[$1]"), file: rel, sourceHashInput: await readFile(file, "utf8") };
  }))).sort((a, b) => a.route.localeCompare(b.route)).map(({ sourceHashInput, ...entry }) => entry);
}
export async function loadInventory(path, appRoot) {
  if (path) return JSON.parse(await readFile(path, "utf8"));
  return discoverInventory(appRoot);
}
