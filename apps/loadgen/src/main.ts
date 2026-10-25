// CLI entry: `pnpm loadgen --profile steady --seed 42 [--dry-run] [--json]`.
// All logic lives in cli.ts, which is unit-tested; this file only wires the process.
import { runCli } from './cli.js';

runCli(process.argv.slice(2), {
  env: process.env,
  stdout: (text) => {
    process.stdout.write(`${text}\n`);
  },
  stderr: (text) => {
    process.stderr.write(`${text}\n`);
  },
}).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(
      `loadgen: unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exitCode = 1;
  },
);
