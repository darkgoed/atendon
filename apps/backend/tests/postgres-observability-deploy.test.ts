import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("controlled PostgreSQL observability deployment", () => {
  it("preloads and creates pg_stat_statements without changing migrations", async () => {
    const [compose, extension, roles, runbook, endpoint] = await Promise.all([
      readFile(new URL("../../../docker-compose.yml", import.meta.url), "utf8"),
      readFile(new URL("../../../deploy/postgres/enable-observability.sql", import.meta.url), "utf8"),
      readFile(new URL("../../../deploy/postgres/provision-roles.sh", import.meta.url), "utf8"),
      readFile(new URL("../../../docs/runbooks/postgresql-observability.md", import.meta.url), "utf8"),
      readFile(new URL("../src/modules/operations/operational-snapshot.ts", import.meta.url), "utf8")
    ]);
    expect(compose).toContain("shared_preload_libraries=pg_stat_statements");
    expect(compose).toContain("pg_stat_statements.track=all");
    expect(compose).toContain("track_io_timing=on");
    expect(extension).toContain("CREATE EXTENSION IF NOT EXISTS pg_stat_statements");
    expect(roles).toContain("dependency.deptype='e'");
    expect(roles).not.toContain("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES");
    expect(roles).toContain("GRANT SELECT ON TABLE public.pg_stat_statements");
    expect(runbook).toContain("--force-recreate postgres");
    expect(runbook).toContain("não altera feature flags");
    expect(endpoint).toContain("queryid::text query_id");
    expect(endpoint).not.toMatch(/\btenant_id\b|\bconversation_id\b|\bcontact_phone\b|\bemail\b/);
    expect(endpoint).not.toMatch(/\bSELECT\s+query(?:\s|,)/i);
  });
});
