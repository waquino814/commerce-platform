/** Display helpers. Values come straight from the API; nothing here invents data. */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${String(Math.round(ms))} ms`;
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d
        .toISOString()
        .replace('T', ' ')
        .replace(/\.\d{3}Z$/, ' UTC');
}

export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'missing';
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export interface ConditionLike {
  metric: string;
  matchers: Record<string, string>;
  evaluation: string;
  windowSeconds: number;
  comparison: string;
  threshold: number;
}

const OPERATORS: Record<string, string> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };

/** The PromQL the incident CLI renders for a condition (docs/prompts/m5-design.md). */
export function renderCondition(c: ConditionLike): string {
  const matchers = Object.keys(c.matchers)
    .sort()
    .map((k) => `${k}="${c.matchers[k] ?? ''}"`)
    .join(', ');
  const aggregate = c.evaluation === 'max_over_time' ? 'max' : 'sum';
  return `${aggregate}(${c.evaluation}(${c.metric}{${matchers}}[${String(c.windowSeconds)}s])) ${OPERATORS[c.comparison] ?? c.comparison} ${String(c.threshold)}`;
}
