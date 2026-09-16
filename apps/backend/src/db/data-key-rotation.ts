import type { SecretKeyring } from "../modules/ai-router/secret-box.js";
import { decryptSecret, encryptedSecretNeedsRotation, encryptSecret } from "../modules/ai-router/secret-box.js";

interface RotationClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export interface RotationResult {
  rotated: number;
  unchanged: number;
}

export async function rotateOpenRouterDataKeys(client: RotationClient, keyring: SecretKeyring): Promise<RotationResult> {
  await client.query("BEGIN");
  try {
    const result = await client.query(
      `SELECT tenant_id,openrouter_api_key_encrypted
       FROM tenant_ai_settings
       WHERE openrouter_api_key_encrypted IS NOT NULL
       ORDER BY tenant_id
       FOR UPDATE`
    ) as { rows: Array<{ tenant_id: string; openrouter_api_key_encrypted: string }> };
    let rotated = 0;
    let unchanged = 0;

    for (const row of result.rows) {
      if (!encryptedSecretNeedsRotation(row.openrouter_api_key_encrypted, keyring.current)) {
        unchanged += 1;
        continue;
      }
      const plaintext = decryptSecret(row.openrouter_api_key_encrypted, keyring);
      const replacement = encryptSecret(plaintext, keyring.current);
      await client.query(
        `UPDATE tenant_ai_settings
         SET openrouter_api_key_encrypted=$3,updated_at=now()
         WHERE tenant_id=$1 AND openrouter_api_key_encrypted=$2`,
        [row.tenant_id, row.openrouter_api_key_encrypted, replacement]
      );
      rotated += 1;
    }

    await client.query("COMMIT");
    return { rotated, unchanged };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function rotateGoogleMeetDataKeys(client: RotationClient, keyring: SecretKeyring): Promise<RotationResult> {
  await client.query("BEGIN");
  try {
    const result = await client.query(
      `SELECT tenant_id,oauth_refresh_token_encrypted
       FROM scheduling_google_meet_settings
       WHERE oauth_refresh_token_encrypted IS NOT NULL
       ORDER BY tenant_id
       FOR UPDATE`
    ) as { rows: Array<{ tenant_id: string; oauth_refresh_token_encrypted: string }> };
    let rotated = 0;
    let unchanged = 0;

    for (const row of result.rows) {
      if (!encryptedSecretNeedsRotation(row.oauth_refresh_token_encrypted, keyring.current)) {
        unchanged += 1;
        continue;
      }
      const plaintext = decryptSecret(row.oauth_refresh_token_encrypted, keyring);
      const replacement = encryptSecret(plaintext, keyring.current);
      await client.query(
        `UPDATE scheduling_google_meet_settings
         SET oauth_refresh_token_encrypted=$3,updated_at=now()
         WHERE tenant_id=$1 AND oauth_refresh_token_encrypted=$2`,
        [row.tenant_id, row.oauth_refresh_token_encrypted, replacement]
      );
      rotated += 1;
    }

    await client.query("COMMIT");
    return { rotated, unchanged };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function rotateInstagramDataKeys(client: RotationClient, keyring: SecretKeyring): Promise<RotationResult> {
  await client.query("BEGIN");
  try {
    const result = await client.query(
      `SELECT id,tenant_id,credentials_encrypted
       FROM whatsapp_sessions
       WHERE channel='instagram' AND credentials_encrypted IS NOT NULL
       ORDER BY tenant_id,id
       FOR UPDATE`
    ) as { rows: Array<{ id: string; tenant_id: string; credentials_encrypted: string }> };
    let rotated = 0;
    let unchanged = 0;

    for (const row of result.rows) {
      if (!encryptedSecretNeedsRotation(row.credentials_encrypted, keyring.current)) {
        unchanged += 1;
        continue;
      }
      const plaintext = decryptSecret(row.credentials_encrypted, keyring);
      const replacement = encryptSecret(plaintext, keyring.current);
      await client.query(
        `UPDATE whatsapp_sessions
         SET credentials_encrypted=$4
         WHERE id=$1 AND tenant_id=$2 AND credentials_encrypted=$3`,
        [row.id, row.tenant_id, row.credentials_encrypted, replacement]
      );
      rotated += 1;
    }

    await client.query("COMMIT");
    return { rotated, unchanged };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
