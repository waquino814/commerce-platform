import type { HealthReport } from '../../src/health.js';
import type { IncidentDetail, IncidentList } from '../../src/incidents.js';
import type { IncidentTelemetry } from '../../src/telemetry.js';

/**
 * The dashboard server's JSON API. Types come from the server modules themselves (type-only
 * imports, erased at build time), so the client and server cannot drift apart.
 */
export type { HealthReport, IncidentDetail, IncidentList, IncidentTelemetry };
export type IncidentDetailResponse = IncidentDetail & { jaegerUrl: string };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { accept: 'application/json' },
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'The dashboard server could not be reached.');
  }
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (body ?? {}) as { error?: unknown; message?: unknown };
    throw new ApiError(
      res.status,
      typeof e.error === 'string' ? e.error : 'http_error',
      typeof e.message === 'string' ? e.message : `The server answered ${String(res.status)}.`,
    );
  }
  return body as T;
}

export const api = {
  incidents: (signal?: AbortSignal) => getJson<IncidentList>('/api/incidents', signal),
  incident: (id: string, signal?: AbortSignal) =>
    getJson<IncidentDetailResponse>(`/api/incidents/${encodeURIComponent(id)}`, signal),
  telemetry: (id: string, signal?: AbortSignal) =>
    getJson<IncidentTelemetry>(`/api/incidents/${encodeURIComponent(id)}/telemetry`, signal),
  health: (signal?: AbortSignal) => getJson<HealthReport>('/api/health', signal),
  fileUrl: (id: string, file: string) =>
    `/api/incidents/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`,
};
