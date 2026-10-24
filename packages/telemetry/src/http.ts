import { trace } from '@opentelemetry/api';

/** Health probes: never traced, never counted in request metrics. */
export const PROBE_PATHS: ReadonlySet<string> = new Set(['/healthz', '/readyz']);

export function isProbePath(url: string | undefined): boolean {
  return PROBE_PATHS.has((url ?? '').split('?')[0] ?? '');
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
