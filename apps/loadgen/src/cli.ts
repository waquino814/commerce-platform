import { parseArgs } from 'node:util';
import { ConfigError } from '@commerce/db/config';
import { loadConfig } from './config.js';
import { createLoadGenerator, type RunReport } from './index.js';
import { isValidSeed, summarizePlan } from './plan.js';
import type { PreflightResult } from './preflight.js';
import { getProfile, profileNames } from './profiles.js';
import type { Clock, HttpFetch, Timers } from './runner.js';
import type { Report, Verdict } from './stats.js';

export const USAGE =
  'usage: pnpm loadgen --profile <name> --seed <0..4294967295> [--dry-run] [--json]';

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly fetch?: HttpFetch;
  readonly clock?: Clock;
  readonly timers?: Timers;
  readonly random?: () => string;
  readonly timeoutSignal?: (ms: number) => AbortSignal;
}

class UsageError extends Error {}

function parse(argv: readonly string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      strict: true,
      allowPositionals: false,
      options: {
        profile: { type: 'string' },
        seed: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  if (values.help) return { help: true as const };
  if (values.profile === undefined) throw new UsageError('--profile is required');
  const profile = getProfile(values.profile);
  if (!profile) {
    throw new UsageError(
      `--profile: unknown profile "${values.profile}"; available: ${profileNames().join(', ')}`,
    );
  }
  if (values.seed === undefined) throw new UsageError('--seed is required');
  const seed = /^\d+$/.test(values.seed) ? Number(values.seed) : Number.NaN;
  if (!isValidSeed(seed)) {
    throw new UsageError(`--seed: must be an integer from 0 to 4294967295, got "${values.seed}"`);
  }
  return { help: false as const, profile, seed, dryRun: values['dry-run'], json: values.json };
}

const pct = (value: number) => `${(value * 100).toFixed(2)}%`;
const ms = (value: number | null) => (value === null ? 'n/a' : `${value.toFixed(1)} ms`);

function preflightLines(preflight: PreflightResult): string[] {
  const lines = [`preflight: ${preflight.passed ? 'passed' : 'failed'}`];
  lines.push(
    `  /readyz: ${preflight.readyz.status === null ? 'no answer' : String(preflight.readyz.status)}`,
  );
  if (preflight.catalog) {
    lines.push(
      `  catalog: ${String(preflight.catalog.products)} products, ${String(preflight.catalog.missingSkus.length)} planned SKUs missing`,
    );
  }
  const stock = preflight.stock;
  if (stock) {
    lines.push(
      `  stock shortfall: ${stock.shortfallPercent.toFixed(2)}% (${String(stock.unmetQuantity)} of ${String(stock.plannedQuantity)} planned units; limit ${String(stock.thresholdPercent)}%)`,
    );
    lines.push(`  short SKUs: ${String(stock.shortSkus.length)}`);
    for (const s of stock.shortSkus.slice(0, 20)) {
      lines.push(
        `    ${s.sku}: planned ${String(s.planned)}, available ${String(s.available)}, unmet ${String(s.unmet)}`,
      );
    }
    if (stock.shortSkus.length > 20) {
      lines.push(`    ... ${String(stock.shortSkus.length - 20)} more (see --json)`);
    }
  }
  if (preflight.failure) lines.push(`  stopped: ${preflight.failure}`);
  return lines;
}

function reportLines(report: Report, verdict: Verdict): string[] {
  const lines = [
    `window: ${String(report.windowSeconds)} s`,
    `  offered ${String(report.offered)}, sent ${String(report.sent)}, successful ${String(report.successful)}, failed ${String(report.failed)}, missed ${String(report.missed)}, skipped ${String(report.skipped)}`,
    `  throughput ${report.throughputRps.toFixed(2)} rps; failure rate ${pct(report.failureRate)}; miss rate ${pct(report.missRate)}; skip rate ${pct(report.skipRate)}`,
    `  latency p50 ${ms(report.latencyMs.p50)}, p95 ${ms(report.latencyMs.p95)}, p99 ${ms(report.latencyMs.p99)}`,
  ];
  for (const [op, counts] of Object.entries(report.byOperation)) {
    lines.push(
      `  ${op}: offered ${String(counts.offered)}, successful ${String(counts.successful)}, failed ${String(counts.failed)}, missed ${String(counts.missed)}, skipped ${String(counts.skipped)}, p95 ${ms(counts.latencyMs.p95)}`,
    );
  }
  if (report.failed > 0) {
    lines.push(
      `  failures: ${JSON.stringify(report.failures)}; statuses: ${JSON.stringify(report.failedStatuses)}`,
    );
  }
  lines.push(`result: ${verdict.passed ? 'PASS' : 'FAIL'}`);
  for (const check of verdict.checks) {
    lines.push(`  ${check.passed ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`);
  }
  return lines;
}

/** Runs the CLI and returns its exit code: 0 on success, 1 otherwise. Never calls process.exit. */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let args;
  let config;
  try {
    args = parse(argv);
    if (args.help) {
      deps.stdout(USAGE);
      return 0;
    }
    config = loadConfig(deps.env);
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      deps.stderr(`loadgen: ${err.message}\n${USAGE}`);
      return 1;
    }
    throw err;
  }

  const generator = createLoadGenerator({
    profile: args.profile,
    seed: args.seed,
    baseUrl: config.ordersApiUrl,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.timers ? { timers: deps.timers } : {}),
    ...(deps.random ? { random: deps.random } : {}),
    ...(deps.timeoutSignal ? { timeoutSignal: deps.timeoutSignal } : {}),
  });
  const summary = summarizePlan(generator.plan);
  const header = {
    profile: args.profile.name,
    seed: args.seed,
    planHash: generator.planHash,
    entries: summary.entries,
    byOperation: summary.byOperation,
  };

  if (args.dryRun) {
    if (args.json) {
      deps.stdout(JSON.stringify({ ...header, dryRun: true }));
    } else {
      deps.stdout(
        [
          `profile ${header.profile}, seed ${String(header.seed)}: ${String(header.entries)} entries`,
          `  ${Object.entries(header.byOperation)
            .map(([op, n]) => `${op} ${String(n)}`)
            .join(', ')}`,
          `plan hash ${header.planHash}`,
          'dry run: no requests sent',
        ].join('\n'),
      );
    }
    return 0;
  }

  const run: RunReport = await generator.run();
  if (args.json) {
    deps.stdout(
      JSON.stringify({
        ...header,
        target: config.ordersApiUrl,
        runPrefix: run.runPrefix,
        preflight: run.preflight,
        report: run.report ?? null,
        verdict: run.verdict ?? null,
        passed: run.verdict?.passed ?? false,
      }),
    );
  } else {
    const lines = [
      `profile ${header.profile}, seed ${String(header.seed)}, plan hash ${header.planHash}`,
      `target ${config.ordersApiUrl}, run prefix ${run.runPrefix}`,
      ...preflightLines(run.preflight),
    ];
    if (run.report && run.verdict) lines.push(...reportLines(run.report, run.verdict));
    deps.stdout(lines.join('\n'));
  }
  if (!run.preflight.passed) {
    deps.stderr(`loadgen: preflight failed: ${run.preflight.failure ?? 'unknown reason'}`);
    return 1;
  }
  return run.verdict?.passed ? 0 : 1;
}
