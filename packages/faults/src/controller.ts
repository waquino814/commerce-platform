import { SCENARIOS, type ScenarioName } from './scenarios.js';

/**
 * The per-process fault controller (docs/prompts/m5-design.md, "Fault activation across
 * processes"). It holds at most one active scenario, which expires on its own. Enabling faults
 * never activates anything: only `start` does. The package logs nothing, so no scenario name ever
 * reaches logs or telemetry.
 */
export interface Activation {
  readonly scenario: ScenarioName;
  readonly version: number;
  readonly seed: number;
  readonly durationMs: number;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/** What a scenario does in one process. Both calls are synchronous and never throw. */
export interface Effect {
  activate(seed: number): void;
  deactivate(): void;
}

export interface ControllerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type StartResult =
  | { readonly ok: true; readonly activation: Activation }
  | { readonly ok: false; readonly reason: 'disabled' | 'shut_down' }
  | { readonly ok: false; readonly reason: 'scenario_active'; readonly active: Activation };

export interface FaultController {
  readonly enabled: boolean;
  active(): Activation | null;
  isActive(name: ScenarioName): boolean;
  start(name: ScenarioName, seed: number, durationMs: number): StartResult;
  /** Stops the active scenario, if any. Idempotent. */
  stop(): { readonly stopped: boolean; readonly scenario: ScenarioName | null };
  /** Stops the active scenario and refuses every later start. Called first at SIGTERM. */
  shutdown(): void;
}

const realTimers: ControllerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** The controller of a process with faults disabled: nothing can ever become active. */
export const DISABLED_FAULTS: FaultController = Object.freeze({
  enabled: false,
  active: () => null,
  isActive: () => false,
  start: () => ({ ok: false, reason: 'disabled' }) as const,
  stop: () => ({ stopped: false, scenario: null }),
  shutdown: () => undefined,
});

export function createFaultController(options: {
  /** Effects this process applies. A scenario without one is still tracked, for the report. */
  effects?: Partial<Record<ScenarioName, Effect>>;
  now?: () => number;
  timers?: ControllerTimers;
}): FaultController {
  const effects = options.effects ?? {};
  const now = options.now ?? Date.now;
  const timers = options.timers ?? realTimers;
  let current: { activation: Activation; expiry: unknown } | null = null;
  let shutDown = false;

  const stop = (): { stopped: boolean; scenario: ScenarioName | null } => {
    if (!current) return { stopped: false, scenario: null };
    const { activation, expiry } = current;
    current = null;
    timers.clearTimeout(expiry);
    effects[activation.scenario]?.deactivate();
    return { stopped: true, scenario: activation.scenario };
  };

  return {
    enabled: true,
    active: () => current?.activation ?? null,
    isActive: (name) => current?.activation.scenario === name,
    start(name, seed, durationMs) {
      if (shutDown) return { ok: false, reason: 'shut_down' };
      if (current) return { ok: false, reason: 'scenario_active', active: current.activation };
      const startedAt = now();
      const activation: Activation = {
        scenario: name,
        version: SCENARIOS[name].version,
        seed,
        durationMs,
        startedAt: new Date(startedAt).toISOString(),
        expiresAt: new Date(startedAt + durationMs).toISOString(),
      };
      const expiry = timers.setTimeout(() => {
        if (current?.activation === activation) stop();
      }, durationMs);
      current = { activation, expiry };
      effects[name]?.activate(seed);
      return { ok: true, activation };
    },
    stop,
    shutdown() {
      shutDown = true;
      stop();
    },
  };
}
