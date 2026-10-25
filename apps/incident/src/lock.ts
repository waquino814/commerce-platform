import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The run lock (docs/prompts/m5c-design.md, section 8.4): `INCIDENTS_DIR/.incident.lock`, created
 * exclusively. A stale lock is never removed automatically: a run that ended without cleanup may
 * have left a fault active or evidence to inspect, and a PID may have been reused.
 */
export const LOCK_FILE = '.incident.lock';

export interface LockInfo {
  pid: number;
  hostname: string;
  startedAt: string;
  scenario: string;
  seed: number;
}

export interface LockFs {
  mkdir(path: string): Promise<unknown>;
  writeExclusive(path: string, data: string): Promise<void>;
  read(path: string): Promise<string>;
  unlink(path: string): Promise<void>;
}

export const NODE_LOCK_FS: LockFs = {
  mkdir: (path) => mkdir(path, { recursive: true }),
  writeExclusive: (path, data) => writeFile(path, data, { flag: 'wx' }),
  read: (path) => readFile(path, 'utf8'),
  unlink: (path) => unlink(path),
};

export type AcquireResult =
  | { kind: 'acquired'; path: string }
  | { kind: 'held'; path: string; holder: LockInfo }
  | { kind: 'stale'; path: string; holder: LockInfo | undefined; reason: string }
  | { kind: 'error'; path: string; message: string };

/** True when the PID exists on this host; `EPERM` means it exists but belongs to someone else. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function acquireLock(
  incidentsDir: string,
  info: LockInfo,
  deps: { fs?: LockFs; alive?: (pid: number) => boolean } = {},
): Promise<AcquireResult> {
  const fs = deps.fs ?? NODE_LOCK_FS;
  const alive = deps.alive ?? processAlive;
  const path = join(incidentsDir, LOCK_FILE);
  try {
    await fs.mkdir(incidentsDir);
    await fs.writeExclusive(path, `${JSON.stringify(info)}\n`);
    return { kind: 'acquired', path };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      return { kind: 'error', path, message: err instanceof Error ? err.message : String(err) };
    }
  }
  let holder: LockInfo | undefined;
  try {
    holder = parseLock(await fs.read(path));
  } catch {
    holder = undefined;
  }
  if (!holder)
    return { kind: 'stale', path, holder: undefined, reason: 'the lock file is unreadable' };
  if (holder.hostname !== info.hostname) {
    return {
      kind: 'stale',
      path,
      holder,
      reason: `it was taken on another host (${holder.hostname})`,
    };
  }
  if (!alive(holder.pid))
    return { kind: 'stale', path, holder, reason: `process ${String(holder.pid)} is not running` };
  return { kind: 'held', path, holder };
}

function parseLock(text: string): LockInfo | undefined {
  const v = JSON.parse(text) as Partial<LockInfo>;
  return typeof v.pid === 'number' &&
    typeof v.hostname === 'string' &&
    typeof v.startedAt === 'string' &&
    typeof v.scenario === 'string' &&
    typeof v.seed === 'number'
    ? (v as LockInfo)
    : undefined;
}

export type ReleaseResult = 'released' | 'not owned' | 'failed';

/** Deletes the lock only if it still holds this run's PID and start time. */
export async function releaseLock(
  path: string,
  owner: LockInfo,
  fs: LockFs = NODE_LOCK_FS,
): Promise<ReleaseResult> {
  try {
    const current = parseLock(await fs.read(path));
    if (current?.pid !== owner.pid || current.startedAt !== owner.startedAt) return 'not owned';
    await fs.unlink(path);
    return 'released';
  } catch {
    return 'failed';
  }
}

export function describeStale(result: Extract<AcquireResult, { kind: 'stale' }>): string {
  return [
    `a stale lock exists at ${result.path}: ${result.reason}.`,
    result.holder ? `It records: ${JSON.stringify(result.holder)}.` : '',
    'A run may have ended without cleanup. Check that GET /admin/scenarios/active shows no active',
    'scenario, inspect any evidence, then remove the lock file yourself; it is never removed automatically.',
  ]
    .filter((s) => s !== '')
    .join(' ');
}
