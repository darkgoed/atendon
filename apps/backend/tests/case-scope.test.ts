import { describe, expect, it } from "vitest";
import { hasWorkspaceCaseAccess } from "../src/auth/case-scope.js";
import type { WorkspaceSession } from "../src/auth/session.js";

function session(role: string, isRoot = false): WorkspaceSession {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    tenantId: "22222222-2222-4222-8222-222222222222",
    email: "scope@test.local",
    role,
    roleId: null,
    permissions: [],
    isRoot,
    actorScope: isRoot ? "root" : "workspace"
  };
}

describe("case scope role boundary", () => {
  it.each(["ROOT", "OWNER", "ADMIN", "SUPERVISOR", " owner ", " supervisor "])(
    "grants workspace visibility only to the protected manager role %s",
    (role) => {
      expect(hasWorkspaceCaseAccess(session(role))).toBe(true);
    }
  );

  it.each(["OPERADOR", "ADMINISTRADOR", "CUSTOM OWNER", "SUPERVISOR DE VENDAS"])(
    "keeps non-protected and custom role %s scoped to its own cases",
    (role) => {
      expect(hasWorkspaceCaseAccess(session(role))).toBe(false);
    }
  );

  it("always recognizes an authenticated root identity", () => {
    expect(hasWorkspaceCaseAccess(session("FUNÇÃO PERSONALIZADA", true))).toBe(true);
  });
});
