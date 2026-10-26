/**
 * Where the browser sends API requests. Defaults to same-origin `/api`, which the Vite dev and
 * preview servers proxy to the orders API; set VITE_API_BASE_URL at build time to change it.
 */
export function apiBaseUrl(value: string | undefined): string {
  const base = value?.trim() || '/api';
  return base.replace(/\/+$/, '');
}

export const API_BASE_URL = apiBaseUrl(import.meta.env.VITE_API_BASE_URL as string | undefined);
