import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { SessionRepository } from "../src/modules/whatsapp/session-repository.js";

describe("SessionRepository.listRunnable", () => {
  it("only asks PostgreSQL for sessions that should reconnect automatically", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new SessionRepository({ query } as unknown as Pool);

    await repository.listRunnable();

    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0][0]).replace(/\s+/g, " ");
    expect(sql).toContain("s.status IN ('connected', 'qr_pending')");
    expect(sql).not.toContain("s.status <> 'banned'");
  });
});
