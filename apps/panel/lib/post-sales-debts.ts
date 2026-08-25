import { formatBrazilianPhone } from "./phone";

export type PostSaleDebt = {
  id: string;
  store: string;
  customer_name: string;
  phone_raw: string | null;
  phone_e164: string | null;
  reference_date: string | null;
  amount_open: number | null;
  amount_recovered: number | null;
  status: string | null;
  contact_method: string | null;
  payment_method: string | null;
  reason: string | null;
  promise_date: string | null;
  notes: string | null;
  days_without_contact: number | null;
  alert: string | null;
  created_at: string;
};

export type PostSaleDebtsSummary = {
  total: number;
  paid: number;
  amount_open_total: number;
  amount_recovered_total: number;
};

export type PostSaleDebtFilters = { q: string; store: string; status: string };
export const EMPTY_POST_SALE_DEBT_FILTERS: PostSaleDebtFilters = { q: "", store: "", status: "" };

export function buildPostSaleDebtsQuery(filters: PostSaleDebtFilters) {
  const query = new URLSearchParams();
  const search = filters.q.trim();
  if (search) query.set("q", search);
  if (filters.store) query.set("store", filters.store);
  if (filters.status) query.set("status", filters.status);
  return query.toString();
}

export function formatPostSaleDebtPhone(phone: string | null) {
  if (!phone) return "—";
  if (phone.startsWith("55") && (phone.length === 12 || phone.length === 13)) {
    return `+55 ${formatBrazilianPhone(phone.slice(2))}`;
  }
  return `+${phone}`;
}

export function formatPostSaleDebtAmount(value: number | null) {
  if (value === null) return "—";
  return value.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

export function formatPostSaleDebtDate(value: string | null) {
  if (!value) return "—";
  return new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR");
}
