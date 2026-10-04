import { ApiError, describeApiError } from './apiError';
import { errorCode, loginReasonFor, setupRedirectFor } from './refusalRedirect';
export { ApiError } from './apiError';

if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error('NEXT_PUBLIC_API_URL is required in production');
}
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

// TODO post-launch: implement JWT refresh tokens so sessions can be silently renewed
// without re-login. Tracked as a planned improvement alongside the cookie-auth migration.
function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('chronixedu_token');
}

/** Support-session tokens (from "Start Support Session") are only accepted by the
 *  API when paired with this header — see apps/api/src/middleware/auth.ts. */
function getSupportSessionHeader(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  const sessionId = localStorage.getItem('chronixedu_support_session_id');
  return sessionId ? { 'x-support-session-id': sessionId } : {};
}

/** Thrown instead of redirecting when a caller passes `deferAuthRedirect`, so it
 *  can save unsaved work (e.g. a half-filled score grid) before calling
 *  `redirectToLogin()` itself. */
export class SessionExpiredError extends Error {
  constructor() {
    super('Your session has expired. Please sign in again.');
    this.name = 'SessionExpiredError';
  }
}

export interface ApiFetchOptions extends RequestInit {
  /** On 401, throw SessionExpiredError instead of redirecting immediately. */
  deferAuthRedirect?: boolean;
}

/** Parses a JSON body, tolerating non-JSON error pages (e.g. a proxy's HTML 502). */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Every failed request throws an ApiError: a readable message (never raw JSON — see
 *  lib/apiError.ts) plus, for validation failures, the per-field messages a form can show. */
function apiError(status: number, json: unknown, fallback: string): ApiError {
  return new ApiError(status, describeApiError(json, fallback));
}

export function redirectToLogin() {
  handleUnauthorized();
}

/** Clears the stored session and sends the user back to login. Called whenever
 *  the API rejects a request with 401 — expired, invalid, or tampered token. The reason
 *  travels in the address, because nobody reads the 401's body (lib/refusalRedirect.ts). */
function handleUnauthorized(code?: string) {
  if (typeof window === 'undefined') return;
  localStorage.removeItem('chronixedu_token');
  localStorage.removeItem('chronixedu_user');
  if (!window.location.pathname.startsWith('/login')) {
    window.location.href = `/login?reason=${loginReasonFor(code)}`;
  }
}

/** A platform admin who must set up two-factor first is sent to the page that does it. */
function handleForbidden(status: number, json: unknown) {
  if (typeof window === 'undefined') return;
  const to = setupRedirectFor(status, errorCode(json), window.location.pathname);
  if (to) window.location.href = to;
}

export async function apiFetch<T = unknown>(
  path: string,
  options: ApiFetchOptions = {}
): Promise<T> {
  const { deferAuthRedirect, ...init } = options;
  const token = getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...getSupportSessionHeader(),
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 401 && deferAuthRedirect) throw new SessionExpiredError();
  const json = await readJson(res);
  if (res.status === 401) handleUnauthorized(errorCode(json));
  if (res.status === 403) handleForbidden(res.status, json);
  if (!res.ok) {
    throw apiError(res.status, json, `Request failed (${res.status})`);
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
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...getSupportSessionHeader() },
  });
  const json = await readJson(res);
  if (res.status === 401) handleUnauthorized(errorCode(json));
  if (res.status === 403) handleForbidden(res.status, json);
  if (!res.ok) {
    throw apiError(res.status, json, `Upload failed (${res.status})`);
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
      ...getSupportSessionHeader(),
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    const json = await readJson(res);
    if (res.status === 401) handleUnauthorized(errorCode(json));
    if (res.status === 403) handleForbidden(res.status, json);
    throw apiError(res.status, json, `Request failed (${res.status})`);
  }
  return res.blob();
}
