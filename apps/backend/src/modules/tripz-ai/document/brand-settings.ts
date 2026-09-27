// Brand editorial por tenant (Wave B): cache 60s + fallback identidade Tripz.
// Fonte de verdade: tripz_ai_brand_settings (migração 0196). Tenants fora do
// grupo Tripz NUNCA recebem os tokens da identidade Tripz (TRIPZ_IDENTITY_LEAK).
import type pg from "pg";
import {
  NEUTRAL_PROPOSAL_BRAND,
  TRIPZ_PROPOSAL_BRAND,
  isTripzTenantName,
  proposalBrandConfigSchema,
  type ProposalBrandConfig
} from "@atendon/proposal-renderer";
import { TripzAiError } from "../domain.js";

export type TripzBrandDatabase = Pick<pg.Pool, "query">;

interface CachedBrand {
  expiresAt: number;
  value: ProposalBrandConfig;
}

const BRAND_CACHE_TTL_MS = 60_000;
const TRIPZ_PRIMARY_TOKEN = "#123047";
const CACHE_INVALID = "TRIPZ_BRAND_CONFIG_INVALID";
const CACHE_LEAK = "TRIPZ_IDENTITY_LEAK";

const brandCache = new Map<string, CachedBrand>();

/** TODO(wave-c): repository.ts expõe o pool como campo privado; acesso pontual aqui. */
export function tripzBrandDatabase(repository: object): TripzBrandDatabase {
  const database = (repository as { database?: TripzBrandDatabase }).database;
  if (!database || typeof database.query !== "function") {
    throw new TripzAiError(503, "TRIPZ_BRAND_DB_UNAVAILABLE", "Conexão com banco indisponível para brand");
  }
  return database;
}

async function tenantName(database: TripzBrandDatabase, tenantId: string): Promise<string | null> {
  const result = await database.query<{ name: string | null }>(
    "SELECT name FROM tenants WHERE id=$1",
    [tenantId]
  );
  return result.rows[0]?.name ?? null;
}

function parseBrandConfig(raw: unknown): ProposalBrandConfig | null {
  const parsed = proposalBrandConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function loadTripzBrandSettings(
  database: TripzBrandDatabase,
  tenantId: string
): Promise<ProposalBrandConfig | null> {
  const result = await database.query<{ config: unknown }>(
    "SELECT config FROM tripz_ai_brand_settings WHERE tenant_id=$1",
    [tenantId]
  );
  return parseBrandConfig(result.rows[0]?.config ?? null);
}

/**
 * Brand STRICT do tenant Tripz: linha salva OU identidade Tripz aprovada.
 * Nunca cai no default neutro — se a linha está ausente/corrompida, a
 * identidade Tripz é o fallback contratual (SPEC Wave B).
 */
export async function getTripzBrandSettings(
  database: TripzBrandDatabase,
  tenantId: string
): Promise<ProposalBrandConfig> {
  return (await loadTripzBrandSettings(database, tenantId)) ?? TRIPZ_PROPOSAL_BRAND;
}

function cacheBrand(tenantId: string, value: ProposalBrandConfig): ProposalBrandConfig {
  brandCache.set(tenantId, { expiresAt: Date.now() + BRAND_CACHE_TTL_MS, value });
  return value;
}

/**
 * Brand por tenant: linha salva vence; sem linha, tenant Tripz usa a
 * identidade Tripz e qualquer outro tenant usa o default neutro.
 */
export async function getBrandSettings(
  database: TripzBrandDatabase,
  tenantId: string
): Promise<ProposalBrandConfig> {
  const cached = brandCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [name, saved] = await Promise.all([
    tenantName(database, tenantId),
    loadTripzBrandSettings(database, tenantId)
  ]);
  if (saved) return cacheBrand(tenantId, saved);
  return cacheBrand(tenantId, isTripzTenantName(name) ? TRIPZ_PROPOSAL_BRAND : NEUTRAL_PROPOSAL_BRAND);
}

/**
 * Salva o brand do tenant com invariantes:
 * 1) config valida contra proposalBrandConfigSchema (422 inválido);
 * 2) tenant fora do grupo Tripz não pode adotar o token primário da
 *    identidade Tripz (409 TRIPZ_IDENTITY_LEAK);
 * 3) write sempre tenant-scoped e invalida o cache.
 */
export async function upsertTripzBrandSettings(
  database: TripzBrandDatabase,
  tenantId: string,
  config: unknown
): Promise<ProposalBrandConfig> {
  const parsed = proposalBrandConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw new TripzAiError(422, CACHE_INVALID, "Configuração de brand inválida");
  }
  const name = await tenantName(database, tenantId);
  if (parsed.data.tokens.primary === TRIPZ_PRIMARY_TOKEN && !isTripzTenantName(name)) {
    throw new TripzAiError(409, CACHE_LEAK, "Identidade Tripz não pode ser aplicada a outro tenant");
  }
  await database.query(
    `INSERT INTO tripz_ai_brand_settings(tenant_id,config)
     VALUES($1,$2)
     ON CONFLICT(tenant_id) DO UPDATE SET config=$2, updated_at=now()`,
    [tenantId, JSON.stringify(parsed.data)]
  );
  brandCache.delete(tenantId);
  return parsed.data;
}

export function clearBrandSettingsCache(tenantId?: string): void {
  if (tenantId) brandCache.delete(tenantId);
  else brandCache.clear();
}
