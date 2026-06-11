// Single place for talking to the backend: token storage, automatic JWT refresh,
// JSON + error handling. Every page imports from here instead of using fetch directly.
import { API_BASE } from './config.js';

const ACCESS_KEY = 'aperture.accessToken';
const REFRESH_KEY = 'aperture.refreshToken';

export const tokens = {
  get access() { return localStorage.getItem(ACCESS_KEY); },
  get refresh() { return localStorage.getItem(REFRESH_KEY); },
  save({ accessToken, refreshToken }) {
    localStorage.setItem(ACCESS_KEY, accessToken);
    localStorage.setItem(REFRESH_KEY, refreshToken);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

// Wraps the backend's RFC 7807 problem responses:
// { title, status, detail, code, errors: [{field, message}] }
export class ApiError extends Error {
  constructor(problem, status) {
    super(problem.detail || problem.title || `HTTP ${status}`);
    this.status = status;
    this.code = problem.code ?? null;
    this.fieldErrors = problem.errors ?? [];
  }
}

async function parseProblem(res) {
  try { return await res.json(); } catch { return {}; }
}

let refreshing = null; // shared promise: parallel 401s trigger only ONE refresh call

async function refreshTokens() {
  refreshing ??= (async () => {
    const res = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: tokens.refresh }),
    });
    if (!res.ok) {
      // Session is gone (expired/revoked/reused). Clear and send to login.
      tokens.clear();
      location.replace('index.html');
      throw new ApiError(await parseProblem(res), res.status);
    }
    tokens.save(await res.json()); // rotating refresh token: always store the new pair
  })().finally(() => { refreshing = null; });
  return refreshing;
}

// Core request. opts: { method, body, auth (default true), raw (return Response) }
async function request(path, { method = 'GET', body, auth = true, raw = false } = {}, retried = false) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && tokens.access) headers['Authorization'] = `Bearer ${tokens.access}`;

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Access token expired → refresh once, then retry the original call once.
  if (res.status === 401 && auth && !retried && tokens.refresh) {
    await refreshTokens();
    return request(path, { method, body, auth, raw }, true);
  }
  if (!res.ok) throw new ApiError(await parseProblem(res), res.status);
  if (raw) return res;
  if (res.status === 204 || res.status === 202) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

export const api = {
  get: (p) => request(p),
  post: (p, body) => request(p, { method: 'POST', body }),
  put: (p, body) => request(p, { method: 'PUT', body }),
  patch: (p, body) => request(p, { method: 'PATCH', body }),
  del: (p) => request(p, { method: 'DELETE' }),
  public: {
    get: (p) => request(p, { auth: false }),
    post: (p, body) => request(p, { method: 'POST', body, auth: false }),
  },
  // Fetch a protected binary (video segment) and return an object URL for <video>/<a>.
  async blobUrl(path) {
    const res = await request(path, { raw: true });
    return URL.createObjectURL(await res.blob());
  },
};

// Call at the top of every logged-in page.
export function requireAuth() {
  if (!tokens.refresh) location.replace('index.html');
}

export async function logout() {
  try { await api.post('/api/v1/auth/logout'); } catch { /* session may already be gone */ }
  tokens.clear();
  location.replace('index.html');
}

// Session id of THIS login, read from the JWT 'sid' claim (marks "current" in the session list).
export function currentSessionId() {
  const t = tokens.access;
  if (!t) return null;
  try {
    const payload = t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payload)).sid ?? null;
  } catch { return null; }
}
