import type { Pool, PoolClient } from "pg";
import { encryptSecret, decryptSecret } from "../ai-router/secret-box.js";

export interface ChangelogAiSettings {
  hasApiKey: boolean;
  apiKeyHint: string | null;
  primaryModel: string;
  fallbackModel: string | null;
  autoGenerateEnabled: boolean;
  autoPublishEnabled: boolean;
  updatedAt: string;
}

export interface ChangelogAiCredentials {
  apiKey: string;
  primaryModel: string;
  fallbackModel: string | null;
}

interface ChangelogAiSettingsRow {
  api_key_encrypted: string | null;
  api_key_hint: string | null;
  primary_model: string;
  fallback_model: string | null;
  auto_generate_enabled: boolean;
  auto_publish_enabled: boolean;
  updated_at: Date | string;
}

function hint(apiKey: string): string {
  return `••••${apiKey.slice(-4)}`;
}

function toPublicSettings(row: ChangelogAiSettingsRow): ChangelogAiSettings {
  return {
    hasApiKey: row.api_key_encrypted != null,
    apiKeyHint: row.api_key_hint,
    primaryModel: row.primary_model,
    fallbackModel: row.fallback_model,
    autoGenerateEnabled: row.auto_generate_enabled,
    autoPublishEnabled: row.auto_publish_enabled,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

/** Never selects api_key_encrypted into a response payload; only this module
 * decrypts it, and only for the outbound OpenRouter call. */
export async function getChangelogAiSettings(db: Pick<Pool, "query">): Promise<ChangelogAiSettings> {
  const result = await db.query<ChangelogAiSettingsRow>(
    `SELECT api_key_encrypted,api_key_hint,primary_model,fallback_model,
            auto_generate_enabled,auto_publish_enabled,updated_at
     FROM changelog_ai_settings WHERE id=true`
  );
  if (!result.rows[0]) throw new Error("changelog_ai_settings singleton is missing");
  return toPublicSettings(result.rows[0]);
}

export async function getChangelogAiCredentials(
  db: Pick<Pool, "query">,
  encryptionKey: string
): Promise<ChangelogAiCredentials | null> {
  const result = await db.query<ChangelogAiSettingsRow>(
    `SELECT api_key_encrypted,api_key_hint,primary_model,fallback_model,
            auto_generate_enabled,auto_publish_enabled,updated_at
     FROM changelog_ai_settings WHERE id=true`
  );
  const row = result.rows[0];
  if (!row?.api_key_encrypted) return null;
  return {
    apiKey: decryptSecret(row.api_key_encrypted, encryptionKey),
    primaryModel: row.primary_model,
    fallbackModel: row.fallback_model
  };
}

export interface UpdateChangelogAiSettingsInput {
  apiKey?: string;
  clearApiKey?: boolean;
  primaryModel?: string;
  fallbackModel?: string | null;
  autoGenerateEnabled?: boolean;
  autoPublishEnabled?: boolean;
}

export async function updateChangelogAiSettings(
  db: Pick<Pool, "connect">,
  encryptionKey: string,
  input: UpdateChangelogAiSettingsInput,
  userId: string
): Promise<ChangelogAiSettings> {
  const client: PoolClient = await db.connect();
  try {
    await client.query("BEGIN");
    const current = await client.query<ChangelogAiSettingsRow>(
      "SELECT * FROM changelog_ai_settings WHERE id=true FOR UPDATE"
    );
    if (!current.rows[0]) throw new Error("changelog_ai_settings singleton is missing");

    const nextEncrypted = input.clearApiKey
      ? null
      : input.apiKey
        ? encryptSecret(input.apiKey, encryptionKey)
        : current.rows[0].api_key_encrypted;
    const nextHint = input.clearApiKey
      ? null
      : input.apiKey
        ? hint(input.apiKey)
        : current.rows[0].api_key_hint;

    const updated = await client.query<ChangelogAiSettingsRow>(
      `UPDATE changelog_ai_settings SET
         api_key_encrypted=$1,
         api_key_hint=$2,
         primary_model=COALESCE($3,primary_model),
         fallback_model=CASE WHEN $4::boolean THEN $5 ELSE fallback_model END,
         auto_generate_enabled=COALESCE($6,auto_generate_enabled),
         auto_publish_enabled=COALESCE($7,auto_publish_enabled),
         updated_by_user_id=$8,
         updated_at=now()
       WHERE id=true
       RETURNING *`,
      [
        nextEncrypted,
        nextHint,
        input.primaryModel ?? null,
        input.fallbackModel !== undefined,
        input.fallbackModel ?? null,
        input.autoGenerateEnabled ?? null,
        input.autoPublishEnabled ?? null,
        userId
      ]
    );
    await client.query("COMMIT");
    return toPublicSettings(updated.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
