import { config } from "../config.js";
import { db } from "./client.js";
import { rotateGoogleMeetDataKeys, rotateOpenRouterDataKeys } from "./data-key-rotation.js";

const client = await db.connect();
try {
  const result = await rotateOpenRouterDataKeys(client, {
    current: config.DATA_ENCRYPTION_KEY,
    previous: config.DATA_ENCRYPTION_KEY_PREVIOUS ? [config.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
    legacy: [config.JWT_SECRET]
  });
  console.log(`OpenRouter data keys rotated: ${result.rotated}; unchanged: ${result.unchanged}`);
  const meetResult = await rotateGoogleMeetDataKeys(client, {
    current: config.DATA_ENCRYPTION_KEY,
    previous: config.DATA_ENCRYPTION_KEY_PREVIOUS ? [config.DATA_ENCRYPTION_KEY_PREVIOUS] : [],
    legacy: [config.JWT_SECRET]
  });
  console.log(`Google Meet data keys rotated: ${meetResult.rotated}; unchanged: ${meetResult.unchanged}`);
} finally {
  client.release();
  await db.end();
}
