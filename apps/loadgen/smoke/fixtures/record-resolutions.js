// Preloaded with `--import` by loadgen.test.js. Records every module the process resolves, so the
// smoke test can prove which modules a given import pulls in. Prints the list as JSON at exit.
import { registerHooks } from 'node:module';

const resolved = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    resolved.push({ specifier, url: result.url });
    return result;
  },
});
process.on('exit', () => {
  process.stdout.write(`\nRESOLVED ${JSON.stringify(resolved)}\n`);
});
