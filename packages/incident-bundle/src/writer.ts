import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from './canonical.js';
import { parseGroundTruth, type GroundTruth } from './ground-truth.js';
import { toJsonl } from './jsonl.js';
import {
  MANIFEST_FILE,
  manifestSchema,
  type BundleFile,
  type FileEntry,
  type Manifest,
  type ManifestBody,
} from './manifest.js';
import type { LogsRecord, MetricsRecord, TraceRecord } from './records.js';

/**
 * The atomic bundle writer (docs/prompts/m5-design.md, "Bundle documents", criterion B3). It writes
 * the five files into `<parent>/.<bundleId>.tmp-<random>`, then renames that directory to
 * `<parent>/<bundleId>`, so the final name only ever holds a complete bundle. It never overwrites
 * an existing bundle, and removes its temporary directory when anything fails.
 */
export interface BundleFs {
  mkdir(path: string): Promise<unknown>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export const NODE_BUNDLE_FS: BundleFs = {
  mkdir: (path) => nodeFs.mkdir(path),
  writeFile: (path, data) => nodeFs.writeFile(path, data),
  rename: (from, to) => nodeFs.rename(from, to),
  rm: (path, options) => nodeFs.rm(path, options),
  exists: (path) =>
    nodeFs.access(path).then(
      () => true,
      () => false,
    ),
};

export interface BundleContents {
  manifest: ManifestBody;
  groundTruth: GroundTruth;
  traces: readonly TraceRecord[];
  metrics: readonly MetricsRecord[];
  logs: readonly LogsRecord[];
}

export async function writeBundle(
  parentDir: string,
  contents: BundleContents,
  fs: BundleFs = NODE_BUNDLE_FS,
): Promise<{ dir: string; manifest: Manifest }> {
  const bundleId = contents.manifest.bundleId;
  const target = join(parentDir, bundleId);
  if (await fs.exists(target)) throw new Error(`bundle directory already exists: ${target}`);

  const texts: Record<BundleFile, { text: string; records: number }> = {
    'ground_truth.json': {
      text: canonicalJson(parseGroundTruth(contents.groundTruth)),
      records: 1,
    },
    'traces.jsonl': { text: toJsonl(contents.traces), records: contents.traces.length },
    'metrics.jsonl': { text: toJsonl(contents.metrics), records: contents.metrics.length },
    'logs.jsonl': { text: toJsonl(contents.logs), records: contents.logs.length },
  };
  const files = Object.fromEntries(
    Object.entries(texts).map(([file, { text, records }]) => [file, fileEntry(text, records)]),
  ) as Record<BundleFile, FileEntry>;
  const manifest = manifestSchema.parse({ ...contents.manifest, files });

  const temp = join(parentDir, `.${bundleId}.tmp-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(temp);
  try {
    for (const [file, { text }] of Object.entries(texts))
      await fs.writeFile(join(temp, file), text);
    await fs.writeFile(join(temp, MANIFEST_FILE), canonicalJson(manifest));
    await fs.rename(temp, target);
  } catch (err) {
    await fs.rm(temp, { recursive: true, force: true });
    throw err;
  }
  return { dir: target, manifest };
}

function fileEntry(text: string, records: number): FileEntry {
  const data = Buffer.from(text, 'utf8');
  return { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, records };
}
