import { z } from 'zod';

/**
 * Incident dashboard configuration, validated with Zod at startup. The server always binds to
 * 127.0.0.1, and every upstream it reads is a loopback IP literal: it reads local evidence and
 * local health endpoints only, and is never meant to be reachable from elsewhere.
 */
export const HOST = '127.0.0.1';

export interface WebConfig {
  port: number;
  incidentsDir: string;
  /** Orders API base URL, for `/readyz` and the scenario report. */
  ordersApiUrl: string;
  /** Worker health server base URL, for `/readyz`. */
  workerUrl: string;
  prometheusUrl: string;
  /** Jaeger UI base URL, for health and trace links. */
  jaegerUrl: string;
}

export class WebConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebConfigError';
  }
}

const loopbackUrl = (fallback: string) =>
  z
    .string()
    .trim()
    .default(fallback)
    .refine((v) => {
      if (!URL.canParse(v)) return false;
      const u = new URL(v);
      return u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === '[::1]');
    }, 'must be an http URL on 127.0.0.1 or [::1]');

const schema = z.object({
  WEB_PORT: z.coerce.number().int().min(1024).max(65535).default(3100),
  INCIDENTS_DIR: z.string().trim().min(1).default('incidents'),
  ORDERS_API_URL: loopbackUrl('http://127.0.0.1:3000'),
  WORKER_HEALTH_URL: loopbackUrl('http://127.0.0.1:3001'),
  PROMETHEUS_URL: loopbackUrl('http://127.0.0.1:9090'),
  JAEGER_URL: loopbackUrl('http://127.0.0.1:16686'),
});

const blankToUndefined = (v: string | undefined) => (v === '' ? undefined : v);

export function loadWebConfig(env: Record<string, string | undefined>): WebConfig {
  const parsed = schema.safeParse({
    WEB_PORT: blankToUndefined(env.WEB_PORT),
    INCIDENTS_DIR: blankToUndefined(env.INCIDENTS_DIR),
    ORDERS_API_URL: blankToUndefined(env.ORDERS_API_URL),
    WORKER_HEALTH_URL: blankToUndefined(env.WORKER_HEALTH_URL),
    PROMETHEUS_URL: blankToUndefined(env.PROMETHEUS_URL),
    JAEGER_URL: blankToUndefined(env.JAEGER_URL),
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new WebConfigError(
      `${String(issue?.path[0] ?? 'environment')}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const strip = (v: string) => v.replace(/\/+$/, '');
  return {
    port: parsed.data.WEB_PORT,
    incidentsDir: parsed.data.INCIDENTS_DIR,
    ordersApiUrl: strip(parsed.data.ORDERS_API_URL),
    workerUrl: strip(parsed.data.WORKER_HEALTH_URL),
    prometheusUrl: strip(parsed.data.PROMETHEUS_URL),
    jaegerUrl: strip(parsed.data.JAEGER_URL),
  };
}
