import { z } from "zod";
import { COMMERCIAL_OUTCOMES, LOSS_REASONS } from "./domain.js";

export const commercialOutcomeSchema = z.enum(COMMERCIAL_OUTCOMES);
export const lossReasonSchema = z.enum(LOSS_REASONS);
const instant = z.string().datetime({ offset: true });
const metadata = z.record(z.string(),z.unknown()).optional();
const nextAction = z.string().trim().min(1).max(500);

export const commercialTransitionPayloadSchema = z.object({
  sale_value: z.number().positive().finite().optional(),
  loss_reason: lossReasonSchema.optional(),
  next_action: nextAction.optional(),
  next_action_at: instant.optional(),
  outcome_metadata: metadata
}).strict();

const closedOutcomeSchema = z.object({
  outcome: z.literal("fechado"),
  sale_value: z.number().positive().finite(),
  outcome_metadata: metadata
}).strict();

function continuingOutcome<T extends "proposta_enviada" | "em_negociacao" | "follow_up">(outcome: T) {
  return z.object({
    outcome: z.literal(outcome),
    next_action: nextAction,
    next_action_at: instant,
    outcome_metadata: metadata
  }).strict();
}

const lostOutcomeSchema = z.object({
  outcome: z.literal("nao_avancou"),
  loss_reason: lossReasonSchema,
  outcome_metadata: metadata
}).strict();

export const concludeAppointmentSchema = z.discriminatedUnion("outcome", [
  closedOutcomeSchema,
  continuingOutcome("proposta_enviada"),
  continuingOutcome("em_negociacao"),
  continuingOutcome("follow_up"),
  lostOutcomeSchema
]);

export const cancellationSchema = z.discriminatedUnion("disposition", [
  z.object({
    disposition: z.literal("recover"),
    next_action: nextAction,
    next_action_at: instant
  }).strict(),
  z.object({
    disposition: z.literal("lost"),
    loss_reason: lossReasonSchema
  }).strict()
]);

export const noShowSchema = z.object({
  next_action_at: instant.optional()
}).strict().default({});

export type CommercialTransitionPayload = z.infer<typeof commercialTransitionPayloadSchema>;
export type ConcludeAppointmentInput = z.infer<typeof concludeAppointmentSchema>;
export type CancellationInput = z.infer<typeof cancellationSchema>;
export type NoShowInput = z.infer<typeof noShowSchema>;
