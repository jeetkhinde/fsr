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
