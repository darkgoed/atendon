import { member, rootSession, workspace } from "./session.mjs";

const workspaceB = {
  ...workspace,
  id: "qa-workspace-0002",
  name: "AtendON QA Norte",
  slug: "atendon-qa-norte",
  status: "trial",
  attendant_phone: null,
  created_at: "2026-08-19T12:00:00.000Z",
  updated_at: "2026-08-20T12:00:00.000Z",
  member_count: 2,
  pending_invites: 0
};
const workspaceA = {
  ...workspace,
  attendant_phone: "+5511999990001",
  created_at: "2026-08-18T12:00:00.000Z",
  updated_at: "2026-08-20T12:00:00.000Z",
  member_count: 3,
  pending_invites: 1
};

const plans = [
  {
    id: "qa-plan-0001", code: "PROFISSIONAL", name: "Profissional", description: "Para operações em crescimento.",
    status: "active", monthly_price_cents: 19900, setup_price_cents: 0, currency: "BRL",
    billing_period_months: 1, trial_days: 14, grace_period_days: 7, is_internal: false, position: 1,
    features: [{ plan_id: "qa-plan-0001", feature_key: "whatsapp", enabled: true }],
    limits: [{ plan_id: "qa-plan-0001", limit_key: "MAX_USERS", limit_value: 10 }]
  },
  {
    id: "qa-plan-0002", code: "STARTER", name: "Starter", description: "Para equipes pequenas.",
    status: "active", monthly_price_cents: 9900, setup_price_cents: 0, currency: "BRL",
    billing_period_months: 1, trial_days: 7, grace_period_days: 7, is_internal: false, position: 2,
    features: [{ plan_id: "qa-plan-0002", feature_key: "whatsapp", enabled: true }],
    limits: [{ plan_id: "qa-plan-0002", limit_key: "MAX_USERS", limit_value: 5 }]
  }
];
const catalog = {
  feature_catalog: [{ feature_key: "whatsapp", label: "WhatsApp", description: "Conexões WhatsApp" }],
  limit_catalog: [{ limit_key: "MAX_USERS", label: "Usuários", description: "Usuários ativos" }]
};
const tenants = [
  { id: workspaceA.id, name: workspaceA.name, status: "active", subscription_status: "ACTIVE", plan_code: "PROFISSIONAL", plan_name: "Profissional", entitlements: { limits: { MAX_USERS: 10, MAX_WHATSAPP_CONNECTIONS: 2, MAX_AI_INTERACTIONS: 1000 } }, usage: { MAX_USERS: 3, MAX_WHATSAPP_CONNECTIONS: 1, MAX_AI_INTERACTIONS: 42 } },
  { id: workspaceB.id, name: workspaceB.name, status: "trial", subscription_status: "TRIALING", plan_code: "STARTER", plan_name: "Starter", entitlements: { limits: { MAX_USERS: 5, MAX_WHATSAPP_CONNECTIONS: 1, MAX_AI_INTERACTIONS: 300 } }, usage: { MAX_USERS: 2, MAX_WHATSAPP_CONNECTIONS: 0, MAX_AI_INTERACTIONS: 18 } }
];
const invoices = [
  { id: "qa-invoice-0001", tenant_id: workspaceA.id, tenant_name: workspaceA.name, subscription_id: "qa-subscription-0001", provider_id: "qa-provider-0001", external_id: "mp-qa-0001", kind: "SUBSCRIPTION", amount_cents: "19900", currency: "BRL", status: "paid", due_date: "2026-08-10T00:00:00.000Z", period_start: "2026-08-01T00:00:00.000Z", period_end: "2026-08-31T23:59:59.000Z", paid_at: "2026-08-08T12:00:00.000Z", created_at: "2026-08-01T12:00:00.000Z", payments: [{ id: "qa-payment-0001", status: "paid", amount_cents: "19900", method: "pix", paid_at: "2026-08-08T12:00:00.000Z" }] },
  { id: "qa-invoice-0002", tenant_id: workspaceB.id, tenant_name: workspaceB.name, subscription_id: "qa-subscription-0002", provider_id: "qa-provider-0001", external_id: null, kind: "SUBSCRIPTION", amount_cents: "9900", currency: "BRL", status: "open", due_date: "2026-09-10T00:00:00.000Z", period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-09-30T23:59:59.000Z", paid_at: null, created_at: "2026-09-01T12:00:00.000Z", payments: [] }
];
const providers = [
  { id: "qa-provider-0001", code: "mercadopago", name: "Mercado Pago", environment: "sandbox", status: "connected", enabled: true, credentials_hint: "conta-qa-sandbox", has_webhook_secret: true, commercial_config: {} },
  { id: "qa-provider-0002", code: "mercadopago", name: "Mercado Pago", environment: "production", status: "Não conectado", enabled: false, credentials_hint: null, has_webhook_secret: false, commercial_config: {} }
];
const auditLogs = [
  { id: "qa-log-0001", workspace_id: workspaceA.id, workspace_name: workspaceA.name, actor_scope: "root", action: "workspace.viewed", resource_type: "workspace", resource_id: workspaceA.id, metadata: { source: "design-audit" }, created_at: "2026-08-20T12:00:00.000Z", actor_email: "root@example.test" },
  { id: "qa-log-0002", workspace_id: workspaceB.id, workspace_name: workspaceB.name, actor_scope: "root", action: "saas.plan.viewed", resource_type: "plan", resource_id: "qa-plan-0002", metadata: { source: "design-audit" }, created_at: "2026-08-19T12:00:00.000Z", actor_email: "root@example.test" }
];
const metrics = [
  { tenantId: workspaceA.id, planId: "qa-plan-0001", month: "2026-08", includedGranted: 100, includedUsed: 80, rolloverGenerated: 0, rolloverUsed: 0, rolloverExpired: 0, bonusGranted: 0, bonusUsed: 0, overageInteractions: 2, overageRevenueCents: 1000, providerCostUsdMicros: 0, providerCostBrlCents: 300 },
  { tenantId: workspaceB.id, planId: "qa-plan-0002", month: "2026-09", includedGranted: 50, includedUsed: 30, rolloverGenerated: 0, rolloverUsed: 0, rolloverExpired: 0, bonusGranted: 0, bonusUsed: 0, overageInteractions: 1, overageRevenueCents: 500, providerCostUsdMicros: 0, providerCostBrlCents: 200 }
];
const roles = [
  { id: "qa-role-0001", name: "Administrador", description: "Administra o workspace.", is_owner_role: false, is_system: true, permissions: ["dashboard.read", "members.read"], member_count: 1 },
  { id: "qa-role-0002", name: "Operador", description: "Atende conversas.", is_owner_role: false, is_system: false, permissions: ["dashboard.read"], member_count: 1 }
];
const permissions = [
  { key: "dashboard.read", module: "dashboard", action: "read", description: "Visualizar o painel" },
  { key: "members.read", module: "members", action: "read", description: "Visualizar membros" }
];
const members = [
  { id: member.id, status: "active", joined_at: "2026-08-01T12:00:00.000Z", created_at: "2026-08-01T12:00:00.000Z", user_id: member.user_id, name: member.name.trim(), email: member.email.trim(), user_status: "active", is_root: false, must_change_password: false, role_id: roles[0].id, role_name: roles[0].name, is_owner_role: false },
  { id: "qa-member-0002", status: "active", joined_at: "2026-08-02T12:00:00.000Z", created_at: "2026-08-02T12:00:00.000Z", user_id: "qa-member-user-2", name: "Bruno QA", email: "bruno@example.test", user_status: "active", is_root: false, must_change_password: false, role_id: roles[1].id, role_name: roles[1].name, is_owner_role: false }
];
const invitations = [{ id: "qa-invite-0001", email: "invitee@example.test", status: "pending", expires_at: "2026-09-30T12:00:00.000Z", created_at: "2026-09-01T12:00:00.000Z", accepted_at: null, role_id: roles[1].id, role_name: roles[1].name, invited_by_email: "root@example.test", accepted_by_email: null }];
const dunning = [{ id: "qa-dunning-0001", tenant_id: workspaceB.id, invoice_id: invoices[1].id, attempt_number: 1, status: "FAILED", error_code: "provider:declined", next_attempt_at: "2026-09-11T12:00:00.000Z", created_at: "2026-09-10T12:00:00.000Z", invoice_status: "open", amount_cents: "9900", due_date: invoices[1].due_date }, { id: "qa-dunning-0002", tenant_id: workspaceA.id, invoice_id: invoices[0].id, attempt_number: 1, status: "SUCCEEDED", error_code: null, next_attempt_at: null, created_at: "2026-08-08T12:00:00.000Z", invoice_status: "paid", amount_cents: "19900", due_date: invoices[0].due_date }];

export function rootFixture(path) {
  if (path === "/root/workspaces" || path === "/root/saas/tenants") return path === "/root/workspaces" ? { workspaces: [workspaceA, workspaceB] } : { tenants };
  if (path === "/root/audit" || path === "/root/audit-logs" || path === "/workspaces/current/audit-logs") return { auditLogs };
  if (path === "/root/saas/catalog") return catalog;
  if (path === "/root/saas/plans") return { plans };
  if (path === "/root/saas/billing" || path.startsWith("/root/billing/invoices")) return { invoices };
  if (path === "/root/saas/gateways" || path === "/root/billing/providers") return { providers };
  if (path === "/root/saas/metricas" || path === "/root/billing/metrics") return { metrics };
  if (path === "/root/saas/events") return { events: [{ id: "qa-event-0001", event_type: "PLAN_CHANGED", from_status: "TRIALING", to_status: "ACTIVE", created_at: "2026-08-20T12:00:00.000Z", metadata: { source: "design-audit" } }, { id: "qa-event-0002", event_type: "PAYMENT_APPROVED", from_status: null, to_status: "ACTIVE", created_at: "2026-08-08T12:00:00.000Z", metadata: {} }] };
  if (path === "/root/billing/dunning") return { attempts: dunning, page: 1, limit: 25 };
  if (path.startsWith("/root/billing/ledger")) return { entries: [{ id: "qa-ledger-0001", tenant_id: workspaceA.id, entry_type: "charge", amount_cents: 19900, created_at: "2026-08-08T12:00:00.000Z" }, { id: "qa-ledger-0002", tenant_id: workspaceB.id, entry_type: "charge", amount_cents: 9900, created_at: "2026-09-10T12:00:00.000Z" }], page: 1, limit: 25 };
  if (path.startsWith("/root/billing/fraud-signals")) return { signals: [{ id: "qa-fraud-0001", tenant_id: workspaceB.id, signal_type: "velocity", severity: "medium", created_at: "2026-09-10T12:00:00.000Z" }, { id: "qa-fraud-0002", tenant_id: workspaceA.id, signal_type: "mismatch", severity: "low", created_at: "2026-08-08T12:00:00.000Z" }], page: 1, limit: 25 };
  if (path.startsWith("/root/billing/coupons")) return { coupons: [{ id: "qa-coupon-0001", code: "QA10", discount_type: "PERCENT", discount_value: 10, starts_at: "2026-08-01T00:00:00.000Z", expires_at: null, max_redemptions: 100, redemption_count: 2, eligibility: {}, active: true, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T00:00:00.000Z" }], page: 1, limit: 25 };
  if (path === "/workspaces/current/members") return { members };
  if (path === "/workspaces/current/member-roles" || path === "/workspaces/current/roles") return { roles, permissions };
  if (path === "/workspaces/current/invitations") return { invitations };
  if (path.includes("/timezone")) return { timezone: workspace.timezone };
}
export { rootSession };
