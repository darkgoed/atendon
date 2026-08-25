import { createHash } from "node:crypto";
import type {
  TripzGenerationRequirement,
  TripzMissingField,
  TripzProposalIssue,
  TripzProposalState
} from "../domain.js";
import type { TripzAiProposalPatch, TripzExplicitCorrectionPath } from "./schemas.js";

export interface TripzProposalValidationOptions {
  requiredFields?: Array<{ path: string; label?: string; reason?: string }>;
  additionalIssues?: TripzProposalIssue[];
}

export interface TripzProposalValidationResult {
  proposal: TripzProposalState;
  missingInformation: TripzMissingField[];
  issues: TripzProposalIssue[];
  canGenerate: boolean;
  blockingReasons: string[];
}

function nonBlank(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null;
}

function getPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, source);
}

function requirementSatisfied(
  proposal: TripzProposalState,
  requirement: Pick<TripzGenerationRequirement, "path">
): boolean {
  if (requirement.path === "flights") {
    return proposal.flights.some((flight) => [
      flight.airline, flight.flightNumber, flight.date, flight.departureTime,
      flight.arrivalTime, flight.origin, flight.destination
    ].some(nonBlank));
  }
  if (requirement.path === "hotel") {
    return Boolean(proposal.hotel && [
      proposal.hotel.name, proposal.hotel.roomType, proposal.hotel.description,
      proposal.hotel.checkIn, proposal.hotel.checkOut, proposal.hotel.mealPlan
    ].some(nonBlank));
  }
  if (requirement.path === "itinerary") {
    return proposal.itinerary.some((day) => [
      day.date, day.title, day.morning, day.afternoon, day.evening, ...(day.notes ?? [])
    ].some(nonBlank));
  }
  if (requirement.path === "includedItems") return proposal.includedItems.length > 0;
  if (requirement.path === "includedItems.insurance" || requirement.path === "includedItems.transfer") {
    const aliases = requirement.path.endsWith("insurance") ? ["seguro", "insurance"] : ["traslado", "transfer"];
    return proposal.includedItems.some((item) => {
      const searchable = normalizeLocation(`${item.type ?? ""} ${item.title}`);
      return aliases.some((alias) => searchable.includes(normalizeLocation(alias)));
    });
  }
  return nonBlank(getPath(proposal, requirement.path));
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function normalizeLocation(value?: string): string {
  return (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

export function tripzProposalContentFingerprint(proposal: TripzProposalState): string {
  return createHash("sha256").update(JSON.stringify({
    ...proposal,
    missingInformation: undefined,
    inconsistencies: undefined,
    issueAcknowledgements: undefined,
    status: undefined
  })).digest("hex");
}

function pushUniqueIssue(issues: TripzProposalIssue[], issue: TripzProposalIssue): void {
  if (!issues.some((current) => current.code === issue.code && current.path === issue.path && current.message === issue.message)) {
    issues.push(issue);
  }
}

function normalizeMealPlan(value: string): "with_breakfast" | "without_breakfast" | "other" {
  const normalized = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/\bsem\s+(?:cafe|cafe-da-manha|alimentacao)|\broom\s*only\b|\bno\s+breakfast\b/.test(normalized)) {
    return "without_breakfast";
  }
  if (/\bcom\s+(?:cafe|cafe-da-manha)|\bcafe\s+(?:da\s+manha\s+)?inclus|\bbreakfast\s+included\b/.test(normalized)) {
    return "with_breakfast";
  }
  return "other";
}

export function detectTripzPatchConflicts(
  current: TripzProposalState,
  patch: TripzAiProposalPatch,
  explicitCorrections: readonly TripzExplicitCorrectionPath[]
): { conflictingPaths: Set<string>; issues: TripzProposalIssue[] } {
  const conflictingPaths = new Set<string>();
  const issues: TripzProposalIssue[] = [];
  const previousMeal = current.hotel?.mealPlan?.trim();
  const nextMeal = patch.hotel && typeof patch.hotel === "object" ? patch.hotel.mealPlan?.trim() : undefined;
  if (
    previousMeal
    && nextMeal
    && previousMeal.localeCompare(nextMeal, undefined, { sensitivity: "accent" }) !== 0
    && normalizeMealPlan(previousMeal) !== normalizeMealPlan(nextMeal)
    && !explicitCorrections.includes("hotel.mealPlan")
  ) {
    conflictingPaths.add("hotel.mealPlan");
    issues.push({
      code: "HOTEL_MEAL_PLAN_CONFLICT",
      path: "hotel.mealPlan",
      message: `O regime de alimentação informado (${previousMeal}) conflita com a nova informação (${nextMeal}).`,
      severity: "critical",
      requiresConfirmation: true
    });
  }
  return { conflictingPaths, issues };
}

export function validateTripzProposal(
  proposal: TripzProposalState,
  options: TripzProposalValidationOptions = {}
): TripzProposalValidationResult {
  const missingInformation: TripzMissingField[] = [];
  const issues: TripzProposalIssue[] = [];
  const proposalFingerprint = tripzProposalContentFingerprint(proposal);
  const issueAcknowledgements = proposal.issueAcknowledgements.filter(
    (acknowledgement) => acknowledgement.proposalFingerprint === proposalFingerprint
  );
  const addMissing = (field: TripzMissingField) => {
    if (!missingInformation.some((current) => current.code === field.code && current.path === field.path)) {
      missingInformation.push(field);
    }
  };

  if (!nonBlank(proposal.destination)) {
    addMissing({
      code: "DESTINATION_REQUIRED",
      path: "destination",
      label: "destino",
      required: true,
      reason: "A proposta precisa identificar o destino."
    });
  }
  const hasFlight = proposal.flights.some((flight) => [
    flight.airline, flight.flightNumber, flight.date, flight.departureTime,
    flight.arrivalTime, flight.origin, flight.destination
  ].some(nonBlank));
  const hasHotel = Boolean(proposal.hotel && [
    proposal.hotel.name, proposal.hotel.roomType, proposal.hotel.description,
    proposal.hotel.checkIn, proposal.hotel.checkOut
  ].some(nonBlank));
  const hasItinerary = proposal.itinerary.some((day) => [
    day.date, day.title, day.morning, day.afternoon, day.evening,
    ...(day.notes ?? [])
  ].some(nonBlank));
  const hasPrimaryContent = hasFlight || hasHotel || hasItinerary;
  if (!hasPrimaryContent) {
    addMissing({
      code: "PRIMARY_CONTENT_REQUIRED",
      path: "flights|hotel|itinerary",
      label: "voo, hospedagem ou roteiro",
      required: true,
      reason: "A proposta precisa de pelo menos um elemento principal."
    });
  }
  if (!proposal.startDate) {
    addMissing({ code: "START_DATE_RECOMMENDED", path: "startDate", label: "data de início", required: false });
  }
  if (!proposal.endDate) {
    addMissing({ code: "END_DATE_RECOMMENDED", path: "endDate", label: "data de término", required: false });
  }
  if (proposal.hotel && !nonBlank(proposal.hotel.name)) {
    addMissing({ code: "HOTEL_NAME_RECOMMENDED", path: "hotel.name", label: "nome do hotel", required: false });
  }
  for (const required of options.requiredFields ?? []) {
    const satisfied = requirementSatisfied(proposal, required as TripzGenerationRequirement);
    if (!satisfied) {
      addMissing({
        code: `REQUIRED_${required.path.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}`,
        path: required.path,
        label: required.label ?? required.path,
        required: true,
        reason: required.reason
      });
    }
  }

  const checkDate = (value: string | undefined, path: string) => {
    if (value && !validDate(value)) {
      pushUniqueIssue(issues, {
        code: "INVALID_DATE",
        path,
        message: `A data em ${path} não é uma data ISO válida.`,
        severity: "critical",
        requiresConfirmation: true
      });
    }
  };
  checkDate(proposal.startDate, "startDate");
  checkDate(proposal.endDate, "endDate");
  checkDate(proposal.hotel?.checkIn, "hotel.checkIn");
  checkDate(proposal.hotel?.checkOut, "hotel.checkOut");

  if (proposal.startDate && proposal.endDate && validDate(proposal.startDate) && validDate(proposal.endDate) && proposal.startDate > proposal.endDate) {
    pushUniqueIssue(issues, {
      code: "TRAVEL_DATE_ORDER_CONFLICT",
      path: "startDate",
      message: "A data final da viagem é anterior à data inicial.",
      severity: "critical",
      requiresConfirmation: true
    });
  }
  if (
    proposal.hotel?.checkIn && proposal.hotel.checkOut
    && validDate(proposal.hotel.checkIn) && validDate(proposal.hotel.checkOut)
    && proposal.hotel.checkIn > proposal.hotel.checkOut
  ) {
    pushUniqueIssue(issues, {
      code: "HOTEL_DATE_ORDER_CONFLICT",
      path: "hotel.checkOut",
      message: "O checkout do hotel é anterior ao check-in.",
      severity: "critical",
      requiresConfirmation: true
    });
  }

  proposal.flights.forEach((flight, index) => {
    const path = `flights.${index}`;
    checkDate(flight.date, `${path}.date`);
    if (!flight.origin) addMissing({ code: `FLIGHT_${index + 1}_ORIGIN_RECOMMENDED`, path: `${path}.origin`, label: `origem do trecho ${index + 1}`, required: false });
    if (!flight.destination) addMissing({ code: `FLIGHT_${index + 1}_DESTINATION_RECOMMENDED`, path: `${path}.destination`, label: `destino do trecho ${index + 1}`, required: false });
    if (!flight.date) addMissing({ code: `FLIGHT_${index + 1}_DATE_RECOMMENDED`, path: `${path}.date`, label: `data do trecho ${index + 1}`, required: false });
    if (
      flight.date && validDate(flight.date)
      && ((proposal.startDate && validDate(proposal.startDate) && flight.date < proposal.startDate)
        || (proposal.endDate && validDate(proposal.endDate) && flight.date > proposal.endDate))
    ) {
      pushUniqueIssue(issues, {
        code: "FLIGHT_OUTSIDE_TRAVEL_DATES",
        path: `${path}.date`,
        message: `A data do trecho ${index + 1} está fora das datas informadas para a viagem.`,
        severity: "critical",
        requiresConfirmation: true
      });
    }
    if (
      flight.departureTime && flight.arrivalTime
      && /^\d{2}:\d{2}$/.test(flight.departureTime) && /^\d{2}:\d{2}$/.test(flight.arrivalTime)
      && flight.arrivalTime < flight.departureTime && flight.arrivesNextDay !== true
    ) {
      pushUniqueIssue(issues, {
        code: "FLIGHT_OVERNIGHT_UNCONFIRMED",
        path: `${path}.arrivesNextDay`,
        message: `O trecho ${index + 1} parece chegar no dia seguinte, mas isso não foi confirmado.`,
        severity: "critical",
        requiresConfirmation: true
      });
    }
    const next = proposal.flights[index + 1];
    if (next?.date && flight.date && validDate(next.date) && validDate(flight.date) && next.date < flight.date) {
      pushUniqueIssue(issues, {
        code: "FLIGHT_DATE_SEQUENCE_CONFLICT",
        path: `flights.${index + 1}.date`,
        message: "Os trechos de voo não estão em sequência cronológica.",
        severity: "critical",
        requiresConfirmation: true
      });
    }
    if (next?.origin && flight.destination && normalizeLocation(next.origin) !== normalizeLocation(flight.destination)) {
      pushUniqueIssue(issues, {
        code: "FLIGHT_ROUTE_SEQUENCE_CONFLICT",
        path: `flights.${index + 1}.origin`,
        message: `A origem do trecho ${index + 2} não coincide com o destino do trecho anterior; revise se há troca de aeroporto ou roteiro open-jaw.`,
        severity: "warning",
        requiresConfirmation: false
      });
    }
  });

  const pricing = proposal.pricing;
  const passengerCount = (proposal.passengers?.adults ?? 0)
    + (proposal.passengers?.children ?? 0)
    + (proposal.passengers?.infants ?? 0);
  if (pricing?.pricePerPerson !== undefined && pricing.totalPrice !== undefined && passengerCount > 0) {
    const base = pricing.pricePerPerson * passengerCount;
    const tax = pricing.boardingTax ?? 0;
    const plausibleTotals = [base, base + tax, base + (tax * passengerCount)];
    const tolerance = Math.max(1, Math.abs(pricing.totalPrice) * 0.01);
    if (!plausibleTotals.some((candidate) => Math.abs(candidate - pricing.totalPrice!) <= tolerance)) {
      pushUniqueIssue(issues, {
        code: "PRICING_TOTAL_CONFLICT",
        path: "pricing.totalPrice",
        message: "O valor total não é coerente com o preço por pessoa e a quantidade de passageiros.",
        severity: "critical",
        requiresConfirmation: true
      });
    }
  }

  const itineraryDays = new Set<number>();
  for (const day of proposal.itinerary) {
    if (itineraryDays.has(day.dayNumber)) {
      pushUniqueIssue(issues, {
        code: "ITINERARY_DAY_DUPLICATED",
        path: "itinerary",
        message: `O dia ${day.dayNumber} aparece mais de uma vez no roteiro.`,
        severity: "warning",
        requiresConfirmation: false
      });
    }
    itineraryDays.add(day.dayNumber);
    checkDate(day.date, `itinerary.${day.dayNumber}.date`);
  }

  for (const media of proposal.media) {
    if (media.confidence !== undefined && media.confidence < 0.6) {
      pushUniqueIssue(issues, {
        code: "MEDIA_CLASSIFICATION_LOW_CONFIDENCE",
        path: `media.${media.attachmentId}.category`,
        message: `A classificação da imagem ${media.label ?? media.attachmentId} precisa de revisão.`,
        severity: "warning",
        requiresConfirmation: false
      });
    }
  }
  for (const issue of options.additionalIssues ?? []) pushUniqueIssue(issues, issue);

  const reviewedIssues = issues.map((issue) => {
    const acknowledged = issue.severity === "critical" && issue.requiresConfirmation
      && issueAcknowledgements.some((item) => item.code === issue.code && item.path === issue.path);
    return acknowledged ? {
      ...issue,
      message: `${issue.message} Confirmado pelo agente.`,
      severity: "warning" as const,
      requiresConfirmation: false
    } : issue;
  });
  const blockingReasons = [
    ...missingInformation.filter((field) => field.required).map((field) => field.label),
    ...reviewedIssues.filter((issue) => issue.severity === "critical" && issue.requiresConfirmation).map((issue) => issue.message)
  ];
  const canGenerate = blockingReasons.length === 0;
  const status = canGenerate ? "ready_for_review" : "collecting";
  const normalized: TripzProposalState = {
    ...proposal,
    issueAcknowledgements,
    missingInformation,
    inconsistencies: reviewedIssues,
    status
  };
  return { proposal: normalized, missingInformation, issues: reviewedIssues, canGenerate, blockingReasons };
}
