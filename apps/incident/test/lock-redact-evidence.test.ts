import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bundleIdTaken,
  FAILED_DIR,
  moveInvalidBundle,
  NODE_EVIDENCE_FS,
  preserveEvidence,
  type EvidenceFs,
  type FailureRecord,
} from '../src/evidence.js';
import {
  acquireLock,
  describeStale,
  LOCK_FILE,
  NODE_LOCK_FS,
  processAlive,
  releaseLock,
  type LockInfo,
} from '../src/lock.js';
import { createRedactor } from '../src/redact.js';
import { tempDir } from './support.js';

let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
const scratch = () => {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
};
const info = (over: Partial<LockInfo> = {}): LockInfo => ({
  pid: 4242,
  hostname: 'host-a',
  startedAt: '2026-10-25T14:00:00.000Z',
  scenario: 'poison-order',
  seed: 42,
  ...over,
});

describe('lock (C8)', () => {
  it('is created exclusively, and released only by its owner', async () => {
    const dir = join(scratch(), 'incidents');
    const first = await acquireLock(dir, info());
    expect(first).toEqual({ kind: 'acquired', path: join(dir, LOCK_FILE) });
    const again = await acquireLock(dir, info({ pid: 1 }), { alive: () => true });
    expect(again.kind).toBe('held');
    expect(await releaseLock(join(dir, LOCK_FILE), info({ startedAt: 'other' }))).toBe('not owned');
    expect(await releaseLock(join(dir, LOCK_FILE), info())).toBe('released');
    expect(await readdir(dir)).toEqual([]);
    expect(await releaseLock(join(dir, LOCK_FILE), info())).toBe('failed');
  });

  it('reports stale locks without removing them', async () => {
    const dir = scratch();
    await acquireLock(dir, info());
    const dead = await acquireLock(dir, info({ pid: 7 }), { alive: () => false });
    expect(dead).toMatchObject({ kind: 'stale', reason: 'process 4242 is not running' });
    const otherHost = await acquireLock(dir, info({ hostname: 'host-b' }), { alive: () => true });
    expect(otherHost).toMatchObject({
      kind: 'stale',
      reason: expect.stringContaining('another host') as string,
    });
    if (dead.kind === 'stale') expect(describeStale(dead)).toMatch(/never removed automatically/);
    await writeFile(join(dir, LOCK_FILE), 'garbage');
    const unreadable = await acquireLock(dir, info(), { alive: () => true });
    expect(unreadable).toMatchObject({ kind: 'stale', holder: undefined });
    if (unreadable.kind === 'stale') expect(describeStale(unreadable)).not.toMatch(/It records/);
    expect(await readFile(join(dir, LOCK_FILE), 'utf8')).toBe('garbage');
  });

  it('reports other errors, and knows a live process', async () => {
    const failing = {
      ...NODE_LOCK_FS,
      mkdir: () => Promise.reject(new Error('read-only file system')),
    };
    expect(await acquireLock(scratch(), info(), { fs: failing })).toMatchObject({
      kind: 'error',
      message: 'read-only file system',
    });
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });
});

describe('redaction (C9)', () => {
  it('redacts database URL passwords and sensitive attribute values, and counts them', () => {
    const r = createRedactor();
    expect(r.text('connect postgres://commerce:s3cret@db:5432/commerce failed')).toBe(
      'connect postgres://commerce:***@db:5432/commerce failed',
    );
    expect(r.text('postgresql://u:p@h/d and postgres://a:b@c/d')).toBe(
      'postgresql://u:***@h/d and postgres://a:***@c/d',
    );
    expect(r.text('no secrets here')).toBe('no secrets here');
    const log = r.value({
      message: 'x',
      attributes: {
        Authorization: 'Bearer abc',
        req: { headers: { cookie: 'sid=1' } },
        n: 3,
        nil: null,
      },
    });
    expect(log).toEqual({
      message: 'x',
      attributes: { Authorization: '***', req: { headers: { cookie: '***' } }, n: 3, nil: null },
    });
    const span = r.value({
      attributes: [
        { key: 'set-cookie', value: { stringValue: 'a=b' } },
        { key: 'db.url', value: { stringValue: 'postgres://u:pw@h/d' } },
      ],
    });
    expect(span).toEqual({
      attributes: [
        { key: 'set-cookie', value: { stringValue: '***' } },
        { key: 'db.url', value: { stringValue: 'postgres://u:***@h/d' } },
      ],
    });
    expect(r.count).toBe(7);
  });
});

const failure = (bundleId = 'poison-order-42-20261025T140000Z'): Omit<FailureRecord, 'files'> => ({
  failureVersion: 1,
  bundleId,
  stage: 'capture-traces',
  category: 'timeout',
  message: 'the capture source reached its deadline',
  occurredAt: '2026-10-25T14:05:00.000Z',
  completedCaptures: ['metrics'],
});

describe('failed evidence', () => {
  it('preserves the completed files and failure.json, exclusively, with no manifest', async () => {
    const dir = scratch();
    const res = await preserveEvidence(
      dir,
      [
        { name: 'metrics.jsonl', content: '{}\n' },
        { name: 'capture-summary.json', content: '{}\n' },
      ],
      failure(),
    );
    expect(res).toEqual({
      state: 'preserved',
      path: join(dir, FAILED_DIR, 'poison-order-42-20261025T140000Z'),
      written: ['metrics.jsonl', 'capture-summary.json', 'failure.json'],
    });
    if (res.state !== 'preserved') return;
    const record = JSON.parse(
      await readFile(join(res.path, 'failure.json'), 'utf8'),
    ) as FailureRecord;
    expect(record.files).toEqual(['metrics.jsonl', 'capture-summary.json']);
    expect(await readdir(res.path)).not.toContain('manifest.json');
  });

  it('uses -2 to -9 on collisions, and reports "not preserved" when all nine exist', async () => {
    const dir = scratch();
    const id = 'x-1-20261025T140000Z';
    const second = await preserveEvidence(dir, [], failure(id));
    const third = await preserveEvidence(dir, [], failure(id));
    expect(second.state === 'preserved' && second.path.endsWith(id)).toBe(true);
    expect(third.state === 'preserved' && third.path.endsWith(`${id}-2`)).toBe(true);
    for (let i = 3; i <= 9; i += 1) await mkdir(join(dir, FAILED_DIR, `${id}-${String(i)}`));
    const full = await preserveEvidence(dir, [{ name: 'a', content: 'b' }], failure(id));
    expect(full).toEqual({
      state: 'not_preserved',
      error: expect.stringMatching(/all 9 candidate directories/) as string,
    });
  });

  it('reports partial preservation and failures truthfully', async () => {
    const dir = scratch();
    const partial: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      writeExclusive: (path, data) =>
        path.endsWith('traces.jsonl')
          ? Promise.reject(new Error('disk full'))
          : NODE_EVIDENCE_FS.writeExclusive(path, data),
    };
    const res = await preserveEvidence(
      dir,
      [
        { name: 'metrics.jsonl', content: '' },
        { name: 'traces.jsonl', content: '' },
      ],
      failure(),
      partial,
    );
    expect(res).toMatchObject({
      state: 'partially_preserved',
      written: ['metrics.jsonl', 'failure.json'],
      failed: ['traces.jsonl'],
    });
    const nothing: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      writeExclusive: () => Promise.reject(new Error('disk full')),
    };
    expect(
      (await preserveEvidence(scratch(), [{ name: 'a', content: '' }], failure(), nothing)).state,
    ).toBe('not_preserved');
    const noDir: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      mkdirShared: () => Promise.reject(new Error('EACCES')),
    };
    expect(await preserveEvidence(scratch(), [], failure(), noDir)).toEqual({
      state: 'not_preserved',
      error: 'EACCES',
    });
    const otherError: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      mkdirExclusive: () => Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' })),
    };
    expect(await preserveEvidence(scratch(), [], failure(), otherError)).toEqual({
      state: 'not_preserved',
      error: 'EIO',
    });
  });

  it('moves an invalid bundle unchanged, or leaves it in place and says where it is', async () => {
    const dir = scratch();
    const bundle = join(dir, 'poison-order-42-20261025T140000Z');
    await mkdir(bundle);
    await writeFile(join(bundle, 'manifest.json'), 'original');
    const moved = await moveInvalidBundle(dir, bundle, {
      ...failure(),
      stage: 'validate',
      category: 'validation',
    });
    expect(moved).toEqual({
      moved: true,
      location: join(dir, FAILED_DIR, 'poison-order-42-20261025T140000Z', 'bundle'),
      failureJson: true,
    });
    if (moved.moved)
      expect(await readFile(join(moved.location, 'manifest.json'), 'utf8')).toBe('original');

    const again = join(dir, 'b');
    await mkdir(again);
    const noRename: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      rename: () => Promise.reject(new Error('EXDEV')),
    };
    expect(await moveInvalidBundle(dir, again, failure('b-1-20261025T140000Z'), noRename)).toEqual({
      moved: false,
      location: again,
      error: 'EXDEV',
    });
    const noDir: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      mkdirShared: () => Promise.reject(new Error('EACCES')),
    };
    expect(await moveInvalidBundle(dir, again, failure('b-1-20261025T140000Z'), noDir)).toEqual({
      moved: false,
      location: again,
      error: 'EACCES',
    });
    const noJson: EvidenceFs = {
      ...NODE_EVIDENCE_FS,
      writeExclusive: () => Promise.reject(new Error('disk full')),
    };
    expect(
      await moveInvalidBundle(dir, again, failure('c-1-20261025T140000Z'), noJson),
    ).toMatchObject({ moved: true, failureJson: false });
  });

  it('detects a taken bundle ID in either place', async () => {
    const dir = scratch();
    expect(await bundleIdTaken(dir, 'id-1-20261025T140000Z')).toBeUndefined();
    await mkdir(join(dir, FAILED_DIR, 'id-1-20261025T140000Z'), { recursive: true });
    expect(await bundleIdTaken(dir, 'id-1-20261025T140000Z')).toBe(
      join(dir, FAILED_DIR, 'id-1-20261025T140000Z'),
    );
  });
});
