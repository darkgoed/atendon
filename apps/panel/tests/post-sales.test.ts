import { describe, expect, it } from "vitest";
import { ApiError } from "../lib/api";
import {
  buildPostSaleQuery,
  EMPTY_POST_SALE_FILTERS,
  formatPostSalePhone,
  isPostSaleVersionConflict,
  postSaleOriginLabel,
  postSaleQueueLabel,
  postSaleStateLabel
} from "../lib/post-sales";

describe("post-sales panel helpers", () => {
  it("serializes only active portfolio filters and trims search", () => {
    const query = new URLSearchParams(buildPostSaleQuery({
      ...EMPTY_POST_SALE_FILTERS,
      q: "  Marina Silva  ",
      progress: "in_progress",
      responsible_member_id: "member-1",
      next_action: "today"
    }));
    expect(Object.fromEntries(query)).toEqual({
      q: "Marina Silva",
      progress: "in_progress",
      responsible_member_id: "member-1",
      next_action: "today",
      archived: "active"
    });
  });

  it("formats phone and operational labels in pt-BR", () => {
    expect(formatPostSalePhone("5511999999999")).toBe("+55 11 99999-9999");
    expect(formatPostSalePhone("351912345678")).toBe("+351912345678");
    expect(postSaleStateLabel("checklist_complete")).toBe("Checklist completo");
    expect(postSaleQueueLabel("overdue")).toBe("Atrasada");
    expect(postSaleOriginLabel("closed_sale")).toBe("Venda fechada");
  });

  it("recognizes only typed optimistic-concurrency conflicts", () => {
    expect(isPostSaleVersionConflict(new ApiError("conflict", 409, { code: "VERSION_CONFLICT" }))).toBe(true);
    expect(isPostSaleVersionConflict(new ApiError("duplicate", 409, { code: "PHONE_CONFLICT" }))).toBe(false);
    expect(isPostSaleVersionConflict(new ApiError("conflict", 400, { code: "VERSION_CONFLICT" }))).toBe(false);
  });
});
