import type { Attributes, Meter } from '@opentelemetry/api';
import {
  MeterProvider,
  MetricReader,
  type DataPoint,
  type Histogram,
  type MetricData,
} from '@opentelemetry/sdk-metrics';
import { selectMetricTemporality } from '../src/sdk.js';

/**
 * A reader the test triggers: `collect()` reads every instrument, with the production temporality
 * (cumulative, except delta for observable gauges).
 */
export class CollectingReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: selectMetricTemporality });
  }

  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface TestMeter {
  meter: Meter;
  reader: CollectingReader;
  /** Every metric collected now, across scopes. */
  collect(): Promise<MetricData[]>;
  shutdown(): Promise<void>;
}

/** An in-memory meter, independent of the global meter provider. */
export function createTestMeter(): TestMeter {
  const reader = new CollectingReader();
  const provider = new MeterProvider({ readers: [reader] });
  return {
    meter: provider.getMeter('test'),
    reader,
    async collect() {
      const { resourceMetrics, errors } = await reader.collect();
      if (errors.length > 0) throw new Error(`collect errors: ${String(errors[0])}`);
      return resourceMetrics.scopeMetrics.flatMap((s) => s.metrics);
    },
    shutdown: () => provider.shutdown(),
  };
}

export function metricNamed(metrics: MetricData[], name: string): MetricData | undefined {
  return metrics.find((m) => m.descriptor.name === name);
}

/** Data points of a metric as `{ attributes, value }`, with histograms reduced to their count. */
export function pointsOf(
  metrics: MetricData[],
  name: string,
): { attributes: Attributes; value: number }[] {
  const metric = metricNamed(metrics, name);
  if (!metric) return [];
  return (metric.dataPoints as DataPoint<number | Histogram>[]).map((p) => ({
    attributes: p.attributes,
    value: typeof p.value === 'number' ? p.value : p.value.count,
  }));
}

/** The value of the point whose attributes equal `attributes` exactly, or undefined. */
export function valueAt(
  metrics: MetricData[],
  name: string,
  attributes: Attributes,
): number | undefined {
  const key = JSON.stringify(sortKeys(attributes));
  return pointsOf(metrics, name).find((p) => JSON.stringify(sortKeys(p.attributes)) === key)?.value;
}

/** One string per series, `name{key=value,...}`, for counting and closed-set checks. */
export function seriesOf(metrics: MetricData[]): string[] {
  return metrics.flatMap((m) =>
    pointsOf(metrics, m.descriptor.name).map(
      (p) =>
        `${m.descriptor.name}{${Object.entries(sortKeys(p.attributes))
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(',')}}`,
    ),
  );
}

/** Every label value of every series, as strings. */
export function labelValuesOf(metrics: MetricData[]): string[] {
  return metrics.flatMap((m) =>
    pointsOf(metrics, m.descriptor.name).flatMap((p) =>
      Object.values(p.attributes).map((v) => String(v)),
    ),
  );
}

function sortKeys(attributes: Attributes): Attributes {
  return Object.fromEntries(Object.entries(attributes).sort(([a], [b]) => a.localeCompare(b)));
}
