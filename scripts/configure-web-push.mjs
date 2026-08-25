import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import webPush from "web-push";

const environmentPath = resolve(process.cwd(), ".env");
let source = "";
try {
  source = await readFile(environmentPath, "utf8");
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const values = new Map();
for (const line of source.split(/\r?\n/)) {
  const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
  if (match) values.set(match[1],match[2]);
}

if (!values.get("WEB_PUSH_PUBLIC_KEY") || !values.get("WEB_PUSH_PRIVATE_KEY")) {
  const generated = webPush.generateVAPIDKeys();
  values.set("WEB_PUSH_PUBLIC_KEY",generated.publicKey);
  values.set("WEB_PUSH_PRIVATE_KEY",generated.privateKey);
}
if (!values.get("WEB_PUSH_SUBJECT")) {
  values.set("WEB_PUSH_SUBJECT","mailto:operacoes@atendon.com.br");
}

const managed = new Set(["WEB_PUSH_PUBLIC_KEY","WEB_PUSH_PRIVATE_KEY","WEB_PUSH_SUBJECT"]);
const kept = source.split(/\r?\n/).filter((line) => {
  const key = /^([A-Z][A-Z0-9_]*)=/.exec(line)?.[1];
  return !key || !managed.has(key);
});
while (kept.at(-1) === "") kept.pop();
kept.push(
  "",
  `WEB_PUSH_PUBLIC_KEY=${values.get("WEB_PUSH_PUBLIC_KEY")}`,
  `WEB_PUSH_PRIVATE_KEY=${values.get("WEB_PUSH_PRIVATE_KEY")}`,
  `WEB_PUSH_SUBJECT=${values.get("WEB_PUSH_SUBJECT")}`,
  ""
);
await writeFile(environmentPath,kept.join("\n"),{ mode: 0o600 });
console.log("Web Push VAPID configurado no .env (chaves preservadas e não exibidas).");
