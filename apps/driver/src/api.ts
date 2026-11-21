import { kv } from './store';

export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? 'http://localhost:4000';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: any,
  ) {
    super(body?.message ?? `HTTP ${status}`);
  }
}

/** Network failures throw a plain Error; server answers throw HttpError with the status. */
export async function call<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const token = kv.get('token');
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (init.body && typeof init.body === 'string') headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${API_URL}${path}`, { ...init, headers, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new HttpError(res.status, body);
    return body as T;
  } finally {
    clearTimeout(timer);
  }
}

export async function login(email: string, password: string): Promise<void> {
  const r = await call<{ token: string; user: { role: string; name: string } }>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
  });
  if (r.user.role !== 'driver') throw new Error('This account is not a driver account.');
  kv.set('token', r.token);
  kv.set('name', r.user.name);
}

export function logout() {
  kv.set('token', null);
}
