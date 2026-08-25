import { config } from "../src/config.js";
import { db } from "../src/db/client.js";
import { recordDeploymentFeatureFlagSnapshot } from "../src/modules/operations/deployment-snapshots.js";

try {
  const snapshot = await recordDeploymentFeatureFlagSnapshot(db, config.DEPLOY_VERSION);
  console.log(JSON.stringify({
    status: snapshot.created ? "created" : "already_recorded",
    deployVersion: snapshot.deployVersion,
    latestMigration: snapshot.latestMigration,
    snapshotHash: snapshot.snapshotHash
  }));
} finally {
  await db.end();
}
