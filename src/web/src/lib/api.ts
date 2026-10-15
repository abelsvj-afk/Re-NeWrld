/**
 * Provider-neutral API client for the Re:NeWrld backend.
 * All requests go through here — no fetch() calls elsewhere in the app.
 */

const API_BASE = import.meta.env.VITE_API_URL ?? '';
// Empty string = same origin. Correct when backend serves the frontend,
// and VITE_API_URL overrides for dev (e.g. http://localhost:3000).

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export async function api<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...opts.headers,
  };

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    credentials: 'include',
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(
      res.status,
      data.code ?? 'UNKNOWN',
      data.message ?? friendlyErrorMessage(res.status),
    );
  }
  return data as T;
}

function friendlyErrorMessage(status: number): string {
  switch (status) {
    case 400: return 'Something wasn\u2019t quite right with that request. Check your input and try again.';
    case 401: return 'You need to sign in to do that.';
    case 403: return 'You don\u2019t have permission to do that.';
    case 404: return 'We couldn\u2019t find what you were looking for.';
    case 409: return 'That already exists \u2014 try a different name.';
    case 429: return 'Too many attempts. Give it a moment and try again.';
    case 500: return 'Something went wrong on our end. Please try again.';
    default: return 'Something went wrong. Please try again.';
  }
}

// --- Auth ---
export interface User {
  id: string;
  email: string;
  role: 'creator' | 'reader' | 'admin';
}

export const authApi = {
  login: (email: string, password: string) =>
    api<User>('/auth/login', {
      method: 'POST',
      body: { email, password },
    }),
  register: (email: string, password: string, role: 'creator' | 'reader') =>
    api<User>('/auth/register', {
      method: 'POST',
      body: { email, password, role },
    }),
  me: () => api<User>('/auth/me'),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  becomeCreator: () =>
    api<User>('/auth/become-creator', { method: 'POST' }),
};

// --- Worlds ---
export interface WorldSummary {
  id: string;
  title: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  updatedAt: string;
  metadata?: { genre?: string; tags?: string[] };
}

export interface SceneSummary {
  id: string;
  worldId: string;
  chapterId: string;
  title: string;
  prose: string;
  isEnding: boolean;
}

export interface ChoiceSummary {
  id: string;
  worldId: string;
  sceneId: string;
  targetSceneId: string;
  text: string;
  conditions: unknown;
  mutations: unknown;
  sortOrder: number;
}

export const worldsApi = {
  list: async (): Promise<WorldSummary[]> => {
    const res = await api<{ worlds: WorldSummary[] } | WorldSummary[]>('/worlds');
    return Array.isArray(res) ? res : res.worlds ?? [];
  },
  create: (input: { title: string; description?: string; metadata?: { genre?: string; tags?: string[] } }) =>
    api<WorldSummary>('/worlds', { method: 'POST', body: input }),
  get: (id: string) => api<WorldSummary & { scenes: unknown[] }>(`/worlds/${id}`),
  update: (id: string, input: { title?: string; description?: string; metadata?: { genre?: string; tags?: string[] } }) =>
    api<void>(`/worlds/${id}`, { method: 'PATCH', body: input }),
  remove: (id: string) =>
    api<void>(`/worlds/${id}`, { method: 'DELETE' }),
  scenes: (worldId: string) => api<SceneSummary[]>(`/worlds/${worldId}/scenes`),
  createScene: (worldId: string, input: { chapterId: string; title: string; prose: string; isEnding?: boolean }) =>
    api<{ sceneId: string }>(`/worlds/${worldId}/scenes`, { method: 'POST', body: input }),
  updateScene: (worldId: string, sceneId: string, input: { title?: string; prose?: string; isEnding?: boolean }) =>
    api<void>(`/worlds/${worldId}/scenes/${sceneId}`, { method: 'PATCH', body: input }),
  choices: (worldId: string) => api<ChoiceSummary[]>(`/worlds/${worldId}/choices`),
  createChoice: (worldId: string, input: { sceneId: string; targetSceneId: string; text: string; conditions?: unknown; mutations?: unknown }) =>
    api<{ choiceId: string }>(`/worlds/${worldId}/choices`, { method: 'POST', body: input }),
  publish: (worldId: string) =>
    api<{ snapshotId: string; versionNumber: number; warnings: string[] }>(`/worlds/${worldId}/publish`, { method: 'POST' }),
  // --- Narration (ADR-016) ---
  narrationVoices: (worldId: string) =>
    api<{ voiceId: string; name: string }[]>(`/worlds/${worldId}/narration/voices`),
  narrationQuota: (worldId: string) =>
    api<{ usedThisMonth: number; monthlyCap: number; providerRemaining: number | null; configured: boolean }>(`/worlds/${worldId}/narration/quota`),
  generateNarration: (worldId: string, sceneId: string, input: { voiceId: string; modelId?: string }) =>
    api<{ status: 'cached' | 'generated'; audioPath: string; characterCount: number }>(`/worlds/${worldId}/scenes/${sceneId}/narration`, { method: 'POST', body: input }),
  narrationAudioUrl: (worldId: string, sceneId: string) =>
    `${API_BASE}/worlds/${worldId}/scenes/${sceneId}/narration`,
  narrationStatus: (worldId: string) =>
    api<Record<string, boolean>>(`/worlds/${worldId}/narration/status`),
  // --- Published catalog (H-UX2) ---
  listPublished: (filters?: { genre?: string; tag?: string; search?: string; limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (filters?.genre) params.set('genre', filters.genre);
    if (filters?.tag) params.set('tag', filters.tag);
    if (filters?.search) params.set('search', filters.search);
    if (filters?.limit) params.set('limit', String(filters.limit));
    if (filters?.offset) params.set('offset', String(filters.offset));
    const qs = params.toString();
    return api<PublishedWorld[]>(`/worlds/published${qs ? `?${qs}` : ''}`);
  },
};

export interface PublishedWorld {
  id: string;
  title: string;
  description: string | null;
  genre: string | null;
  tags: string[];
  updatedAt: string;
}

export const WORLD_GENRES = [
  'fantasy', 'sci-fi', 'romance', 'mystery', 'horror',
  'adventure', 'drama', 'comedy', 'historical', 'other',
] as const;

// --- Sessions (reader) ---
export interface ChoiceOption {
  id: string;
  text: string;
  available: boolean;
  unavailableReason?: string;
}

export interface SessionState {
  id: string;
  worldId: string;
  currentSceneId: string;
  sceneText: string;
  choices: ChoiceOption[];
  variables: Record<string, unknown>;
  version: number;
}

export const sessionsApi = {
  start: (worldId: string) =>
    api<SessionState>('/sessions', { method: 'POST', body: { worldId } }),
  get: (id: string) => api<SessionState>(`/sessions/${id}`),
  choose: (id: string, choiceId: string, version: number, idempotencyKey: string) =>
    api<SessionState>(`/sessions/${id}/choices`, {
      method: 'POST',
      body: { choiceId, expectedVersion: version },
      headers: { 'X-Idempotency-Key': idempotencyKey },
    }),
};
