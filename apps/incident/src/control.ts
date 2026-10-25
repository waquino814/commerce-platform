import { z } from 'zod';
import { CategorizedError, sleep, timerSignal, type Monotonic, type Timers } from './budget.js';
import type { HttpFetch } from './capture/deps.js';

/**
 * The client for M5a's four admin endpoints on the orders API, plus the stop procedure
 * (docs/prompts/m5c-design.md, section 4.3). Each request has its own timeout.
 */
export interface ControlDeps {
  baseUrl: string;
  fetch: HttpFetch;
  timers: Timers;
  monotonic: Monotonic;
}

export async function request(
  deps: ControlDeps,
  method: 'GET' | 'POST',
  path: string,
  timeoutMs: number,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const t = timerSignal(deps.timers, timeoutMs, 'timeout');
  try {
    const res = await deps.fetch(`${deps.baseUrl}${path}`, {
      method,
      signal: t.signal,
      headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed };
  } catch (err) {
    if (t.signal.aborted)
      throw new CategorizedError(
        'timeout',
        `${method} ${path} timed out after ${String(timeoutMs)} ms`,
      );
    throw new CategorizedError(
      'transport',
      `${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    t.cancel();
  }
}

const listBody = z.looseObject({
  scenarios: z.array(z.looseObject({ name: z.string(), version: z.number().int() })),
});
const reportBody = z.looseObject({
  active: z.unknown(),
  processes: z.record(
    z.string(),
    z.looseObject({ active: z.unknown().optional(), error: z.string().optional() }),
  ),
});

export function createControl(deps: ControlDeps) {
  return {
    async readyz(timeoutMs: number): Promise<number> {
      return (await request(deps, 'GET', '/readyz', timeoutMs)).status;
    },
    /** `GET /admin/scenarios`: the scenario versions the running image serves. */
    async list(timeoutMs: number): Promise<{ status: number; versions?: Map<string, number> }> {
      const res = await request(deps, 'GET', '/admin/scenarios', timeoutMs);
      const parsed = listBody.safeParse(res.body);
      if (res.status !== 200 || !parsed.success) return { status: res.status };
      return {
        status: res.status,
        versions: new Map(parsed.data.scenarios.map((s) => [s.name, s.version])),
      };
    },
    /** `GET /admin/scenarios/active`: `none` only when both processes report no active scenario. */
    async active(timeoutMs: number): Promise<'none' | 'active' | 'unknown'> {
      const res = await request(deps, 'GET', '/admin/scenarios/active', timeoutMs);
      const parsed = reportBody.safeParse(res.body);
      if (res.status !== 200 || !parsed.success) return 'unknown';
      const { active, processes } = parsed.data;
      const api = processes['orders-api'];
      const worker = processes.worker;
      if (!api || !worker || api.error !== undefined || worker.error !== undefined)
        return 'unknown';
      return active === null && api.active === null && worker.active === null ? 'none' : 'active';
    },
    async start(
      name: string,
      seed: number,
      durationMs: number,
      timeoutMs: number,
    ): Promise<number> {
      return (
        await request(
          deps,
          'POST',
          `/admin/scenarios/${encodeURIComponent(name)}/start`,
          timeoutMs,
          { seed, durationMs },
        )
      ).status;
    },
    async stop(timeoutMs: number): Promise<number> {
      return (await request(deps, 'POST', '/admin/scenarios/stop', timeoutMs)).status;
    },
    async placeOrder(sku: string, idempotencyKey: string, timeoutMs: number): Promise<number> {
      return (
        await request(
          deps,
          'POST',
          '/orders',
          timeoutMs,
          { items: [{ sku, quantity: 1 }], paymentMethod: 'pm_card_ok' },
          { 'idempotency-key': idempotencyKey },
        )
      ).status;
    },
  };
}
export type Control = ReturnType<typeof createControl>;

export const STOP_PHASE_MS = 15_000;
export const STOP_ATTEMPT_MS = 7_000;
export const STOP_PAUSE_MS = 1_000;
export const CONFIRM_PHASE_MS = 10_000;
export const CONFIRM_POLL_MS = 1_000;
export const CONFIRM_REQUEST_MS = 2_000;
/** The whole procedure: a 15 s stop phase and a 10 s confirm phase. */
export const STOP_PROCEDURE_MS = STOP_PHASE_MS + CONFIRM_PHASE_MS;

/**
 * The stop procedure (section 4.3): `POST /admin/scenarios/stop` (7 s, then once more after 1 s if
 * it failed, within 15 s), then `GET /admin/scenarios/active` every second for 10 s until both
 * processes report none. Only that confirmation counts; the stop response alone never does.
 */
export async function stopProcedure(
  control: Control,
  deps: Pick<ControlDeps, 'timers' | 'monotonic'>,
): Promise<{ confirmed: boolean; detail: string }> {
  const { timers, monotonic } = deps;
  const stopDeadline = monotonic.now() + STOP_PHASE_MS;
  const notes: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const left = stopDeadline - monotonic.now();
    if (left <= 0) break;
    try {
      const status = await control.stop(Math.min(STOP_ATTEMPT_MS, left));
      if (status === 200) break;
      notes.push(`stop returned ${String(status)}`);
    } catch (err) {
      notes.push(err instanceof Error ? err.message : String(err));
    }
    if (attempt === 1 && stopDeadline - monotonic.now() > STOP_PAUSE_MS)
      await sleep(timers, STOP_PAUSE_MS);
  }
  const confirmDeadline = monotonic.now() + CONFIRM_PHASE_MS;
  let last = 'no confirmation request completed';
  while (monotonic.now() < confirmDeadline) {
    const pollStart = monotonic.now();
    try {
      const state = await control.active(Math.min(CONFIRM_REQUEST_MS, confirmDeadline - pollStart));
      if (state === 'none')
        return {
          confirmed: true,
          detail: notes.length > 0 ? `confirmed after: ${notes.join('; ')}` : 'confirmed',
        };
      last = `the report shows ${state === 'active' ? 'an active scenario' : 'no usable state'}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    const wait = pollStart + CONFIRM_POLL_MS - monotonic.now();
    if (monotonic.now() + Math.max(0, wait) >= confirmDeadline) break;
    if (wait > 0) await sleep(timers, wait);
  }
  return { confirmed: false, detail: [...notes, last].join('; ') };
}
