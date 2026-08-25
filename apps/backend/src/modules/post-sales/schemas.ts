import { z } from "zod";
import { phoneE164Schema } from "../../phone.js";

export const postSaleIdParams = z.object({ id: z.string().uuid() }).strict();
export const postSaleChecklistEntryParams = z.object({
  clientId: z.string().uuid(),
  entryId: z.string().uuid()
}).strict();
export const postSaleTemplateItemParams = z.object({ id: z.string().uuid() }).strict();

const optionalEmail = z.string().trim().email().max(320).nullable().optional();
const optionalNotes = z.string().trim().max(10_000).nullable().optional();
const responsibleMemberId = z.string().uuid().nullable().optional();

function validNextActionPair(value: { next_action?: string | null; next_action_at?: string | null }) {
  const actionProvided = value.next_action !== undefined;
  const dateProvided = value.next_action_at !== undefined;
  if (!actionProvided && !dateProvided) return true;
  if (!actionProvided || !dateProvided) return false;
  return (value.next_action === null) === (value.next_action_at === null);
}

export const postSaleClientCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone_e164: phoneE164Schema,
  email: optionalEmail,
  notes: optionalNotes,
  responsible_member_id: responsibleMemberId,
  lead_id: z.string().uuid().nullable().optional(),
  next_action: z.string().trim().min(1).max(500).nullable().optional(),
  next_action_at: z.string().datetime({ offset: true }).nullable().optional()
}).strict().refine(validNextActionPair, {
  message: "Informe a próxima ação e a data juntas",
  path: ["next_action"]
});

export const postSaleClientUpdateSchema = z.object({
  version: z.number().int().positive(),
  name: z.string().trim().min(1).max(200).optional(),
  phone_e164: phoneE164Schema.optional(),
  email: optionalEmail,
  notes: optionalNotes,
  responsible_member_id: responsibleMemberId,
  next_action: z.string().trim().min(1).max(500).nullable().optional(),
  next_action_at: z.string().datetime({ offset: true }).nullable().optional()
}).strict()
  .refine(validNextActionPair, {
    message: "Informe a próxima ação e a data juntas",
    path: ["next_action"]
  })
  .refine((value) => Object.keys(value).some((key) => key !== "version"), {
    message: "Informe ao menos um campo para atualizar"
  });

export const postSaleVersionSchema = z.object({ version: z.number().int().positive() }).strict();

export const postSaleChecklistResultSchema = z.enum([
  "pendente",
  "oferecido",
  "aceito",
  "recusado",
  "nao_se_aplica"
]);

export const postSaleChecklistEntryUpdateSchema = z.object({
  version: z.number().int().positive(),
  result: postSaleChecklistResultSchema,
  note: z.string().trim().max(5000).nullable().optional()
}).strict();

export const postSaleTemplateItemCreateSchema = z.object({
  description: z.string().trim().min(1).max(500)
}).strict();

export const postSaleTemplateItemUpdateSchema = z.object({
  version: z.number().int().positive(),
  description: z.string().trim().min(1).max(500)
}).strict();

export const postSaleTemplateOrderSchema = z.object({
  items: z.array(z.object({
    id: z.string().uuid(),
    version: z.number().int().positive()
  }).strict()).max(500)
}).strict().refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length, {
  message: "A ordem contém itens duplicados",
  path: ["items"]
});

export const postSaleClientsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  progress: z.enum(["not_started", "in_progress", "complete"]).optional(),
  responsible_member_id: z.union([z.string().uuid(), z.literal("unassigned")]).optional(),
  next_action: z.enum(["overdue", "today", "upcoming", "none"]).optional(),
  archived: z.enum(["active", "archived", "all"]).default("active"),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30)
}).strict();

export const postSaleDebtsQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  store: z.string().trim().max(200).optional(),
  status: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500)
}).strict();

export type PostSaleDebtsQuery = z.infer<typeof postSaleDebtsQuerySchema>;
export type PostSaleClientCreateInput = z.infer<typeof postSaleClientCreateSchema>;
export type PostSaleClientUpdateInput = z.infer<typeof postSaleClientUpdateSchema>;
export type PostSaleChecklistEntryUpdateInput = z.infer<typeof postSaleChecklistEntryUpdateSchema>;
export type PostSaleTemplateOrderInput = z.infer<typeof postSaleTemplateOrderSchema>;
export type PostSaleClientsQuery = z.infer<typeof postSaleClientsQuerySchema>;
