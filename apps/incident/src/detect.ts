import type { Condition } from '@commerce/incident-bundle';
import { z } from 'zod';
import { request, type ControlDeps } from './control.js';

/**
 * Symptom detection (docs/prompts/m5c-design.md, sections 4.2 and 5): the ground truth's primary
 * symptom as an instant PromQL query. A returned sample means detected; an empty result is a valid
 * observation; a failed poll is never counted as empty.
 */
const OPERATORS = { gt: '>', gte: '>=', lt: '<', lte: '<=' } as const;

/** `sum(<evaluation>(<metric>{<matchers>}[<window>s])) <op> <threshold>`, `max` for max_over_time. */
export function renderCondition(condition: Condition): string {
  const matchers = Object.keys(condition.matchers)
    .sort()
    .map(
      (k) => `${k}="${(condition.matchers[k] ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`,
    )
    .join(', ');
  const aggregate = condition.evaluation === 'max_over_time' ? 'max' : 'sum';
  return `${aggregate}(${condition.evaluation}(${condition.metric}{${matchers}}[${String(condition.windowSeconds)}s])) ${OPERATORS[condition.comparison]} ${String(condition.threshold)}`;
}

const queryBody = z.looseObject({
  status: z.literal('success'),
  data: z.looseObject({ result: z.array(z.unknown()) }),
});

export type PollResult =
  { kind: 'sample' } | { kind: 'empty' } | { kind: 'failed'; reason: string };

/** One poll, with its own timeout. */
export async function poll(
  deps: Omit<ControlDeps, 'baseUrl'> & { prometheusUrl: string },
  query: string,
  timeoutMs: number,
): Promise<PollResult> {
  try {
    const res = await request(
      { ...deps, baseUrl: deps.prometheusUrl },
      'GET',
      `/api/v1/query?${new URLSearchParams({ query }).toString()}`,
      timeoutMs,
    );
    if (res.status !== 200) return { kind: 'failed', reason: `HTTP ${String(res.status)}` };
    const parsed = queryBody.safeParse(res.body);
    if (!parsed.success) return { kind: 'failed', reason: 'malformed response' };
    return parsed.data.data.result.length > 0 ? { kind: 'sample' } : { kind: 'empty' };
  } catch (err) {
    return { kind: 'failed', reason: err instanceof Error ? err.message : String(err) };
  }
}
