import { statfs } from 'node:fs/promises';
import { access, constants } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { groundTruthJson, SCENARIOS, SCENARIO_NAMES } from '@commerce/faults';
import { formatBundleError, validateBundle } from '@commerce/incident-bundle';
import type { HttpFetch } from './capture/deps.js';
import {
  ConfigError,
  loadConfig,
  parseScenario,
  parseSeed,
  type IncidentConfig,
} from './config.js';
import { request } from './control.js';
import {
  checkComposeOverride,
  message,
  runIsolationChecks,
  type CheckResult,
  type RunCommandSimple,
  type RuntimeVerification,
} from './isolation.js';
import {
  exitCodeFor,
  formatReport,
  LIMITS,
  runIncident,
  SIGNAL_CODES,
  type RunDeps,
} from './run.js';
import type { Monotonic, Timers } from './budget.js';

/**
 * `pnpm incident <command>` (docs/prompts/m5c-design.md, sections 8 and 9). `list`, `ground-truth`
 * and `validate` make no network calls. `capture-check` is read-only. `run` is blocked until the
 * runtime facts in section 14 are verified.
 */
export const USAGE = [
  'usage: pnpm incident <command>',
  '  list                                    the scenarios',
  '  ground-truth --scenario <name> --seed <n>  print a ground truth',
  '  validate <bundle-dir>                   validate a bundle (exit 0 valid, 1 otherwise)',
  '  capture-check                           read-only preflight (exit 0 pass, 1 fail, 5 inconclusive)',
  '  run --scenario <name> --seed <n>        run a scenario end to end',
].join('\n');

export interface CliDeps {
  env: Record<string, string | undefined>;
  stdout: (text: string) => Promise<void>;
  stderr: (text: string) => void;
  fetch: HttpFetch;
  runSimple: RunCommandSimple;
  timers: Timers;
  monotonic: Monotonic;
  verification: RuntimeVerification;
  statfsFree: (dir: string) => Promise<number>;
  writable: (dir: string) => Promise<string | undefined>;
  /** Builds the run's dependencies; only `run` calls it. */
  runDeps: (config: IncidentConfig) => RunDeps;
}

export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
        return await list(rest, deps);
      case 'ground-truth':
        return await groundTruth(rest, deps);
      case 'validate':
        return await validate(rest, deps);
      case 'capture-check':
        return await captureCheck(rest, deps);
      case 'run':
        return await run(rest, deps);
      case undefined:
      case '--help':
      case '-h':
        await deps.stdout(`${USAGE}\n`);
        return command === undefined ? 1 : 0;
      default:
        deps.stderr(`unknown command "${command}"\n${USAGE}\n`);
        return 1;
    }
  } catch (err) {
    if (err instanceof ConfigError) {
      deps.stderr(`${err.message}\n`);
      return 1;
    }
    throw err;
  }
}

function args(
  rest: readonly string[],
  options: { scenario?: boolean; seed?: boolean; positional?: boolean },
) {
  try {
    return parseArgs({
      args: [...rest],
      options: {
        ...(options.scenario ? { scenario: { type: 'string' as const } } : {}),
        ...(options.seed ? { seed: { type: 'string' as const } } : {}),
      },
      allowPositionals: options.positional ?? false,
      strict: true,
    });
  } catch (err) {
    throw new ConfigError(message(err));
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

async function list(rest: readonly string[], deps: CliDeps): Promise<number> {
  args(rest, {});
  const lines = SCENARIO_NAMES.map(
    (name) =>
      `${name} (version ${String(SCENARIOS[name].version)}): ${SCENARIOS[name].description}`,
  );
  await deps.stdout(`${lines.join('\n')}\n`);
  return 0;
}

async function groundTruth(rest: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = args(rest, { scenario: true, seed: true });
  await deps.stdout(
    groundTruthJson(parseScenario(str(values.scenario)), parseSeed(str(values.seed))),
  );
  return 0;
}

async function validate(rest: readonly string[], deps: CliDeps): Promise<number> {
  const { positionals } = args(rest, { positional: true });
  if (positionals.length !== 1 || !positionals[0])
    throw new ConfigError('validate: exactly one bundle directory is required');
  const result = await validateBundle(positionals[0]);
  if (result.valid) {
    await deps.stdout(`valid: ${positionals[0]}\n`);
    return 0;
  }
  await deps.stdout(
    `invalid: ${positionals[0]}\n${result.errors.map((e) => `  ${formatBundleError(e)}`).join('\n')}\n`,
  );
  return 1;
}

/** The read-only preflight (section 8.3): never writes, never touches faults, services or load. */
export async function captureChecks(config: IncidentConfig, deps: CliDeps): Promise<CheckResult[]> {
  const iso = await runIsolationChecks({
    config,
    run: deps.runSimple,
    fetch: deps.fetch,
    verification: deps.verification,
  });
  const checks = [...iso.checks];
  if (checks.length === 1) return checks; // URL form failed: nothing else is safe to contact.
  checks.push(await checkComposeOverride(deps.runSimple, deps.verification));
  const reqDeps = { fetch: deps.fetch, timers: deps.timers, monotonic: deps.monotonic };
  const probe = async (
    name: string,
    baseUrl: string,
    path: string,
    judge: (status: number) => CheckResult,
  ) => {
    try {
      const res = await request({ ...reqDeps, baseUrl }, 'GET', path, LIMITS.preflightRequestMs);
      checks.push(judge(res.status));
    } catch (err) {
      checks.push({ name, status: 'INCONCLUSIVE', detail: message(err) });
    }
  };
  const ok =
    (name: string, what: string) =>
    (status: number): CheckResult =>
      status === 200
        ? { name, status: 'PASS', detail: `${what} returned 200` }
        : { name, status: 'FAIL', detail: `${what} returned ${String(status)}` };
  await probe('api-ready', config.ordersApiUrl, '/readyz', ok('api-ready', 'GET /readyz'));
  await probe('fault-controls', config.ordersApiUrl, '/admin/scenarios', (status) =>
    status === 200
      ? {
          name: 'fault-controls',
          status: 'PASS',
          detail: 'faults enabled (GET /admin/scenarios returned 200)',
        }
      : status === 404
        ? {
            name: 'fault-controls',
            status: 'FAIL',
            detail: 'faults disabled (GET /admin/scenarios returned 404)',
          }
        : {
            name: 'fault-controls',
            status: 'FAIL',
            detail: `GET /admin/scenarios returned ${String(status)}`,
          },
  );
  await probe(
    'prometheus-ready',
    config.prometheusUrl,
    '/-/ready',
    ok('prometheus-ready', 'Prometheus /-/ready'),
  );
  await probe('jaeger-ready', config.jaegerUrl, '/', ok('jaeger-ready', 'Jaeger UI'));
  const notWritable = await deps.writable(config.incidentsDir);
  checks.push(
    notWritable === undefined
      ? { name: 'output-writable', status: 'PASS', detail: `${config.incidentsDir} is writable` }
      : { name: 'output-writable', status: 'FAIL', detail: notWritable },
  );
  try {
    const free = await deps.statfsFree(config.incidentsDir);
    checks.push(
      free >= LIMITS.minFreeBytes
        ? {
            name: 'free-disk',
            status: 'PASS',
            detail: `${String(Math.floor(free / 1024 ** 3))} GiB free`,
          }
        : {
            name: 'free-disk',
            status: 'FAIL',
            detail: `${String(Math.floor(free / 1024 ** 2))} MiB free; 1 GiB is required`,
          },
    );
  } catch (err) {
    checks.push({ name: 'free-disk', status: 'INCONCLUSIVE', detail: message(err) });
  }
  return checks;
}

export function checkExitCode(checks: readonly CheckResult[]): 0 | 1 | 5 {
  if (checks.some((c) => c.status === 'FAIL')) return 1;
  if (checks.some((c) => c.status === 'INCONCLUSIVE')) return 5;
  return 0;
}

async function captureCheck(rest: readonly string[], deps: CliDeps): Promise<number> {
  args(rest, {});
  const config = loadConfig(deps.env);
  const checks = await captureChecks(config, deps);
  const code = checkExitCode(checks);
  const summary =
    code === 0
      ? 'all checks passed'
      : code === 1
        ? 'at least one check failed'
        : 'no check failed, but some are inconclusive';
  await deps.stdout(
    `${checks.map((c) => `${c.status} ${c.name}: ${c.detail}`).join('\n')}\nsummary: ${summary}\n`,
  );
  return code;
}

async function run(rest: readonly string[], deps: CliDeps): Promise<number> {
  const { values } = args(rest, { scenario: true, seed: true });
  const scenario = parseScenario(str(values.scenario));
  const seed = parseSeed(str(values.seed));
  const config = loadConfig(deps.env);
  const report = await runIncident({ ...config, scenario, seed }, deps.runDeps(config));
  const code = exitCodeFor(report);
  try {
    await deps.stdout(formatReport(report));
  } catch (err) {
    // Not emitted: nothing may assume the report exists. One best-effort line on stderr.
    deps.stderr(
      `the report could not be written to stdout (${message(err)}); exit code ${String(code)}\n`,
    );
  }
  return code;
}

/**
 * The signal policy (section 9). The first SIGINT or SIGTERM interrupts the run, which then
 * cleans up. A signal while cleanup runs ends the process at once: with the first signal's code
 * when the run was interrupted, otherwise with this signal's code.
 */
export function createSignalPolicy() {
  let first: 'SIGINT' | 'SIGTERM' | undefined;
  let cleaningUp = false;
  return {
    cleanupStarted() {
      cleaningUp = true;
    },
    onSignal(
      signal: 'SIGINT' | 'SIGTERM',
    ): { kind: 'interrupt' } | { kind: 'exit'; code: number; message: string } {
      if (!cleaningUp && first === undefined) {
        first = signal;
        return { kind: 'interrupt' };
      }
      const code = SIGNAL_CODES[first ?? signal];
      return { kind: 'exit', code, message: 'interrupted during cleanup: cleanup incomplete\n' };
    },
  };
}

/** The nearest existing directory is checked for write access; nothing is created. */
export async function writableDir(dir: string): Promise<string | undefined> {
  let current = resolve(dir);
  for (;;) {
    try {
      await access(current, constants.W_OK);
      return undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return `${current} is not writable`;
      const parent = dirname(current);
      if (parent === current) return `no existing parent of ${dir}`;
      current = parent;
    }
  }
}

export async function freeBytes(dir: string): Promise<number> {
  let current = resolve(dir);
  for (;;) {
    try {
      const s = await statfs(current);
      return s.bavail * s.bsize;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = dirname(current);
      if (parent === current) throw err;
      current = parent;
    }
  }
}
