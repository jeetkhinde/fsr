export const HANDLE_RE = /^[a-z0-9-]{2,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmail(v: string): boolean {
  return EMAIL_RE.test(v);
}

export function validHandle(v: string): boolean {
  return HANDLE_RE.test(v);
}

export function validPassword(v: string): boolean {
  return v.length >= 8 && v.length <= 128;
}

export function validProjectName(v: string): boolean {
  const t = v.trim();
  return t.length >= 1 && t.length <= 120;
}

export function validTaskTitle(v: string): boolean {
  const t = v.trim();
  return t.length >= 1 && t.length <= 200;
}

export function validColumnName(v: string): boolean {
  const t = v.trim();
  return t.length >= 1 && t.length <= 60;
}

export function parsePriority(v: unknown): 0 | 1 | 2 | 3 {
  const n = Number(v);
  return n === 1 || n === 2 || n === 3 ? n : 0;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function parseDueDate(v: unknown): string | null {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) ? null : v;
}
