import { z } from 'zod';
import type { Activation, FaultController } from './controller.js';
import {
  MAX_DURATION_MS,
  MIN_DURATION_MS,
  SCENARIO_NAMES,
  SCENARIOS,
  DEFAULT_DURATION_MS,
  isScenarioName,
  type ProcessName,
} from './scenarios.js';

/**
 * The scenario control endpoints, independent of the HTTP framework (docs/prompts/m5-design.md,
 * "Admin endpoint contracts"). The orders API forwards to the worker; the worker answers for
 * itself. Errors use the `{ error, message, details? }` shape.
 */
export interface ControlResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface WorkerForwarder {
  start(name: string, body: { seed: number; durationMs: number }): Promise<boolean>;
  stop(): Promise<boolean>;
  report(): Promise<unknown>;
}

export const startBodySchema = z.strictObject({
  seed: z.number().int().min(0).max(0xffffffff),
  durationMs: z.number().int().min(MIN_DURATION_MS).max(MAX_DURATION_MS),
});

const error = (status: number, code: string, message: string, details?: unknown[]) => ({
  status,
  body: details === undefined ? { error: code, message } : { error: code, message, details },
});

export interface ScenarioControl {
  list(): ControlResponse;
  start(name: string, body: unknown): Promise<ControlResponse>;
  stop(): Promise<ControlResponse>;
  report(): Promise<ControlResponse>;
}

export function createScenarioControl(deps: {
  process: ProcessName;
  controller: FaultController;
  /** The orders API's link to the worker. The worker itself has none. */
  forwarder?: WorkerForwarder;
}): ScenarioControl {
  const { controller, forwarder } = deps;
  const processes = (state: string) =>
    forwarder ? { 'orders-api': state, worker: state } : { [deps.process]: state };
  const view = (activation: Activation) => ({ ...activation, processes: processes('active') });

  return {
    list: () => ({
      status: 200,
      body: {
        scenarios: SCENARIO_NAMES.map((name) => ({
          name,
          version: SCENARIOS[name].version,
          description: SCENARIOS[name].description,
          affectedComponents: [...SCENARIOS[name].affectedComponents].sort(),
          defaultDurationMs: DEFAULT_DURATION_MS,
        })),
      },
    }),

    async start(name, body) {
      if (!isScenarioName(name)) {
        return error(404, 'scenario_not_found', `no scenario named ${name}`);
      }
      const parsed = startBodySchema.safeParse(body);
      if (!parsed.success) {
        return error(
          400,
          'validation_error',
          'request validation failed',
          parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
      }
      const { seed, durationMs } = parsed.data;
      const result = controller.start(name, seed, durationMs);
      if (!result.ok) {
        if (result.reason === 'scenario_active') {
          return error(409, 'scenario_active', 'another scenario is active', [result.active]);
        }
        return error(503, 'faults_unavailable', 'scenarios cannot be started now');
      }
      if (forwarder && !(await forwarder.start(name, { seed, durationMs }))) {
        controller.stop();
        return error(502, 'worker_unavailable', 'the worker did not confirm the start');
      }
      return { status: 202, body: { activation: view(result.activation) } };
    },

    async stop() {
      const own = controller.stop();
      if (forwarder && !(await forwarder.stop())) {
        return error(502, 'worker_unavailable', 'the worker did not confirm the stop');
      }
      return { status: 200, body: { stopped: own.stopped, scenario: own.scenario } };
    },

    async report() {
      const active = controller.active();
      const own = { active };
      if (!forwarder) return { status: 200, body: { active, processes: { [deps.process]: own } } };
      const remote = await forwarder.report();
      const worker =
        remote !== null &&
        typeof remote === 'object' &&
        'processes' in remote &&
        remote.processes !== null &&
        typeof remote.processes === 'object' &&
        'worker' in remote.processes
          ? remote.processes.worker
          : { error: 'worker_unavailable' };
      return { status: 200, body: { active, processes: { 'orders-api': own, worker } } };
    },
  };
}

/** The orders API's forwarder: Node's built-in `fetch`, which the telemetry SDK does not trace. */
export function createWorkerForwarder(options: {
  baseUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): WorkerForwarder {
  const base = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const call = async (path: string, init: RequestInit): Promise<Response | null> => {
    try {
      return await doFetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return null;
    }
  };
  const post = (path: string, body: unknown) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    async start(name, body) {
      const res = await post(`/admin/scenarios/${encodeURIComponent(name)}/start`, body);
      return res?.status === 202;
    },
    async stop() {
      const res = await post('/admin/scenarios/stop', {});
      return res?.status === 200;
    },
    async report() {
      const res = await call('/admin/scenarios/active', { method: 'GET' });
      if (res?.status !== 200) return null;
      try {
        return await res.json();
      } catch {
        return null;
      }
    },
  };
}
