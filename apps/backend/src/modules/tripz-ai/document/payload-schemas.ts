import { z } from "zod";
import { tripzUuidSchema } from "../schemas.js";

/** PUT /tripz-ai/brand-settings — o leak guard (identidade Tripz) vive no upsertTripzBrandSettings. */
export const tripzBrandSettingsPutSchema = z.object({
  config: z.unknown()
});

/** POST /tripz-ai/conversations/:id/finalize — snapshot versionado da proposta. */
export const tripzFinalizeSchema = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  notes: z.string().trim().min(1).max(2000).optional()
}).strict();

/** POST /tripz-ai/conversations/:id/media/from-url — download com guard de SSRF. */
export const tripzMediaFromUrlSchema = z.object({
  url: z.string().trim().url().max(2048),
  category: z.enum(["destination", "hotel", "experience", "other"]).default("other"),
  label: z.string().trim().min(1).max(160).optional()
}).strict();

export const tripzProposalVersionRevertSchema = z.object({
  versionId: tripzUuidSchema
}).strict();
