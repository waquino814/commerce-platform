import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { HTTP_INSTRUMENTATION_CONFIG } from '../src/sdk.js';

/** The HTTP tracing exclusions startTelemetry installs: M3 probes and M5a criterion A9. */
const { ignoreIncomingRequestHook: incoming, ignoreOutgoingRequestHook: outgoing } =
  HTTP_INSTRUMENTATION_CONFIG;

describe('HTTP tracing exclusions', () => {
  it('ignores incoming probes and scenario control requests, and traces the rest', () => {
    const ignored = (url: string | undefined) => incoming?.({ url } as IncomingMessage);
    for (const url of ['/healthz', '/readyz?x=1', '/admin', '/admin/scenarios/active']) {
      expect(ignored(url), url).toBe(true);
    }
    for (const url of ['/orders', '/products?limit=1', '/administrator', undefined]) {
      expect(ignored(url), String(url)).toBe(false);
    }
  });

  it('ignores outgoing scenario control requests, and traces the rest', () => {
    const ignored = (path: string | null | undefined) => outgoing?.({ host: 'worker', path });
    for (const path of ['/admin/scenarios/poison-order/start', '/admin/scenarios/stop?x']) {
      expect(ignored(path), path).toBe(true);
    }
    for (const path of ['/v1/traces', '/orders', null, undefined]) {
      expect(ignored(path), String(path)).toBe(false);
    }
  });
});
