// CLI entry: `pnpm incident <command>`. The logic, and its tests, live in cli.ts and run.ts.
import { writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { createLoadGenerator } from '@commerce/loadgen';
import { nodeRunCommand, REAL_MONOTONIC, REAL_TIMERS } from './budget.js';
import { createSignalPolicy, freeBytes, runCli, writableDir } from './cli.js';
import { RUNTIME_VERIFICATION } from './isolation.js';

const interrupt = new AbortController();
const policy = createSignalPolicy();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    const action = policy.onSignal(signal);
    if (action.kind === 'interrupt') {
      interrupt.abort(signal);
      return;
    }
    try {
      writeSync(2, action.message);
    } catch {
      // Best effort only.
    }
    process.exit(action.code);
  });
}

const runSimple = (command: string, args: readonly string[]) =>
  nodeRunCommand(command, args, AbortSignal.any([AbortSignal.timeout(15_000), interrupt.signal]));

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) =>
    new Promise((resolve, reject) => {
      process.stdout.write(text, (err) => {
        if (err) reject(err);
        else resolve();
      });
    }),
  stderr: (text) => {
    try {
      writeSync(2, text);
    } catch {
      // Best effort only.
    }
  },
  fetch: (url, init) => fetch(url, init),
  runSimple,
  timers: REAL_TIMERS,
  monotonic: REAL_MONOTONIC,
  verification: RUNTIME_VERIFICATION,
  statfsFree: freeBytes,
  writable: writableDir,
  runDeps: () => ({
    wallClock: () => new Date(),
    monotonic: REAL_MONOTONIC,
    timers: REAL_TIMERS,
    fetch: (url, init) => fetch(url, init),
    runCommand: nodeRunCommand,
    interrupt: interrupt.signal,
    verification: RUNTIME_VERIFICATION,
    hostname: hostname(),
    pid: process.pid,
    createLoadGenerator,
    freeBytes,
    onCleanupStart: () => {
      policy.cleanupStarted();
    },
  }),
});
process.exitCode = code;
