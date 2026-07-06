if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL is required in production');
}
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('chronixedu_token');
}

/** Clears the stored session and sends the user back to login. Called whenever
 *  the API rejects a request with 401 — expired, invalid, or tampered token. */
function handleUnauthorized() {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('chronixedu_token');
  localStorage.removeItem('chronixedu_user');
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = '/login?reason=expired';
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) handleUnauthorized();
  const json = await res.json();
  if (!res.ok) {
    const message =
      json?.error?.message ?? json?.error ?? `Request failed (${res.status})`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return json as T;
}

export async function apiUpload<T = unknown>(
  path: string,
  formData: FormData
): Promise<T> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    body: formData,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401) handleUnauthorized();
  const json = await res.json();
  if (!res.ok) {
    const message =
      json?.error?.message ?? json?.error ?? `Upload failed (${res.status})`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return json as T;
}

export async function apiFetchBlob(
  path: string,
  options: RequestInit = {}
): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) {
    const json = await res.json().catch(() => null);
    const message =
      json?.error?.message ?? json?.error ?? `Request failed (${res.status})`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return res.blob();
}
