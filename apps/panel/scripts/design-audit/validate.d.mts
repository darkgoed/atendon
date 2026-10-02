export interface AuditRecord { route: string; theme?: string | { requested?: string; dataset?: string; background?: string }; viewport?: string | { name?: string }; [key: string]: unknown; }
export interface ValidationResult { valid: boolean; errors: string[]; }
export declare function fontFixture(url: string, manifestPath?: string): { status: number; contentType: string; body: Buffer; headers: Record<string, string> } | null;
export declare function validateRecord(record: AuditRecord, contract?: unknown): ValidationResult;
export declare function mergeRecords(reports: { routes?: AuditRecord[] }[]): AuditRecord[];
