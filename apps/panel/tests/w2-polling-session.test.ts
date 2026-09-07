import { describe, expect, it } from "vitest";
import { hasRequiredPermissions } from "../lib/session";
describe("w2 session and polling contracts", () => { it("keeps undefined permission state distinct", () => { expect(hasRequiredPermissions([], undefined)).toBe(true); expect(hasRequiredPermissions([], ["x"])).toBe(false); }); });
