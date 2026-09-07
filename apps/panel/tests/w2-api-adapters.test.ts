import { describe, expect, it, vi } from "vitest";
import { api } from "../lib/api";
import { updateLeadStatus } from "../lib/leads-api";
vi.mock("../lib/api", () => ({ api: vi.fn() }));
describe("w2 adapters", () => { it("preserves exact lead status contract", async () => { await updateLeadStatus("l1", "novo"); expect(api).toHaveBeenCalledWith("/scheduling/leads/l1/status", { method: "PATCH", body: JSON.stringify({ status: "novo" }) }); }); });
