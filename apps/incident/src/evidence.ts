import { access, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FailureCategory } from './budget.js';

/**
 * Failed-evidence preservation (docs/prompts/m5c-design.md, section 6). Evidence goes under
 * `INCIDENTS_DIR/.failed/`, never as a bundle: there is no `manifest.json` at its top level. Every
 * directory and file is created exclusively, nothing is ever overwritten or deleted, and the
 * report lists exactly what was written.
 */
export const FAILED_DIR = '.failed';
export const MAX_CANDIDATES = 9;

export interface EvidenceFs {
  mkdirShared(path: string): Promise<unknown>;
  mkdirExclusive(path: string): Promise<void>;
  writeExclusive(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export const NODE_EVIDENCE_FS: EvidenceFs = {
  mkdirShared: (path) => mkdir(path, { recursive: true }),
  mkdirExclusive: async (path) => {
    await mkdir(path);
  },
  writeExclusive: (path, data) => writeFile(path, data, { flag: 'wx' }),
  rename: (from, to) => rename(from, to),
  exists: (path) =>
    access(path).then(
      () => true,
      () => false,
    ),
};

export interface FailureRecord {
  failureVersion: 1;
  bundleId: string;
  stage: 'capture-metrics' | 'capture-traces' | 'capture-logs' | 'redact' | 'write' | 'validate';
  category: FailureCategory;
  message: string;
  occurredAt: string;
  completedCaptures: string[];
  files: string[];
}

export type EvidenceResult =
  | { state: 'preserved'; path: string; written: string[] }
  | { state: 'partially_preserved'; path: string; written: string[]; failed: string[] }
  | { state: 'not_preserved'; error: string };

/** Creates `.failed/<bundleId>`, or `-2` to `-9`, exclusively. */
async function createCandidate(
  incidentsDir: string,
  bundleId: string,
  fs: EvidenceFs,
): Promise<string> {
  const root = join(incidentsDir, FAILED_DIR);
  await fs.mkdirShared(root);
  for (let i = 1; i <= MAX_CANDIDATES; i += 1) {
    const path = join(root, i === 1 ? bundleId : `${bundleId}-${String(i)}`);
    try {
      await fs.mkdirExclusive(path);
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  throw new Error(
    `all ${String(MAX_CANDIDATES)} candidate directories for ${bundleId} under ${root} already exist`,
  );
}

/** Preserves the completed captures' files, then `failure.json`, listing what was written. */
export async function preserveEvidence(
  incidentsDir: string,
  files: readonly { name: string; content: string }[],
  failure: Omit<FailureRecord, 'files'>,
  fs: EvidenceFs = NODE_EVIDENCE_FS,
): Promise<EvidenceResult> {
  let dir: string;
  try {
    dir = await createCandidate(incidentsDir, failure.bundleId, fs);
  } catch (err) {
    return { state: 'not_preserved', error: err instanceof Error ? err.message : String(err) };
  }
  const written: string[] = [];
  const failed: string[] = [];
  for (const file of files) {
    try {
      await fs.writeExclusive(join(dir, file.name), file.content);
      written.push(file.name);
    } catch {
      failed.push(file.name);
    }
  }
  try {
    await fs.writeExclusive(
      join(dir, 'failure.json'),
      `${JSON.stringify({ ...failure, files: [...written] }, null, 2)}\n`,
    );
    written.push('failure.json');
  } catch {
    failed.push('failure.json');
  }
  if (written.length === 0)
    return { state: 'not_preserved', error: `nothing could be written to ${dir}` };
  return failed.length === 0
    ? { state: 'preserved', path: dir, written }
    : { state: 'partially_preserved', path: dir, written, failed };
}

export type InvalidBundleResult =
  | { moved: true; location: string; failureJson: boolean }
  | { moved: false; location: string; error: string };

/**
 * Moves an invalid bundle, unchanged, to `.failed/<candidate>/bundle` with one rename, then writes
 * `failure.json` beside it. If that fails, the bundle stays where it is, untouched.
 */
export async function moveInvalidBundle(
  incidentsDir: string,
  bundleDir: string,
  failure: Omit<FailureRecord, 'files'>,
  fs: EvidenceFs = NODE_EVIDENCE_FS,
): Promise<InvalidBundleResult> {
  let dir: string;
  try {
    dir = await createCandidate(incidentsDir, failure.bundleId, fs);
  } catch (err) {
    return {
      moved: false,
      location: bundleDir,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const target = join(dir, 'bundle');
  try {
    await fs.rename(bundleDir, target);
  } catch (err) {
    return {
      moved: false,
      location: bundleDir,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  try {
    await fs.writeExclusive(
      join(dir, 'failure.json'),
      `${JSON.stringify({ ...failure, files: ['bundle'] }, null, 2)}\n`,
    );
    return { moved: true, location: target, failureJson: true };
  } catch {
    return { moved: true, location: target, failureJson: false };
  }
}

/** True when `INCIDENTS_DIR/<id>` or `INCIDENTS_DIR/.failed/<id>` exists. */
export async function bundleIdTaken(
  incidentsDir: string,
  bundleId: string,
  fs: EvidenceFs = NODE_EVIDENCE_FS,
): Promise<string | undefined> {
  for (const path of [join(incidentsDir, bundleId), join(incidentsDir, FAILED_DIR, bundleId)]) {
    if (await fs.exists(path)) return path;
  }
  return undefined;
}
