import { trace } from '@opentelemetry/api';

/** Health probes: never traced, never counted in request metrics. */
export const PROBE_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

/**
 * M5 scenario control paths. Like probes, they are never traced or counted, whether faults are
 * enabled or not, so incident telemetry never shows a scenario being started.
 */
export const ADMIN_PATH_PREFIX = '/admin';

/** True for health probes and for `/admin` and anything under it. */
export function isProbePath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0] ?? '';
  return (
    PROBE_PATHS.has(path) || path === ADMIN_PATH_PREFIX || path.startsWith(`${ADMIN_PATH_PREFIX}/`)
  );
}

/**
 * Renames the active HTTP server span to `<METHOD> <route template>` and sets `http.route`.
 * Call from a Fastify `onRequest` hook with `request.routeOptions.url`. Unmatched routes keep the
 * instrumentation's default name and get no `http.route`, so raw URLs never become span names.
 */
export function nameServerSpan(method: string, routeTemplate: string | undefined): void {
  const span = trace.getActiveSpan();
  if (!span || !routeTemplate) return;
  span.updateName(`${method} ${routeTemplate}`);
  span.setAttribute('http.route', routeTemplate);
}
