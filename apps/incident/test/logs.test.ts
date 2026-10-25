import { describe, expect, it } from 'vitest';
import { captureLogs, normalizeLogs } from '../src/capture/logs.js';
import type { RunCommand } from '../src/capture/deps.js';

/** M5b criterion B4: log capture and normalization, against a stubbed `docker compose logs`. */
const FROM = new Date('2026-10-25T14:00:00.000Z');
const TO = new Date('2026-10-25T14:03:00.000Z');
const T0 = Date.parse('2026-10-25T14:00:01.000Z');
const stamp = (s: number) => `2026-10-25T14:00:0${String(s)}.123456789Z`;
const pino = (fields: Record<string, unknown>) =>
  JSON.stringify({ level: 30, time: T0, service: 'orders-api', ...fields });

describe('normalizeLogs', () => {
  it('maps pino levels, converts epoch milliseconds and keeps the other fields as attributes', () => {
    const levels = [10, 20, 30, 40, 50, 60, 35].map(
      (level) => `${stamp(1)} ${pino({ level, msg: 'm', workerId: 'w1' })}`,
    );
    const { records } = normalizeLogs('worker', levels.join('\n'), FROM);
    expect(records.map((r) => r.level)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
      'unknown',
    ]);
    expect(records[0]).toEqual({
      service: 'worker',
      time: '2026-10-25T14:00:01.000Z',
      level: 'trace',
      message: 'm',
      attributes: { workerId: 'w1' },
    });
    expect(records[6]?.attributes).toEqual({ workerId: 'w1', pinoLevel: 35 });
  });

  it('keeps trace fields only when they are well formed', () => {
    const t = 'a'.repeat(32);
    const s = 'b'.repeat(16);
    const { records } = normalizeLogs(
      'orders-api',
      [
        `${stamp(1)} ${pino({ trace_id: t, span_id: s })}`,
        `${stamp(1)} ${pino({ trace_id: 'x', span_id: 1 })}`,
      ].join('\n'),
      FROM,
    );
    expect(records[0]).toMatchObject({ trace_id: t, span_id: s, attributes: {} });
    expect(records[1]?.trace_id).toBeUndefined();
    expect(records[1]?.attributes).toEqual({ trace_id: 'x', span_id: 1 });
  });

  it('falls back to the Docker timestamp, then to the last time seen, and keeps lines that are not JSON', () => {
    const out = [
      `${stamp(2)} ${JSON.stringify({ level: 30, msg: 'no time' })}`,
      `${stamp(3)} ${JSON.stringify({ level: 30, time: 'yesterday', msg: 'bad time' })}`,
      `${stamp(4)} Error: boom`,
      `${stamp(5)} [1,2]`,
      `    at main (file.js:1:1)`,
      '',
    ].join('\n');
    const { records, nonJsonLines } = normalizeLogs('worker', out, FROM);
    expect(records.map((r) => [r.time, r.level, r.message])).toEqual([
      ['2026-10-25T14:00:02.123Z', 'info', 'no time'],
      ['2026-10-25T14:00:03.123Z', 'info', 'bad time'],
      ['2026-10-25T14:00:04.123Z', 'unknown', 'Error: boom'],
      ['2026-10-25T14:00:05.123Z', 'unknown', '[1,2]'],
      ['2026-10-25T14:00:05.123Z', 'unknown', '    at main (file.js:1:1)'],
    ]);
    expect(nonJsonLines).toBe(3);
    expect(records[2]?.attributes).toEqual({});
    expect(normalizeLogs('worker', 'no stamp', FROM).records[0]?.time).toBe(FROM.toISOString());
  });

  it('drops /admin requests and their follow-ups, keeps look-alikes, probes and others', () => {
    const incoming = (reqId: string, url: string) =>
      `${stamp(1)} ${pino({ reqId, req: { method: 'GET', url }, msg: 'incoming request' })}`;
    const completed = (reqId: string) =>
      `${stamp(1)} ${pino({ reqId, res: { statusCode: 200 }, msg: 'request completed' })}`;
    const out = [
      incoming('req-1', '/admin'),
      completed('req-1'),
      incoming('req-2', '/admin/scenarios/x/start?y=1'),
      incoming('req-3', '/administrator'),
      completed('req-3'),
      incoming('req-4', '/products/admin'),
      incoming('req-5', '/healthz'),
      completed('req-2'),
      `${stamp(1)} ${pino({ reqId: 'custom-id', req: { url: '/admin' }, msg: 'incoming request' })}`,
      `${stamp(1)} ${pino({ reqId: 'custom-id', msg: 'request completed' })}`,
    ].join('\n');
    const { records, droppedAdminLines } = normalizeLogs('orders-api', out, FROM);
    expect(droppedAdminLines).toBe(5);
    expect(records.map((r) => `${String(r.attributes.reqId)} ${r.message}`)).toEqual([
      'req-3 incoming request',
      'req-3 request completed',
      'req-4 incoming request',
      'req-5 incoming request',
      // An ID that is not Fastify's counter cannot be linked reliably, so its follow-up is kept.
      'custom-id request completed',
    ]);
  });

  it('ends a link when the request ID is reused after a restart', () => {
    const incoming = (reqId: string, url: string) =>
      `${stamp(1)} ${pino({ reqId, req: { url }, msg: 'incoming request' })}`;
    const completed = (reqId: string) => `${stamp(1)} ${pino({ reqId, msg: 'request completed' })}`;
    const out = [
      incoming('req-1', '/orders'),
      incoming('req-2', '/admin'),
      completed('req-2'),
      // Restart: the counter starts over, and req-2 is now an ordinary request.
      incoming('req-1', '/products'),
      incoming('req-2', '/orders'),
      completed('req-2'),
      // A restart between a dropped request and its follow-up: the link no longer holds, so req-3's
      // follow-up is kept.
      incoming('req-3', '/admin'),
      incoming('req-1', '/orders'),
      completed('req-3'),
    ].join('\n');
    const { records, droppedAdminLines } = normalizeLogs('orders-api', out, FROM);
    expect(droppedAdminLines).toBe(3);
    expect(records.map((r) => `${String(r.attributes.reqId)} ${r.message}`)).toEqual([
      'req-1 incoming request',
      'req-1 incoming request',
      'req-2 incoming request',
      'req-2 request completed',
      'req-1 incoming request',
      'req-3 request completed',
    ]);
  });

  it('orders records by time, keeping the original order for equal times', () => {
    const out = [`${stamp(3)} late`, `${stamp(1)} early`, `${stamp(1)} early-2`].join('\n');
    expect(normalizeLogs('worker', out, FROM).records.map((r) => r.message)).toEqual([
      'early',
      'early-2',
      'late',
    ]);
  });
});

describe('captureLogs', () => {
  it('runs docker compose logs once per service, in name order, with the approved flags', async () => {
    const calls: string[][] = [];
    const run: RunCommand = (command, args) => {
      calls.push([command, ...args]);
      const service = args.at(-1) ?? '';
      return Promise.resolve({
        exitCode: 0,
        stdout: `${stamp(1)} ${pino({ msg: service })}\n`,
        stderr: '',
      });
    };
    const { records, summary } = await captureLogs({
      captureFrom: FROM,
      captureTo: TO,
      services: ['worker', 'orders-api'],
      runCommand: run,
    });
    expect(calls).toEqual(
      ['orders-api', 'worker'].map((s) => [
        'docker',
        'compose',
        'logs',
        '--no-log-prefix',
        '--timestamps',
        '--since',
        '2026-10-25T14:00:00.000Z',
        '--until',
        '2026-10-25T14:03:00.000Z',
        s,
      ]),
    );
    expect(records.map((r) => [r.service, r.message])).toEqual([
      ['orders-api', 'orders-api'],
      ['worker', 'worker'],
    ]);
    expect(summary).toEqual({
      source: 'docker-compose',
      services: [
        { name: 'orders-api', records: 1, nonJsonLines: 0, droppedAdminLines: 0 },
        { name: 'worker', records: 1, nonJsonLines: 0, droppedAdminLines: 0 },
      ],
    });
  });

  it('reports a failing command with its exit code and stderr', async () => {
    const run: RunCommand = () =>
      Promise.resolve({ exitCode: 1, stdout: '', stderr: 'no such service: worker\n' });
    await expect(
      captureLogs({ captureFrom: FROM, captureTo: TO, services: ['worker'], runCommand: run }),
    ).rejects.toThrow(
      'docker compose logs for worker failed with exit code 1: no such service: worker',
    );
  });
});
