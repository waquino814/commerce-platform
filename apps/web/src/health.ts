import type { WebConfig } from './config.js';

/**
 * Live readiness of the local stack, read from each component's own endpoint at request time.
 * Nothing is cached or assumed: a component that does not answer within the timeout is
 * `unreachable`, and one that answers with a non-2xx status is `down`.
 */
export type HealthStatus = 'up' | 'down' | 'unreachable';

export interface ComponentHealth {
  name: 'orders-api' | 'worker' | 'prometheus' | 'jaeger';
  url: string;
  status: HealthStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  detail: string;
}

export interface FaultState {
  /** `enabled` when GET /admin/scenarios/active answers 200, `disabled` on 404. */
  controls: 'enabled' | 'disabled' | 'unknown';
  activeScenario: string | null;
}

export interface HealthReport {
  checkedAt: string;
  components: ComponentHealth[];
  faults: FaultState;
}

export interface HealthDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  now: () => number;
  wallClock: () => Date;
  timeoutMs?: number;
}

async function probe(
  name: ComponentHealth['name'],
  url: string,
  deps: HealthDeps,
): Promise<ComponentHealth> {
  const started = deps.now();
  try {
    const res = await deps.fetch(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 2000) });
    await res.arrayBuffer().catch(() => undefined);
    const latencyMs = Math.round(deps.now() - started);
    const up = res.status >= 200 && res.status < 300;
    return {
      name,
      url,
      status: up ? 'up' : 'down',
      httpStatus: res.status,
      latencyMs,
      detail: `HTTP ${String(res.status)}`,
    };
  } catch (err) {
    return {
      name,
      url,
      status: 'unreachable',
      httpStatus: null,
      latencyMs: null,
      detail: err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'no response',
    };
  }
}

async function faults(config: WebConfig, deps: HealthDeps): Promise<FaultState> {
  try {
    const res = await deps.fetch(`${config.ordersApiUrl}/admin/scenarios/active`, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? 2000),
    });
    if (res.status === 404) return { controls: 'disabled', activeScenario: null };
    if (res.status !== 200) return { controls: 'unknown', activeScenario: null };
    const body = (await res.json()) as { active?: { scenario?: unknown } | null };
    const scenario = body.active?.scenario;
    return { controls: 'enabled', activeScenario: typeof scenario === 'string' ? scenario : null };
  } catch {
    return { controls: 'unknown', activeScenario: null };
  }
}

export async function checkHealth(config: WebConfig, deps: HealthDeps): Promise<HealthReport> {
  const [components, faultState] = await Promise.all([
    Promise.all([
      probe('orders-api', `${config.ordersApiUrl}/readyz`, deps),
      probe('worker', `${config.workerUrl}/readyz`, deps),
      probe('prometheus', `${config.prometheusUrl}/-/ready`, deps),
      probe('jaeger', `${config.jaegerUrl}/`, deps),
    ]),
    faults(config, deps),
  ]);
  return { checkedAt: deps.wallClock().toISOString(), components, faults: faultState };
}
