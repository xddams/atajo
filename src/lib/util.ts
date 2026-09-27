export function uuid(): string {
  return crypto.randomUUID();
}

export function nowIso(d = new Date()): string {
  return d.toISOString();
}

/** SQLite-friendly UTC timestamp: YYYY-MM-DD HH:MM:SS */
export function toSqliteUtc(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

export function addDays(days: number, from = new Date()): Date {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

export function addMinutes(minutes: number, from = new Date()): Date {
  return new Date(from.getTime() + minutes * 60_000);
}

export function todayKey(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
