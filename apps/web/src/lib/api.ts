import type { ApiErrorBody, Attachment } from '@convo/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details: { path: string; message: string }[] = [],
  ) {
    super(message);
  }

  /** Field errors keyed by path, for showing next to form inputs. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.details.map((d) => [d.path, d.message]));
  }
}

type Query = Record<string, string | number | undefined | null | string[]>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Sent as-is with Content-Type application/octet-stream, e.g. a file. */
  file?: Blob;
  query?: Query;
}

function buildUrl(path: string, query?: Query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    params.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const qs = params.toString();
  return `/api${path}${qs ? `?${qs}` : ''}`;
}

// Several requests can fail with 401 at the same moment. They share one refresh call.
let refreshing: Promise<boolean> | null = null;
function refreshSession() {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false)
    .finally(() => {
      setTimeout(() => (refreshing = null), 0);
    });
  return refreshing;
}

async function send(path: string, { method = 'GET', body, file, query }: RequestOptions) {
  const headers = file
    ? { 'Content-Type': 'application/octet-stream' }
    : body === undefined
      ? undefined
      : { 'Content-Type': 'application/json' };
  return fetch(buildUrl(path, query), {
    method,
    credentials: 'same-origin',
    headers,
    body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);

  if (res.status === 401 && !path.startsWith('/auth/')) {
    if (await refreshSession()) {
      res = await send(path, options);
    }
    if (res.status === 401 && typeof window !== 'undefined') {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.assign(`/login?next=${next}`);
    }
  }

  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, err?.code ?? 'UNKNOWN', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

export function uploadFile(channelId: string, file: File) {
  return api<{ attachment: Attachment }>(`/channels/${channelId}/attachments`, {
    method: 'POST',
    file,
    query: { name: file.name, type: file.type },
  }).then((r) => r.attachment);
}
