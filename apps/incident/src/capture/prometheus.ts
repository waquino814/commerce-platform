import { canonicalJson, type MetricsRecord } from '@commerce/incident-bundle';
import { METRIC } from '@commerce/telemetry';
import { z } from 'zod';
import type { CaptureWindow, HttpFetch } from './deps.js';

/**
 * Prometheus capture (docs/prompts/m5-design.md, "Prometheus capture"): one `query_range` per
 * Prometheus name of the M3 catalog, from `captureFrom - 60 s` to `captureTo + 60 s` at a 5 s step.
 * Values stay the strings Prometheus returns, so `NaN`, `+Inf` and `-Inf` survive.
 */
export const STEP_SECONDS = 5;
export const MARGIN_MS = 60_000;

type Kind = 'histogram' | 'counter' | 'up-down-counter' | 'gauge';

/** Each catalog metric's instrument kind and whether its unit is seconds (M3 design, "Metrics"). */
export const CATALOG: Readonly<Record<string, { kind: Kind; seconds: boolean }>> = {
  [METRIC.httpServerRequestDuration]: { kind: 'histogram', seconds: true },
  [METRIC.dbConnectionCount]: { kind: 'up-down-counter', seconds: false },
  [METRIC.dbConnectionPendingRequests]: { kind: 'up-down-counter', seconds: false },
  [METRIC.dbConnectionMax]: { kind: 'up-down-counter', seconds: false },
  [METRIC.orders]: { kind: 'gauge', seconds: false },
  [METRIC.workerPasses]: { kind: 'counter', seconds: false },
  [METRIC.workerInflight]: { kind: 'gauge', seconds: false },
  [METRIC.paymentCalls]: { kind: 'counter', seconds: false },
  [METRIC.paymentDuration]: { kind: 'histogram', seconds: true },
  [METRIC.claimsRecovered]: { kind: 'counter', seconds: false },
  [METRIC.claimsReleased]: { kind: 'counter', seconds: false },
};

/**
 * The collector's default translation: dots become underscores, `s` becomes `_seconds`,
 * curly-brace units are dropped, counters gain `_total`, histograms expand to three series.
 */
export function prometheusNames(metric: string, entry: { kind: Kind; seconds: boolean }): string[] {
  const base = metric.replaceAll('.', '_') + (entry.seconds ? '_seconds' : '');
  if (entry.kind === 'histogram') return [`${base}_bucket`, `${base}_count`, `${base}_sum`];
  if (entry.kind === 'counter') return [`${base}_total`];
  return [base];
}

/** The 15 Prometheus names captured, as the M3 spike confirmed them. */
export const PROMETHEUS_SERIES: readonly string[] = [
  'http_server_request_duration_seconds_bucket',
  'http_server_request_duration_seconds_count',
  'http_server_request_duration_seconds_sum',
  'db_client_connection_count',
  'db_client_connection_pending_requests',
  'db_client_connection_max',
  'commerce_orders',
  'commerce_worker_passes_total',
  'commerce_worker_inflight',
  'commerce_payment_calls_total',
  'commerce_payment_duration_seconds_bucket',
  'commerce_payment_duration_seconds_count',
  'commerce_payment_duration_seconds_sum',
  'commerce_claims_recovered_total',
  'commerce_claims_released_total',
];

const queryRangeResponse = z.looseObject({
  status: z.literal('success'),
  data: z.looseObject({
    resultType: z.literal('matrix'),
    result: z.array(
      z.looseObject({
        metric: z.record(z.string(), z.string()),
        values: z.array(z.tuple([z.number(), z.string()])),
      }),
    ),
  }),
});

export interface MetricsCapture {
  records: MetricsRecord[];
  summary: {
    source: 'prometheus';
    stepSeconds: number;
    series: { name: string; seriesCount: number }[];
  };
}

export async function captureMetrics(
  options: CaptureWindow & { baseUrl: string; fetch: HttpFetch },
): Promise<MetricsCapture> {
  const start = (options.captureFrom.getTime() - MARGIN_MS) / 1000;
  const end = (options.captureTo.getTime() + MARGIN_MS) / 1000;
  const records: MetricsRecord[] = [];
  const series: { name: string; seriesCount: number }[] = [];
  for (const name of PROMETHEUS_SERIES) {
    const params = new URLSearchParams({
      query: name,
      start: String(start),
      end: String(end),
      step: String(STEP_SECONDS),
    });
    const url = `${options.baseUrl.replace(/\/$/, '')}/api/v1/query_range?${params.toString()}`;
    const res = await options.fetch(url);
    const body: unknown = await res.json().catch(() => undefined);
    const parsed = queryRangeResponse.safeParse(body);
    if (res.status !== 200 || !parsed.success) {
      throw new Error(
        `Prometheus query_range for ${name} failed: HTTP ${String(res.status)}: ${errorText(body)}`,
      );
    }
    for (const r of parsed.data.data.result) {
      const labels = Object.fromEntries(
        Object.entries(r.metric).filter(([key]) => key !== '__name__'),
      );
      records.push({ name, labels, samples: r.values });
    }
    series.push({ name, seriesCount: parsed.data.data.result.length });
  }
  records.sort(
    (a, b) => compare(a.name, b.name) || compare(canonicalJson(a.labels), canonicalJson(b.labels)),
  );
  return { records, summary: { source: 'prometheus', stepSeconds: STEP_SECONDS, series } };
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function errorText(body: unknown): string {
  const error = (body as { error?: unknown } | undefined)?.error;
  return typeof error === 'string' ? error : 'unexpected response';
}
