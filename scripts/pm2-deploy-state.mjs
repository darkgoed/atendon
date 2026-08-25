const expectedApps = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");
const parsed = JSON.parse(raw);
if (!Array.isArray(parsed)) throw new Error("pm2 jlist não retornou uma lista");

const stringValue = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const state = {
  schemaVersion: 1,
  capturedAt: new Date().toISOString(),
  apps: parsed
    .filter((entry) => expectedApps.length === 0 || expectedApps.includes(entry?.name))
    .map((entry) => ({
      name: String(entry.name),
      status: stringValue(entry.pm2_env?.status) ?? "unknown",
      pid: Number.isInteger(entry.pid) ? entry.pid : null,
      restarts: Number.isInteger(entry.pm2_env?.restart_time) ? entry.pm2_env.restart_time : null,
      startedAt: Number.isFinite(entry.pm2_env?.pm_uptime) ? entry.pm2_env.pm_uptime : null,
      appVersion: stringValue(entry.pm2_env?.APP_VERSION ?? entry.pm2_env?.env?.APP_VERSION),
      deployVersion: stringValue(entry.pm2_env?.DEPLOY_VERSION ?? entry.pm2_env?.env?.DEPLOY_VERSION)
    }))
    .sort((left, right) => left.name.localeCompare(right.name))
};

console.log(JSON.stringify(state, null, 2));
