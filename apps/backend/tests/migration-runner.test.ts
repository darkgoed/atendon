import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runMigrations } from "../src/db/migration-runner.js";

class FakeMigrationClient {
  readonly queries: Array<{ sql: string; values?: unknown[] }> = [];
  ledger: Array<{ filename: string; checksum: string; execution_mode: "applied" | "adopted" }> = [];
  baseline = { core_exists: false, baseline_complete: false };
  supervisorCollision = false;
  failOn?: string;

  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.queries.push({ sql, values });
    if (this.failOn && sql.includes(this.failOn)) throw new Error("simulated migration failure");
    if (sql.startsWith("SELECT filename,checksum")) return { rows: this.ledger as T[] };
    if (sql.includes("AS baseline_complete")) return { rows: [this.baseline] as T[] };
    if (sql.includes("unsafe_collision")) {
      return { rows: [{ unsafe_collision: this.supervisorCollision }] as T[] };
    }
    return { rows: [] };
  }
}

const directories: string[] = [];

async function migrations(files: Record<string, string>) {
  const directory = await mkdtemp(join(tmpdir(), "atendon-migrations-"));
  directories.push(directory);
  for (const [filename, sql] of Object.entries(files)) await writeFile(join(directory, filename), sql);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("migration runner", () => {
  it("serializes runners and applies each new file in its own transaction", async () => {
    const directory = await migrations({ "0001.sql": "SELECT one", "0002.sql": "SELECT two" });
    const client = new FakeMigrationClient();

    const result = await runMigrations(client, directory, () => undefined);

    expect(result.applied).toEqual(["0001.sql", "0002.sql"]);
    expect(client.queries.filter(({ sql }) => sql === "BEGIN")).toHaveLength(2);
    expect(client.queries.filter(({ sql }) => sql === "COMMIT")).toHaveLength(2);
    expect(client.queries[0].sql).toContain("application_name='atendon-migration'");
    expect(client.queries[0].sql).toContain("statement_timeout=0");
    expect(client.queries[0].sql).toContain("lock_timeout=0");
    expect(client.queries[0].sql).toContain("idle_in_transaction_session_timeout=0");
    expect(client.queries[1].sql).toContain("pg_advisory_lock");
    expect(client.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("creates every object as the explicit NOLOGIN owner and resets the session role", async () => {
    const directory = await migrations({ "0001.sql": "SELECT safe_owner_migration" });
    const client = new FakeMigrationClient();

    await runMigrations(client, directory, () => undefined, { ownerRole: "atendon_owner" });

    expect(client.queries[0].sql).toBe('SET ROLE "atendon_owner"');
    expect(client.queries.at(-2)?.sql).toContain("pg_advisory_unlock");
    expect(client.queries.at(-1)?.sql).toBe("RESET ROLE");
    expect(client.queries.some(({ sql }) => sql.includes("safe_owner_migration"))).toBe(true);
  });

  it("rejects an unsafe owner role before issuing SET ROLE", async () => {
    const directory = await migrations({});
    const client = new FakeMigrationClient();

    await expect(runMigrations(
      client,
      directory,
      () => undefined,
      { ownerRole: 'owner"; RESET ROLE; --' }
    )).rejects.toThrow(/simple lowercase/i);
    expect(client.queries).toEqual([]);
  });

  it("adopts a verified existing baseline without executing historical SQL", async () => {
    const directory = await migrations({
      "0026_balanced_humanizer_timing.sql": "DANGEROUS UPDATE",
      "0027_manual_ai_pause.sql": "DANGEROUS DELETE",
      "0028_handoff_notification_outbox.sql": "SELECT safe_new_outbox",
      "0029_conversation_ownership.sql": "SELECT safe_new_migration"
    });
    const client = new FakeMigrationClient();
    client.baseline = { core_exists: true, baseline_complete: true };

    const result = await runMigrations(client, directory, () => undefined);

    expect(result.adopted).toEqual(["0026_balanced_humanizer_timing.sql", "0027_manual_ai_pause.sql"]);
    expect(result.applied).toEqual(["0028_handoff_notification_outbox.sql", "0029_conversation_ownership.sql"]);
    expect(client.queries.some(({ sql }) => sql.includes("DANGEROUS"))).toBe(false);
    const modes = client.queries.filter(({ sql }) => sql.includes("INSERT INTO schema_migrations")).map(({ values }) => values?.[2]);
    expect(modes).toEqual(["adopted", "adopted", "applied", "applied"]);
  });

  it("refuses to guess when an existing schema does not match the safe baseline", async () => {
    const directory = await migrations({ "0027_manual_ai_pause.sql": "DANGEROUS UPDATE" });
    const client = new FakeMigrationClient();
    client.baseline = { core_exists: true, baseline_complete: false };

    await expect(runMigrations(client, directory, () => undefined)).rejects.toThrow("cannot be safely adopted");
    expect(client.queries.some(({ sql }) => sql.includes("DANGEROUS"))).toBe(false);
    expect(client.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("rejects edited or missing migrations already recorded in the ledger", async () => {
    const directory = await migrations({ "0001.sql": "SELECT changed" });
    const client = new FakeMigrationClient();
    client.ledger = [{ filename: "0001.sql", checksum: "0".repeat(64), execution_mode: "applied" }];

    await expect(runMigrations(client, directory, () => undefined)).rejects.toThrow("checksum mismatch");
  });

  it("rolls back the failing file and still releases the advisory lock", async () => {
    const directory = await migrations({ "0001.sql": "SELECT dangerous" });
    const client = new FakeMigrationClient();
    client.failOn = "SELECT dangerous";

    await expect(runMigrations(client, directory, () => undefined)).rejects.toThrow("Migration failed: 0001.sql");
    expect(client.queries.map(({ sql }) => sql)).toContain("ROLLBACK");
    expect(client.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("stops before converting a pre-existing custom SUPERVISOR role into a system role", async () => {
    const directory = await migrations({
      "0089_supervisor_role.sql": "UPDATE workspace_roles SET is_system=true"
    });
    const client = new FakeMigrationClient();
    client.supervisorCollision = true;

    await expect(runMigrations(client, directory, () => undefined))
      .rejects.toThrow(/custom SUPERVISOR role/i);
    expect(client.queries.some(({ sql }) => sql.includes("UPDATE workspace_roles"))).toBe(false);
    expect(client.queries.map(({ sql }) => sql)).toContain("ROLLBACK");
  });
});
