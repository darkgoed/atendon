export const TRIPZ_AI_FEATURE_FLAG = "tripz_ai_v1" as const;
export const TRIPZ_AI_USE_PERMISSION = "tripz_ai.use" as const;
export const TRIPZ_AI_MANAGE_PERMISSION = "tripz_ai.manage" as const;
export const TRIPZ_MAX_SELECTED_MEDIA = 12;
export const TRIPZ_MAX_TOTAL_ATTACHMENT_BYTES_PER_TURN = 40 * 1024 * 1024;

export const TRIPZ_CONVERSATION_STATUSES = [
  "collecting",
  "ready_for_review",
  "ready_for_pdf",
  "pdf_generated"
] as const;
export type TripzConversationStatus = typeof TRIPZ_CONVERSATION_STATUSES[number];

export const TRIPZ_PROCESSING_STATUSES = ["idle", "queued", "processing", "failed"] as const;
export type TripzProcessingStatus = typeof TRIPZ_PROCESSING_STATUSES[number];

export const TRIPZ_MESSAGE_ROLES = ["user", "assistant"] as const;
export type TripzMessageRole = typeof TRIPZ_MESSAGE_ROLES[number];

export const TRIPZ_MESSAGE_PROCESSING_STATUSES = ["pending", "queued", "processing", "completed", "failed"] as const;
export type TripzMessageProcessingStatus = typeof TRIPZ_MESSAGE_PROCESSING_STATUSES[number];

export const TRIPZ_ATTACHMENT_PROCESSING_STATUSES = [
  "pending",
  "processing",
  "processed",
  "failed",
  "needs_review"
] as const;
export type TripzAttachmentProcessingStatus = typeof TRIPZ_ATTACHMENT_PROCESSING_STATUSES[number];

export const TRIPZ_DOCUMENT_KINDS = ["preview", "pdf"] as const;
export type TripzDocumentKind = typeof TRIPZ_DOCUMENT_KINDS[number];

export const TRIPZ_MEDIA_CATEGORIES = [
  "cover",
  "destination",
  "airline",
  "hotel_facade",
  "hotel_lobby",
  "hotel_room",
  "hotel_bathroom",
  "hotel_kitchen",
  "hotel_living_room",
  "hotel_pool",
  "hotel_gym",
  "hotel_restaurant",
  "hotel_beach",
  "hotel_exterior",
  "transfer",
  "insurance",
  "other"
] as const;
export type TripzMediaCategory = typeof TRIPZ_MEDIA_CATEGORIES[number] | (string & {});

export interface TripzFlightSegment {
  id?: string;
  airline?: string;
  flightNumber?: string;
  date?: string;
  departureTime?: string;
  arrivalTime?: string;
  origin?: string;
  destination?: string;
  duration?: string;
  stopover?: string;
  aircraft?: string;
  cabin?: string;
  baggage?: string;
  arrivesNextDay?: boolean;
  notes?: string[];
  confidence?: number;
}

export interface TripzHotel {
  name?: string;
  roomType?: string;
  mealPlan?: string;
  description?: string;
  checkIn?: string;
  checkOut?: string;
  nightlyRate?: number;
  totalRate?: number;
  currency?: string;
}

export interface TripzProposalMedia {
  id?: string;
  attachmentId: string;
  category: TripzMediaCategory;
  label?: string;
  confidence?: number;
  sortOrder: number;
  selectedForPdf: boolean;
  metadata?: Record<string, unknown>;
}

export interface TripzIncludedItem {
  id?: string;
  type?: string;
  title: string;
  description?: string;
  included: boolean;
}

export interface TripzPricing {
  pricePerPerson?: number;
  boardingTax?: number;
  totalPrice?: number;
  currency?: string;
  notes?: string;
}

export interface TripzItineraryDay {
  dayNumber: number;
  date?: string;
  title?: string;
  morning?: string;
  afternoon?: string;
  evening?: string;
  notes?: string[];
}

export interface TripzMissingField {
  code: string;
  path: string;
  label: string;
  required: boolean;
  reason?: string;
}

export type TripzIssueSeverity = "info" | "warning" | "critical";
export interface TripzProposalIssue {
  code: string;
  path?: string;
  message: string;
  severity: TripzIssueSeverity;
  requiresConfirmation: boolean;
}

export interface TripzGenerationRequirement {
  path: "client.name" | "startDate" | "endDate" | "flights" | "hotel" | "hotel.name"
    | "hotel.mealPlan" | "includedItems" | "includedItems.insurance" | "includedItems.transfer"
    | "pricing.totalPrice" | "pricing.pricePerPerson" | "itinerary" | "notes";
  label: string;
  reason?: string;
}

export interface TripzIssueAcknowledgement {
  code: string;
  path?: string;
  proposalFingerprint: string;
}

export interface TripzProposalState {
  schemaVersion: 1;
  title?: string;
  client?: { name?: string };
  destination?: string;
  startDate?: string;
  endDate?: string;
  passengers?: { adults?: number; children?: number; infants?: number };
  flights: TripzFlightSegment[];
  hotel?: TripzHotel;
  media: TripzProposalMedia[];
  includedItems: TripzIncludedItem[];
  pricing?: TripzPricing;
  itinerary: TripzItineraryDay[];
  notes: string[];
  generationRequirements: TripzGenerationRequirement[];
  issueAcknowledgements: TripzIssueAcknowledgement[];
  missingInformation: TripzMissingField[];
  inconsistencies: TripzProposalIssue[];
  status: TripzConversationStatus;
}

export type TripzProposalPatch = Partial<Omit<TripzProposalState, "schemaVersion">> & {
  client?: Partial<NonNullable<TripzProposalState["client"]>>;
  passengers?: Partial<NonNullable<TripzProposalState["passengers"]>>;
  hotel?: Partial<NonNullable<TripzProposalState["hotel"]>>;
  pricing?: Partial<NonNullable<TripzProposalState["pricing"]>>;
};

export interface TripzAccessScope {
  tenantId: string;
  userId: string;
  canManage: boolean;
}

export interface TripzConversation {
  id: string;
  title: string;
  status: TripzConversationStatus;
  summary: string | null;
  stateRevision: number;
  processingStatus: TripzProcessingStatus;
  processingErrorCode: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface TripzMessage {
  id: string;
  conversationId: string;
  role: TripzMessageRole;
  content: string;
  metadata: Record<string, unknown>;
  processingStatus: TripzMessageProcessingStatus;
  proposalRevisionBefore: number | null;
  proposalRevisionAfter: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface TripzAttachment {
  id: string;
  conversationId: string;
  messageId: string | null;
  fileName: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  contentHash: string;
  processingStatus: TripzAttachmentProcessingStatus;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface TripzProposal {
  id: string;
  conversationId: string;
  schemaVersion: number;
  revision: number;
  state: TripzProposalState;
  createdAt: string;
  updatedAt: string;
}

export interface TripzGeneratedDocument {
  id: string;
  conversationId: string;
  proposalRevision: number;
  kind: TripzDocumentKind;
  rendererVersion: string;
  contentHash: string;
  sizeBytes: number;
  mimeType: string;
  createdAt: string;
}

export interface TripzConversationDetail {
  conversation: TripzConversation;
  proposal: TripzProposal;
  messages: TripzMessage[];
  attachments: TripzAttachment[];
  documents: TripzGeneratedDocument[];
}

export interface TripzCursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function createEmptyTripzProposalState(): TripzProposalState {
  return {
    schemaVersion: 1,
    flights: [],
    media: [],
    includedItems: [],
    itinerary: [],
    notes: [],
    generationRequirements: [],
    issueAcknowledgements: [],
    missingInformation: [],
    inconsistencies: [],
    status: "collecting"
  };
}

export function mergeTripzProposalPatch(
  current: TripzProposalState,
  patch: TripzProposalPatch
): TripzProposalState {
  return {
    ...current,
    ...patch,
    schemaVersion: 1,
    ...(patch.client ? { client: { ...current.client, ...patch.client } } : {}),
    ...(patch.passengers ? { passengers: { ...current.passengers, ...patch.passengers } } : {}),
    ...(patch.hotel ? { hotel: { ...current.hotel, ...patch.hotel } } : {}),
    ...(patch.pricing ? { pricing: { ...current.pricing, ...patch.pricing } } : {})
  };
}

export class TripzAiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = "TripzAiError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function tripzNotFound(message = "Recurso não encontrado"): TripzAiError {
  return new TripzAiError(404, "TRIPZ_NOT_FOUND", message);
}

export function tripzConflict(code: string, message: string): TripzAiError {
  return new TripzAiError(409, code, message);
}
