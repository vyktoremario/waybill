export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
export const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'ws://localhost:4001/ws';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: any,
  ) {
    super(body?.message ?? `request failed (${status})`);
  }
}

export async function api<T = any>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers, cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const DISPATCH_TOKEN_KEY = 'waybill.dispatch.token';

export function readDispatchToken(): string | null {
  try {
    return localStorage.getItem(DISPATCH_TOKEN_KEY);
  } catch {
    return null;
  }
}
