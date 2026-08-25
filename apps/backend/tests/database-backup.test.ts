import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { runMigrations } from "../src/db/migration-runner.js";
import {
  assertDifferentDatabaseTargets,
  createDatabaseBackup,
  databaseIdentity,
  readAndValidateManifest,
  resolveRestoreAdminDatabaseUrl,
  validateDisposableDatabaseName,
  verifyDatabaseRestore
} from "../scripts/database-backup-lib.js";

function databaseUrlWithName(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

function uuidHex(): string {
  return randomUUID().replaceAll("-", "");
}

describe("database backup safety", () => {
  it("derives the isolated admin database URL only from private bootstrap credentials", () => {
    const resolved = resolveRestoreAdminDatabaseUrl({
      MIGRATION_DATABASE_URL: "postgresql://migration:migration-secret@localhost:5436/atendon?sslmode=disable",
      POSTGRES_USER: "bootstrap_admin",
      POSTGRES_PASSWORD: "bootstrap secret"
    });
    const parsed = new URL(resolved!);
    expect(parsed.username).toBe("bootstrap_admin");
    expect(decodeURIComponent(parsed.password)).toBe("bootstrap secret");
    expect(parsed.pathname).toBe("/postgres");
    expect(parsed.searchParams.get("sslmode")).toBe("disable");
    expect(resolveRestoreAdminDatabaseUrl({
      CUSTOM_ADMIN_URL: "postgresql://admin:secret@verify.example/postgres"
    }, "CUSTOM_ADMIN_URL")).toContain("verify.example");
    expect(resolveRestoreAdminDatabaseUrl({
      MIGRATION_DATABASE_URL: "postgresql://migration:secret@localhost/atendon",
      POSTGRES_USER: "admin",
      POSTGRES_PASSWORD: "secret"
    }, "CUSTOM_ADMIN_URL")).toBeUndefined();
  });

  it.each([
    "atendon",
    "postgres",
    "atendon_restore_verify_",
    "atendon_restore_verify_not-a-uuid",
    "atendon_restore_verify_1234;drop_database"
  ])("rejects an unsafe disposable target name: %s", (database) => {
    expect(() => validateDisposableDatabaseName(database)).toThrow(/inseguro/);
  });

  it("rejects source and target pointing to the same database", () => {
    const source = databaseIdentity("postgresql://user:secret@localhost:5432/atendon_restore_verify_1234567890abcdef1234567890abcdef");
    expect(() => assertDifferentDatabaseTargets(source, { ...source })).toThrow(/mesmo banco/);
  });

  it("rejects a dump whose checksum differs from its manifest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atendon-backup-checksum-"));
    try {
      const dumpFile = join(directory, "backup.dump");
      const payload = Buffer.from("tampered archive");
      await writeFile(dumpFile, payload);
      const manifestFile = join(directory, "backup.manifest.json");
      await writeFile(manifestFile, JSON.stringify({
        schemaVersion: 1,
        kind: "atendon-postgresql-backup",
        createdAt: "2026-07-25T12:00:00.000Z",
        deployVersion: "test",
        source: { host: "loopback", port: "5432", database: "source" },
        migrations: { latest: null, count: 0 },
        schema: { constraints: 0, foreignKeys: 0 },
        tableCounts: {},
        dump: {
          file: "backup.dump",
          format: "custom",
          noOwner: true,
          noAcl: true,
          bytes: payload.byteLength,
          sha256: "0".repeat(64)
        }
      }));
      await expect(readAndValidateManifest(manifestFile)).rejects.toThrow(/Checksum SHA-256/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("requires exact cleanup confirmation before reading or creating anything", async () => {
    await expect(verifyDatabaseRestore({
      manifestFile: "/does/not/exist",
      adminDatabaseUrl: "postgresql://user:secret@localhost/postgres",
      targetDatabase: `atendon_restore_verify_${uuidHex()}`,
      reportFile: "/tmp/unused-report.json",
      cleanup: true,
      confirmDrop: "different"
    })).rejects.toThrow(/confirm-drop/);
  });

  it("rejects a broad backup directory before connecting to a database", async () => {
    await expect(createDatabaseBackup({
      databaseUrl: "postgresql://user:secret@localhost/database",
      outputDirectory: "/",
      deployVersion: "test"
    })).rejects.toThrow(/raiz/);
  });

  it("rejects an unsafe owner role before reading the filesystem or connecting", async () => {
    await expect(createDatabaseBackup({
      databaseUrl: "postgresql://user:secret@localhost/database",
      outputDirectory: "/does/not/matter",
      deployVersion: "test",
      ownerRole: "owner; RESET ROLE"
    })).rejects.toThrow(/owner role/i);
  });
});

describe("database backup and real restore verification", () => {
  const sourceDatabase = `atendon_backup_source_${uuidHex()}`;
  const targetDatabase = `atendon_restore_verify_${uuidHex()}`;
  const adminUrl = databaseUrlWithName(config.DATABASE_URL, "postgres");
  const sourceUrl = databaseUrlWithName(config.DATABASE_URL, sourceDatabase);
  let admin: pg.Client;
  let directory = "";
  let pgDumpWrapper = "";
  let pgRestoreWrapper = "";

  beforeAll(async () => {
    const containerId = execFileSync(
      "docker",
      ["compose", "ps", "-q", "postgres"],
      { cwd: new URL("../../..", import.meta.url), encoding: "utf8" }
    ).trim();
    if (!/^[0-9a-f]{12,64}$/.test(containerId)) {
      throw new Error("Container PostgreSQL do Compose não está disponível para o restore real");
    }
    directory = await mkdtemp(join(tmpdir(), "atendon-backup-real-"));
    pgDumpWrapper = join(directory, "pg-dump-16");
    pgRestoreWrapper = join(directory, "pg-restore-16");
    const wrapper = (binary: "pg_dump" | "pg_restore") => `#!/bin/sh
exec docker exec -i \\
  -e PGDATABASE="$PGDATABASE" \\
  -e PGUSER="$PGUSER" \\
  ${containerId} sh -c '
    export PGHOST=127.0.0.1 PGPORT=5432 PGPASSWORD="$POSTGRES_PASSWORD"
    exec ${binary} "$@"
  ' sh "$@"
`;
    await writeFile(pgDumpWrapper, wrapper("pg_dump"), { mode: 0o700 });
    await writeFile(pgRestoreWrapper, wrapper("pg_restore"), { mode: 0o700 });
    await Promise.all([chmod(pgDumpWrapper, 0o700), chmod(pgRestoreWrapper, 0o700)]);

    admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${sourceDatabase}" TEMPLATE template0`);
    const source = new pg.Client({ connectionString: sourceUrl });
    try {
      await source.connect();
      await runMigrations(
        source,
        new URL("../src/db/migrations", import.meta.url).pathname,
        () => undefined
      );
      await source.query(
        "INSERT INTO tenants(name,status,timezone) VALUES($1,'active','UTC')",
        [`Backup source ${randomUUID()}`]
      );
    } finally {
      await source.end();
    }
  }, 30_000);

  afterAll(async () => {
    if (admin) {
      await admin.query(`DROP DATABASE IF EXISTS "${sourceDatabase}"`).catch(() => undefined);
      await admin.query(`DROP DATABASE IF EXISTS "${targetDatabase}"`).catch(() => undefined);
      await admin.end().catch(() => undefined);
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("creates a custom backup, restores it, verifies invariants and drops only its exact disposable target", async () => {
    const backup = await createDatabaseBackup({
      databaseUrl: sourceUrl,
      outputDirectory: directory,
      deployVersion: "integration-test",
      pgDumpBinary: pgDumpWrapper,
      now: new Date("2026-07-25T12:00:00.000Z")
    });
    expect(backup.manifest).toMatchObject({
      deployVersion: "integration-test",
      source: { database: sourceDatabase },
      dump: { format: "custom", noOwner: true, noAcl: true }
    });
    expect(backup.manifest.migrations.latest).toMatch(/^\d{4}_/);
    expect(backup.manifest.tableCounts.tenants).toBe(1);
    const manifestText = await readFile(backup.manifestFile, "utf8");
    const sourcePassword = decodeURIComponent(new URL(sourceUrl).password);
    expect(manifestText).not.toContain(sourcePassword);
    expect(manifestText).not.toContain("Backup source");
    expect((await stat(backup.dumpFile)).mode & 0o777).toBe(0o600);
    expect((await stat(backup.manifestFile)).mode & 0o777).toBe(0o600);
    expect(createHash("sha256").update(await readFile(backup.dumpFile)).digest("hex"))
      .toBe(backup.manifest.dump.sha256);

    const reportFile = join(directory, "restore-report.json");
    const report = await verifyDatabaseRestore({
      manifestFile: backup.manifestFile,
      adminDatabaseUrl: adminUrl,
      targetDatabase,
      reportFile,
      cleanup: true,
      confirmDrop: targetDatabase,
      pgRestoreBinary: pgRestoreWrapper
    });
    expect(report).toMatchObject({
      success: true,
      target: { database: targetDatabase },
      cleanup: { requested: true, completed: true },
      migrations: {
        expectedLatest: backup.manifest.migrations.latest,
        actualLatest: backup.manifest.migrations.latest
      },
      tableCounts: {
        tenants: { expected: 1, actual: 1, matches: true }
      },
      constraints: {
        invalid: 0,
        invalidForeignKeys: 0
      }
    });
    expect(report.constraints.foreignKeys).toBeGreaterThan(0);
    expect((await admin.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1) exists",
      [targetDatabase]
    )).rows[0].exists).toBe(false);
    expect(await readFile(reportFile, "utf8")).not.toContain(sourcePassword);
  }, 30_000);
});
