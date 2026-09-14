import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const backend = resolve(new URL("../../../backend", import.meta.url).pathname);
const source = (file) => readFileSync(resolve(backend, file), "utf8");
const quoted = (text, name) => {
  const match = text.match(new RegExp(`(?:const|export const) ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!match) throw new Error(`Unable to read ${name} from backend source`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};
const rbac = source("src/auth/rbac.ts");
const flags = source("src/modules/operations/feature-flags.ts");
export const PERMISSION_KEYS = [...rbac.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]);
export const OPERATOR_PERMISSIONS = quoted(rbac, "OPERATOR_PERMISSIONS");
export const CAPABILITY_KEYS = quoted(flags, "CAPABILITY_KEYS");
export const FEATURE_FLAG_KEYS = quoted(flags, "FEATURE_FLAG_KEYS");
export const CAPABILITY_CATALOG = CAPABILITY_KEYS.map((key) => ({
  key, displayName: key, kind: "capability", description: `Source capability ${key}`,
  supported: true, enabled: true, dependencies: [], blockedBy: [],
  availabilityMode: key === "tripz_ai_v1" ? "provisioned" : "all_tenants",
  source: "fixture-source"
}));

// This mirrors GET /billing/my-plan, not the obsolete /entitlements response.
export const ENTITLEMENTS = {
  tenantId: "qa-workspace-0001", plan: { code: "MEDIUM", name: "Profissional" }, status: "ACTIVE",
  features: { CONVERSATIONS: true, LEADS: true, PIPELINE: true, CALENDAR: true, AI: true, AI_FOLLOWUP: true, ROLES_PERMISSIONS: true },
  limits: { MAX_USERS: 100, MAX_WHATSAPP_CONNECTIONS: 10, MAX_AI_INTERACTIONS: 1000 },
  usage: { users: 1, whatsappConnections: 1, aiInteractions: 0 }
};
export function sessionFor(root = false) {
  return root ? {
    user: { id: "qa-root", email: "root@example.test", name: "QA Root", isRoot: true }, activeWorkspace: null, workspaces: [],
    permissions: [...PERMISSION_KEYS], actorScope: "root", rootWorkspaceAccess: true
  } : {
    user: { id: "qa-user-0001", email: "qa@example.test", name: "QA Operador", isRoot: false },
    activeWorkspace: { id: "qa-workspace-0001", name: "AtendON QA Workspace", slug: "atendon-qa", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" },
    workspaces: [{ id: "qa-workspace-0001", name: "AtendON QA Workspace", slug: "atendon-qa", status: "active", role: "OWNER", timezone: "America/Sao_Paulo" }],
    permissions: [...PERMISSION_KEYS], actorScope: "workspace", rootWorkspaceAccess: false
  };
}
