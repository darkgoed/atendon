/* Fixtures v6 — superfícies novas (tarefas, campos, lixeira, importar, fluxos)
   + endpoints hidratados pelo Shell em todas as rotas (aparência, sino de
   notificações internas, preferências de notificação). Formas espelham o
   backend real: /qualification/flows usa nome/ativo/atualizado_em (flowMapper),
   /me/appearance-preferences devolve o objeto direto (sem wrapper
   `preferences`) e /me/notification-preferences é o wrapper
   { preferences, muted_conversations } estendido com sound_key/volume.
   Listagens de tarefas/campos/lixeira/importações nascem SEMEOADAS com 1 item:
   os contratos apontam para o article da listagem e o gate "missing seeded
   nonempty entity marker" exige conteúdo renderizável. */

const flowDefinition = { start: "P1", steps: { P1: { kind: "message", message: "Olá QA", next: "F1" }, F1: { kind: "final", message: "Fim QA" } } };
const flow = { id: "qa-flow-0001", nome: "Fluxo QA de qualificação", ativo: false, definition: flowDefinition, atualizado_em: "2026-09-18T12:00:00Z" };
const task = { id: "qa-task-0001", title: "Tarefa QA", description: "", status: "aberta", priority: "media", due_at: null, assignee: null, lead: null, created_by: "qa", created_at: "2026-09-18T12:00:00Z", updated_at: "2026-09-18T12:00:00Z", completed_at: null };
const customField = { id: "qa-field-0001", key: "campo_qa", label: "Campo QA", type: "text", options: null, required: false, created_at: "2026-09-18T12:00:00Z" };
const trashItem = { id: "qa-trash-0001", name: "Lead QA", phone: "5511900000000", status: "novo", deleted_at: "2026-09-18T12:00:00Z", deleted_by: "qa", created_at: "2026-09-18T12:00:00Z" };

export function panelsV6Fixture(path) {
  if (path === "/me/appearance-preferences") return { theme: null, accent: null, density: null };
  if (path === "/me/internal-notifications" || path.startsWith("/me/internal-notifications?")) return { items: [], total_unread: 0, page: { has_more: false, next_cursor: null } };
  if (path === "/me/notification-preferences") return { preferences: { enabled: true, sound_enabled: true, visual_enabled: true, sound_key: null, volume: null }, muted_conversations: [] };
  if (path === "/organization/storage") return { storage: { used_bytes: 1048576, quota_bytes: 5368709120, retention_days: null, per_origem: [{ origem: "figurinhas_ia", bytes: 4096, itens: 1 }, { origem: "logo_workspace", bytes: 240, itens: 1 }] } };
  if (path === "/tasks" || path.startsWith("/tasks?")) return { items: [task], total: 1, page: { limit: 30, has_more: false, next_cursor: null } };
  if (path === "/organization/custom-fields") return { fields: [customField] };
  if (path === "/trash" || path.startsWith("/trash?")) return { items: [trashItem], page: { limit: 30, has_more: false, next_cursor: null } };
  if (path === "/organization/leads/import/history") return { imports: [] };
  if (path === "/leads/qa-lead-0001/notes" || path.startsWith("/leads/qa-lead-0001/notes?")) return { items: [] };
  if (path === "/organization/leads/qa-lead-0001/custom-values") return { items: [] };
  if (path === "/qualification/flows") return { flows: [flow] };
  if (path === "/qualification/flows/qa-flow-0001") return { flow };
}

export { flow };
