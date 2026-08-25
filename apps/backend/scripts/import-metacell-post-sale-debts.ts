import { readFileSync } from "node:fs";
import pg from "pg";
import { config } from "../src/config.js";
import { normalizePhoneE164 } from "../src/phone.js";

const TENANT_ID = "f9a3eeeb-edee-4ceb-8aba-d798ab2f428a"; // Meta Cell IA
const SOURCE_PATH = new URL("../../../comments.md", import.meta.url);

function parseDate(value: string, fallbackYear = 2026): string | null {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/?(\d{4})?$/);
  if (!match) return null;
  const [, day, month, year] = match;
  return `${year ?? fallbackYear}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
}

function parseAmount(value: string): number | null {
  const cleaned = value.trim().replace(/^R\$\s*/, "").replace(/\./g, "").replace(",", ".");
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function parseInt10(value: string): number | null {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) : null;
}

function parsePhone(value: string): string | null {
  try {
    return normalizePhoneE164(value);
  } catch {
    return null;
  }
}

const nullIfEmpty = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

const lines = readFileSync(SOURCE_PATH, "utf8").split("\n").filter((line) => line.trim());
const [, ...rows] = lines;

const client = new pg.Client({ connectionString: config.DATABASE_URL });
await client.connect();
try {
  await client.query("BEGIN");
  let inserted = 0;
  for (const line of rows) {
    const cols = line.split("\t");
    const [
      data, loja, cliente, telefone, valorAberto, valorRecuperado, status,
      formaContato, formaPagamento, motivo, dataPromessa, observacao, diasSemContato, alerta
    ] = cols;
    if (!loja?.trim() || !cliente?.trim()) continue;

    await client.query(
      `INSERT INTO post_sale_debts (
        tenant_id, store, customer_name, phone_raw, phone_e164, reference_date,
        amount_open, amount_recovered, status, contact_method, payment_method,
        reason, promise_date, notes, days_without_contact, alert
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [
        TENANT_ID,
        loja.trim(),
        cliente.trim(),
        nullIfEmpty(telefone),
        telefone?.trim() ? parsePhone(telefone) : null,
        data?.trim() ? parseDate(data) : null,
        valorAberto?.trim() ? parseAmount(valorAberto) : null,
        valorRecuperado?.trim() ? parseAmount(valorRecuperado) : null,
        nullIfEmpty(status),
        nullIfEmpty(formaContato),
        nullIfEmpty(formaPagamento),
        nullIfEmpty(motivo),
        dataPromessa?.trim() ? parseDate(dataPromessa) : null,
        nullIfEmpty(observacao),
        diasSemContato?.trim() ? parseInt10(diasSemContato) : null,
        nullIfEmpty(alerta)
      ]
    );
    inserted++;
  }
  await client.query("COMMIT");
  console.log(JSON.stringify({ ok: true, inserted }));
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
