import { canonicalJson, type TraceRecord } from '@commerce/incident-bundle';
import { ADMIN_PATH_PREFIX } from '@commerce/telemetry';
import { z } from 'zod';
import { isAdminPath, type CaptureWindow, type HttpFetch } from './deps.js';

/**
 * Jaeger trace capture (docs/prompts/m5-design.md, "Jaeger trace capture"), for Jaeger 2.22.0's
 * `GET /api/v3/traces`, as verified in its source:
 * - `query.searchDepth` limits a search, 0 to 10,000; left unset it is 100, so it is always sent;
 * - both `query.startTimeMin` and `query.startTimeMax` are required, and a trace matches if any of
 *   its spans for the service starts within them, both ends included;
 * - over the limit, the in-memory store keeps the most recently stored matches, and the search
 *   cannot page, so a result of exactly `searchDepth` traces may be truncated;
 * - an empty result is HTTP 404 "No traces found"; otherwise every matching trace's resource
 *   spans come back combined in one `{ result: { resourceSpans } }`.
 *
 * So the window is searched in slices per service; a saturated slice is halved down to the
 * minimum, and truncation is recorded, never silent.
 */
export const DEFAULTS = {
  sliceSeconds: 10,
  minSliceSeconds: 1,
  searchDepth: 1000,
  maxTracesPerService: 5000,
} as const;

const ADMIN_ATTRIBUTES = new Set(['url.path', 'http.target', 'http.route']);

const searchResponse = z.looseObject({
  result: z.looseObject({
    resourceSpans: z.array(
      z.looseObject({
        scopeSpans: z
          .array(
            z.looseObject({
              spans: z.array(z.looseObject({ traceId: z.string(), spanId: z.string() })).optional(),
            }),
          )
          .optional(),
      }),
    ),
  }),
});
type ResourceSpans = z.infer<typeof searchResponse>['result']['resourceSpans'][number];
type Span = Record<string, unknown> & { traceId: string; spanId: string };

type TruncationReason = 'slice_saturated' | 'service_cap';

export interface TracesCapture {
  records: TraceRecord[];
  summary: {
    source: 'jaeger-v3';
    sliceSeconds: number;
    minSliceSeconds: number;
    searchDepth: number;
    maxTracesPerService: number;
    droppedAdminSpans: number;
    services: {
      name: string;
      traces: number;
      saturatedSlices: number;
      truncated: boolean;
      truncationReasons: TruncationReason[];
    }[];
  };
}

export interface TracesOptions extends CaptureWindow {
  baseUrl: string;
  fetch: HttpFetch;
  services: readonly string[];
  sliceSeconds?: number;
  minSliceSeconds?: number;
  searchDepth?: number;
  maxTracesPerService?: number;
}

/** Spans grouped by trace, then by resource and scope, each deduplicated by its JSON. */
class TraceSet {
  private readonly traces = new Map<
    string,
    Map<
      string,
      {
        fields: Record<string, unknown>;
        scopes: Map<string, { fields: Record<string, unknown>; spans: Map<string, Span> }>;
      }
    >
  >();

  add(traceId: string, entries: readonly SpanEntry[]): void {
    let resources = this.traces.get(traceId);
    if (!resources) {
      resources = new Map();
      this.traces.set(traceId, resources);
    }
    for (const { resource, scope, span } of entries) {
      const rKey = canonicalJson(resource);
      let r = resources.get(rKey);
      if (!r) {
        r = { fields: resource, scopes: new Map() };
        resources.set(rKey, r);
      }
      const sKey = canonicalJson(scope);
      let s = r.scopes.get(sKey);
      if (!s) {
        s = { fields: scope, spans: new Map() };
        r.scopes.set(sKey, s);
      }
      if (!s.spans.has(span.spanId)) s.spans.set(span.spanId, span);
    }
  }

  /** One `TracesData` per trace, sorted by trace ID, with `/admin` spans dropped and counted. */
  records(): { records: TraceRecord[]; droppedAdminSpans: number } {
    let droppedAdminSpans = 0;
    const records: TraceRecord[] = [];
    for (const traceId of [...this.traces.keys()].sort()) {
      const resourceSpans = [];
      for (const r of this.traces.get(traceId)?.values() ?? []) {
        const scopeSpans = [];
        for (const s of r.scopes.values()) {
          const spans = [...s.spans.values()].filter((span) => {
            const admin = isAdminSpan(span);
            if (admin) droppedAdminSpans += 1;
            return !admin;
          });
          if (spans.length > 0) scopeSpans.push({ ...s.fields, spans });
        }
        if (scopeSpans.length > 0) resourceSpans.push({ ...r.fields, scopeSpans });
      }
      if (resourceSpans.length > 0) records.push({ resourceSpans } as TraceRecord);
    }
    return { records, droppedAdminSpans };
  }
}

interface SpanEntry {
  resource: Record<string, unknown>;
  scope: Record<string, unknown>;
  span: Span;
}

export async function captureTraces(options: TracesOptions): Promise<TracesCapture> {
  const sliceSeconds = options.sliceSeconds ?? DEFAULTS.sliceSeconds;
  const minSliceSeconds = options.minSliceSeconds ?? DEFAULTS.minSliceSeconds;
  const searchDepth = options.searchDepth ?? DEFAULTS.searchDepth;
  const maxTracesPerService = options.maxTracesPerService ?? DEFAULTS.maxTracesPerService;
  const from = options.captureFrom.getTime();
  const to = options.captureTo.getTime();
  const minMs = minSliceSeconds * 1000;

  const set = new TraceSet();
  const services: TracesCapture['summary']['services'] = [];
  for (const service of options.services) {
    const queue: [number, number][] = [];
    for (let t = from; t < to; t += sliceSeconds * 1000)
      queue.push([t, Math.min(t + sliceSeconds * 1000, to)]);
    const found = new Set<string>();
    const reasons = new Set<TruncationReason>();
    let saturatedSlices = 0;

    search: while (queue.length > 0) {
      const [a, b] = queue.shift() ?? [from, to];
      const byTrace = await search(options, service, a, b, searchDepth);
      if (byTrace.size >= searchDepth) {
        if (b - a > minMs) {
          const mid = a + Math.max(minMs, Math.floor((b - a) / 2));
          queue.unshift([a, mid], [mid, b]);
        } else {
          saturatedSlices += 1;
          reasons.add('slice_saturated');
        }
      }
      for (const traceId of [...byTrace.keys()].sort()) {
        if (!found.has(traceId)) {
          if (found.size >= maxTracesPerService) {
            reasons.add('service_cap');
            break search;
          }
          found.add(traceId);
        }
        set.add(traceId, byTrace.get(traceId) ?? []);
      }
    }
    const truncationReasons = [...reasons].sort();
    services.push({
      name: service,
      traces: found.size,
      saturatedSlices,
      truncated: truncationReasons.length > 0,
      truncationReasons,
    });
  }

  const { records, droppedAdminSpans } = set.records();
  return {
    records,
    summary: {
      source: 'jaeger-v3',
      sliceSeconds,
      minSliceSeconds,
      searchDepth,
      maxTracesPerService,
      droppedAdminSpans,
      services,
    },
  };
}

async function search(
  options: TracesOptions,
  service: string,
  from: number,
  to: number,
  searchDepth: number,
): Promise<Map<string, SpanEntry[]>> {
  const params = new URLSearchParams({
    'query.serviceName': service,
    'query.startTimeMin': new Date(from).toISOString(),
    'query.startTimeMax': new Date(to).toISOString(),
    'query.searchDepth': String(searchDepth),
  });
  const res = await options.fetch(
    `${options.baseUrl.replace(/\/$/, '')}/api/v3/traces?${params.toString()}`,
  );
  const text = await res.text();
  const window = `${service} [${new Date(from).toISOString()}, ${new Date(to).toISOString()}]`;
  if (res.status === 404 && text.includes('No traces found')) return new Map();
  if (res.status !== 200) {
    throw new Error(
      `Jaeger trace search for ${window} failed: HTTP ${String(res.status)}: ${text.trim()}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const parsed = searchResponse.safeParse(body);
  if (!parsed.success)
    throw new Error(`Jaeger trace search for ${window} returned an unexpected response`);

  const byTrace = new Map<string, SpanEntry[]>();
  for (const rs of parsed.data.result.resourceSpans) {
    const resource = withoutKey(rs, 'scopeSpans');
    for (const ss of rs.scopeSpans ?? []) {
      const scope = withoutKey(ss, 'spans');
      for (const span of ss.spans ?? []) {
        const list = byTrace.get(span.traceId) ?? [];
        list.push({ resource, scope, span });
        byTrace.set(span.traceId, list);
      }
    }
  }
  return byTrace;
}

function withoutKey(
  value: ResourceSpans | Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
}

function isAdminSpan(span: Span): boolean {
  const attributes = Array.isArray(span.attributes) ? (span.attributes as unknown[]) : [];
  return attributes.some((a) => {
    const attr = a as { key?: unknown; value?: { stringValue?: unknown } } | null;
    return (
      typeof attr?.key === 'string' &&
      ADMIN_ATTRIBUTES.has(attr.key) &&
      isAdminPath(attr.value?.stringValue, ADMIN_PATH_PREFIX)
    );
  });
}
