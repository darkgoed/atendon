import { fileURLToPath } from "node:url";
import pg from "pg";
import { runMigrations } from "../src/db/migration-runner.js";
import { resolveTestDatabaseUrl } from "./test-database.js";
import { loadTestEnvironment } from "./test-environment.js";

loadTestEnvironment();

const databaseUrl = resolveTestDatabaseUrl(process.env);
const directory = fileURLToPath(new URL("../src/db/migrations", import.meta.url));
const client = new pg.Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await runMigrations(client, directory);
  // Legacy integration fixtures insert tenants directly instead of exercising
  // the ROOT template workflow. Keep that shortcut test-only: newly inserted
  // synthetic tenants inherit the historically available general modules,
  // while production remains fail-closed and template-driven.
  await client.query(`
    CREATE OR REPLACE FUNCTION test_enable_legacy_capabilities()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO tenant_feature_flag_overrides(tenant_id,flag_key,enabled)
      VALUES
        (NEW.id,'dashboard_v1',true),
        (NEW.id,'leads_v1',true),
        (NEW.id,'pipeline_v1',true),
        (NEW.id,'appointments_v1',true),
        (NEW.id,'workspace_admin_v1',true)
      ON CONFLICT(tenant_id,flag_key) DO NOTHING;
      RETURN NEW;
    END $$;
    DROP TRIGGER IF EXISTS test_tenants_enable_legacy_capabilities ON tenants;
    CREATE TRIGGER test_tenants_enable_legacy_capabilities
      AFTER INSERT ON tenants
      FOR EACH ROW EXECUTE FUNCTION test_enable_legacy_capabilities();
  `);
} finally {
  await client.end();
}
