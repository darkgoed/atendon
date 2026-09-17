import { reportError } from "./error-events";
import { friendlyPanelError } from "./whatsapp-support";

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface ApiOptions {
  reportErrors?: boolean;
}

export async function api<T>(path: string, init?: RequestInit, options: ApiOptions = {}): Promise<T> {
  const shouldReportErrors = options.reportErrors !== false;
  const headers = new Headers(init?.headers);
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  if (init?.body != null && !isFormData && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, { ...init, credentials: "include", headers });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Não foi possível conectar ao servidor");
    if (shouldReportErrors) reportError(error.message);
    throw error;
  }
  if (response.status === 401 && typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
    window.location.href = "/login";
  }
  if (response.status === 428 && typeof window !== "undefined" && !window.location.pathname.startsWith("/alterar-senha")) {
    window.location.href = "/alterar-senha";
  }
  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown;
  try {
    body = contentType.includes("json") ? await response.json() : await response.text();
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Resposta inválida do servidor");
    if (shouldReportErrors) reportError(error.message);
    throw error;
  }
  if (!response.ok) {
    const rawMessage = typeof body === "object" && body && "error" in body && typeof body.error === "string"
      ? body.error
      : typeof body === "string"
        && contentType.toLowerCase().startsWith("text/plain")
        && body.trim().length > 0
        && body.length <= 300
        ? body
        : `Falha na requisição (${response.status})`;
    const message = friendlyPanelError(rawMessage);
    if (shouldReportErrors) reportError(message);
    throw new ApiError(message, response.status, body);
  }
  return body as T;
}

export interface ChangelogItem {
  version: string;
  date: string;
  changes: string[];
}

export interface VersionInfo {
  version: string;
  deployVersion: string;
  buildNumber: number | null;
  changelog: ChangelogItem[];
}

export async function fetchVersion(): Promise<VersionInfo> {
  return api<VersionInfo>("/panel/version");
}

export interface PublicRelease {
  buildNumber: number;
  version: string;
  publicTitle: string | null;
  publicSummary: string | null;
  publicChanges: Array<{ text: string; tenant_slugs: string[] }>;
  publishedAt: string | null;
  createdAt: string;
}

export interface RootRelease {
  id: string;
  buildNumber: number;
  version: string;
  classification: "PATCH" | "DROP" | "RELEASE";
  classificationReason: string;
  bumpSource: string;
  commitSha: string;
  branch: string;
  additions: number;
  deletions: number;
  filesChanged: Array<{ path: string; status: string; additions: number; deletions: number }>;
  modulesAffected: string[];
  scope: "GLOBAL" | "TENANT";
  tenantSlugsDetected: string[];
  commitMessages: string[];
  diffExcerpt: string;
  technicalChangelog: string;
  publicTitle: string | null;
  publicSummary: string | null;
  publicChanges: Array<{ text: string; tenant_slugs: string[] }>;
  aiStatus: "pending" | "generating" | "generated" | "failed";
  aiError: string | null;
  aiModelUsed: string | null;
  published: boolean;
  publishedAt: string | null;
  manualOverride: boolean;
  isLegacyImport: boolean;
  createdAt: string;
}

export interface ChangelogAiSettings {
  hasApiKey: boolean;
  apiKeyHint: string | null;
  primaryModel: string;
  fallbackModel: string | null;
  autoGenerateEnabled: boolean;
  autoPublishEnabled: boolean;
  updatedAt: string;
}
