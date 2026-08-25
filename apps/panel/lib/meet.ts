export type MeetAccessResponse = {
  token: string;
  room_name: string;
  domain: string;
};

export type MeetRecording = {
  id: string;
  appointment_id?: string | null;
  room_name?: string;
  file_name?: string | null;
  size_bytes: number;
  started_at: string | null;
  ended_at: string | null;
  status: string;
  created_at?: string | null;
};

export type MeetRecordingsResponse = {
  recordings: MeetRecording[];
};

export function apiContentUrl(path: string) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/backend";
  return `${base}${path}`;
}

export function normalizeMeetOrigin(domain: string) {
  const candidate = domain.trim();
  if (!candidate) throw new Error("O servidor de reunião não foi informado.");
  const withProtocol = /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  const parsed = new URL(withProtocol);
  if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    throw new Error("O servidor de reunião precisa usar uma conexão segura.");
  }
  return parsed.origin;
}

export function formatRecordingSize(sizeBytes: number) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return "Tamanho indisponível";
  const units = ["B", "KB", "MB", "GB"] as const;
  const exponent = Math.min(Math.floor(Math.log(sizeBytes) / Math.log(1024)), units.length - 1);
  const value = sizeBytes / (1024 ** exponent);
  return `${new Intl.NumberFormat("pt-BR", { maximumFractionDigits: exponent === 0 ? 0 : 1 }).format(value)} ${units[exponent]}`;
}

export function recordingCanPlay(status: string) {
  return status.toLowerCase() === "ready";
}

export function formatRecordingDate(value: string | null | undefined, timezone: string) {
  if (!value) return "Data indisponível";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Data indisponível";
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: timezone }).format(date);
}
