import type { MetricsRecord, TraceRecord } from '@commerce/incident-bundle';
import type { ComposeContainer, RunCommandSimple } from './isolation.js';

/**
 * Manifest metadata (docs/prompts/m5c-design.md, section 6, "Manifest provenance"). Nothing is
 * inferred beyond these sources: `producer.commit` is the checkout's commit, which may differ
 * from the running image's.
 */
export async function producer(run: RunCommandSimple): Promise<{ commit: string; dirty: boolean }> {
  const head = await run('git', ['rev-parse', 'HEAD']);
  const commit = head.stdout.trim();
  if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`git rev-parse HEAD failed: ${head.stderr.trim() || commit}`);
  }
  const status = await run('git', ['status', '--porcelain']);
  if (status.exitCode !== 0) throw new Error(`git status failed: ${status.stderr.trim()}`);
  return { commit, dirty: status.stdout.trim() !== '' };
}

/** Each Compose service's image, from `docker compose ps --format json`. */
export function images(containers: readonly ComposeContainer[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of [...containers].sort((a, b) => (a.Service < b.Service ? -1 : 1))) {
    if (c.Image !== '') out[c.Service] = c.Image;
  }
  return out;
}

export type ServiceEntry = {
  name: string;
  version: string;
  instanceId: string;
};

function stringAttr(attributes: unknown, key: string): string | undefined {
  if (!Array.isArray(attributes)) return undefined;
  for (const a of attributes as { key?: unknown; value?: { stringValue?: unknown } }[]) {
    if (a.key === key && typeof a.value?.stringValue === 'string') return a.value.stringValue;
  }
  return undefined;
}

/**
 * Services from trace resource attributes; a service without traces falls back to the Prometheus
 * `job` and `instance` labels with version "unknown", and a warning.
 */
export function services(
  expected: readonly string[],
  traces: readonly TraceRecord[],
  metrics: readonly MetricsRecord[],
): { services: ServiceEntry[]; warnings: string[] } {
  const found = new Map<string, ServiceEntry>();
  for (const t of traces) {
    for (const rs of t.resourceSpans) {
      const attributes = (rs.resource as { attributes?: unknown } | undefined)?.attributes;
      const name = stringAttr(attributes, 'service.name');
      const version = stringAttr(attributes, 'service.version');
      const instanceId = stringAttr(attributes, 'service.instance.id');
      if (name && version && instanceId)
        found.set(`${name}|${version}|${instanceId}`, { name, version, instanceId });
    }
  }
  const warnings: string[] = [];
  const withTraces = new Set([...found.values()].map((s) => s.name));
  for (const name of expected) {
    if (withTraces.has(name)) continue;
    const instances = new Set(
      metrics
        .filter((m) => m.labels.job === name && m.labels.instance)
        .map((m) => m.labels.instance ?? ''),
    );
    if (instances.size === 0) {
      warnings.push(
        `service ${name} appears in neither traces nor metrics; omitted from the manifest`,
      );
      continue;
    }
    for (const instanceId of [...instances].sort()) {
      found.set(`${name}|unknown|${instanceId}`, { name, version: 'unknown', instanceId });
    }
    warnings.push(
      `service ${name} has no traces; its version is "unknown" (from Prometheus labels)`,
    );
  }
  const list = [...found.values()].sort((a, b) =>
    `${a.name}|${a.instanceId}|${a.version}` < `${b.name}|${b.instanceId}|${b.version}` ? -1 : 1,
  );
  return { services: list, warnings };
}
