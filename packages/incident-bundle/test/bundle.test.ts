import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  formatBundleError,
  JSON_SCHEMA_FILES,
  jsonlRecordCount,
  jsonSchemaText,
  logsRecordSchema,
  manifestSchema,
  metricsRecordSchema,
  NODE_BUNDLE_FS,
  parseJsonl,
  toJsonl,
  traceRecordSchema,
  validateBundle,
  writeBundle,
  type BundleFs,
} from '../src/index.js';
import { BUNDLE_ID, contents, manifestBody, tempDir } from './support.js';

/** M5b criteria B1 (schemas), B2 (validator) and B3 (writer). */
let cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});
function scratch(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

async function writtenBundle(): Promise<string> {
  return (await writeBundle(scratch(), contents())).dir;
}

async function errorsOf(dir: string): Promise<string[]> {
  return (await validateBundle(dir)).errors.map(formatBundleError);
}

describe('schemas v1 (B1)', () => {
  it('each committed JSON Schema file matches its Zod schema (drift test)', () => {
    for (const file of Object.keys(JSON_SCHEMA_FILES) as (keyof typeof JSON_SCHEMA_FILES)[]) {
      const path = new URL(`../../../docs/schemas/incident-bundle/v1/${file}`, import.meta.url);
      const expected = jsonSchemaText(file);
      if (process.env.WRITE_SCHEMAS === '1') writeFileSync(path, expected);
      expect(readFileSync(path, 'utf8'), file).toBe(expected);
      const schema = JSON.parse(expected) as Record<string, unknown>;
      expect(schema.$schema, file).toBe('https://json-schema.org/draft/2020-12/schema');
      expect(schema.additionalProperties, file).toEqual({});
    }
    expect(Object.keys(JSON_SCHEMA_FILES).sort()).toEqual([
      'ground-truth.schema.json',
      'logs-record.schema.json',
      'manifest.schema.json',
      'metrics-record.schema.json',
      'trace-record.schema.json',
    ]);
  });

  it('loose objects accept unknown fields at every level', () => {
    const files = { sha256: 'd'.repeat(64), bytes: 0, records: 0, extra: true };
    const manifest = {
      ...manifestBody(),
      addedInMinor: 1,
      files: {
        'ground_truth.json': files,
        'traces.jsonl': files,
        'metrics.jsonl': files,
        'logs.jsonl': files,
        'extra.jsonl': files,
      },
    };
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    const c = contents();
    expect(metricsRecordSchema.safeParse({ ...c.metrics[0], unit: 's' }).success).toBe(true);
    expect(logsRecordSchema.safeParse({ ...c.logs[0], host: 'x' }).success).toBe(true);
    expect(traceRecordSchema.safeParse({ ...c.traces[0], schemaUrl: 'x' }).success).toBe(true);
  });

  it('rejects missing fields, bad formats and versions', () => {
    const files = { sha256: 'd'.repeat(64), bytes: 0, records: 0 };
    const allFiles = {
      'ground_truth.json': files,
      'traces.jsonl': files,
      'metrics.jsonl': files,
      'logs.jsonl': files,
    };
    const ok = { ...manifestBody(), files: allFiles };
    const bad: [string, unknown][] = [
      ['no files', manifestBody()],
      ['a missing file entry', { ...ok, files: { ...allFiles, 'logs.jsonl': undefined } }],
      ['major 2', { ...ok, schemaVersion: '2.0.0' }],
      ['bundle ID format', { ...ok, bundleId: 'Payment-42' }],
      ['time without milliseconds', { ...ok, createdAt: '2026-10-25T14:00:00Z' }],
      ['short commit', { ...ok, producer: { ...ok.producer, commit: 'abc' } }],
      [
        'uppercase sha256',
        { ...ok, files: { ...allFiles, 'traces.jsonl': { ...files, sha256: 'D'.repeat(64) } } },
      ],
      ['no services', { ...ok, services: [] }],
      [
        'unknown truncation reason',
        {
          ...ok,
          capture: {
            ...ok.capture,
            traces: {
              ...ok.capture.traces,
              services: [
                {
                  name: 'worker',
                  traces: 0,
                  saturatedSlices: 0,
                  truncated: true,
                  truncationReasons: ['other'],
                },
              ],
            },
          },
        },
      ],
    ];
    for (const [label, doc] of bad)
      expect(manifestSchema.safeParse(doc).success, label).toBe(false);

    const metric = contents().metrics[0];
    for (const value of ['+Inf', '-Inf', 'NaN', '1e-3', '-2.5', '7']) {
      expect(
        metricsRecordSchema.safeParse({ ...metric, samples: [[1, value]] }).success,
        value,
      ).toBe(true);
    }
    for (const value of ['inf', '', '1,5', 'x']) {
      expect(
        metricsRecordSchema.safeParse({ ...metric, samples: [[1, value]] }).success,
        value,
      ).toBe(false);
    }
    expect(metricsRecordSchema.safeParse({ ...metric, samples: [[1, 3]] }).success).toBe(false);
    const log = contents().logs[0];
    expect(logsRecordSchema.safeParse({ ...log, level: 'notice' }).success).toBe(false);
    expect(logsRecordSchema.safeParse({ ...log, trace_id: 'xyz' }).success).toBe(false);
    expect(traceRecordSchema.safeParse({ resourceSpans: [] }).success).toBe(false);
  });
});

describe('JSONL', () => {
  it('writes one line per record and counts lines', () => {
    expect(toJsonl([])).toBe('');
    expect(toJsonl([{ a: 1 }, { b: 2 }])).toBe('{"a":1}\n{"b":2}\n');
    expect(jsonlRecordCount('')).toBe(0);
    expect(jsonlRecordCount('{}\n{}\n')).toBe(2);
    expect(jsonlRecordCount('{}\n{}')).toBe(2);
    expect(parseJsonl('{}\n\n{\n').errors).toEqual([
      { line: 2, error: 'blank line' },
      { line: 3, error: 'malformed JSON' },
    ]);
    expect(parseJsonl('{}').errors).toEqual([
      { line: 1, error: 'the last line does not end with a newline' },
    ]);
  });
});

describe('writer (B3)', () => {
  it('writes the five files with checksums, and the bundle validates', async () => {
    const parent = scratch();
    const { dir, manifest } = await writeBundle(parent, contents());
    expect(dir).toBe(join(parent, BUNDLE_ID));
    expect((await readdir(dir)).sort()).toEqual([
      'ground_truth.json',
      'logs.jsonl',
      'manifest.json',
      'metrics.jsonl',
      'traces.jsonl',
    ]);
    expect(await readdir(parent)).toEqual([BUNDLE_ID]);
    expect(await readFile(join(dir, 'manifest.json'), 'utf8')).toBe(canonicalJson(manifest));
    expect(manifest.files['traces.jsonl'].records).toBe(1);
    expect(manifest.files['ground_truth.json'].records).toBe(1);
    expect(await validateBundle(dir)).toEqual({ valid: true, errors: [] });
  });

  it('writes empty JSONL files as zero records', async () => {
    const parent = scratch();
    const c = { ...contents(), traces: [], metrics: [], logs: [] };
    const { dir, manifest } = await writeBundle(parent, c);
    expect(manifest.files['logs.jsonl']).toMatchObject({ bytes: 0, records: 0 });
    expect(await validateBundle(dir)).toEqual({ valid: true, errors: [] });
  });

  it('refuses an existing bundle directory and leaves it untouched', async () => {
    const parent = scratch();
    await mkdir(join(parent, BUNDLE_ID));
    await writeFile(join(parent, BUNDLE_ID, 'keep.txt'), 'x');
    await expect(writeBundle(parent, contents())).rejects.toThrow(/already exists/);
    expect(await readdir(join(parent, BUNDLE_ID))).toEqual(['keep.txt']);
    expect(await readdir(parent)).toEqual([BUNDLE_ID]);
  });

  it('an interrupted write leaves no directory under the final name and removes its temp directory', async () => {
    const parent = scratch();
    const seen: string[] = [];
    let writes = 0;
    const failing: BundleFs = {
      ...NODE_BUNDLE_FS,
      mkdir: (path) => {
        seen.push(path);
        return NODE_BUNDLE_FS.mkdir(path);
      },
      writeFile: (path, data) => {
        writes += 1;
        return writes === 3
          ? Promise.reject(new Error('disk full'))
          : NODE_BUNDLE_FS.writeFile(path, data);
      },
    };
    await expect(writeBundle(parent, contents(), failing)).rejects.toThrow('disk full');
    expect(await readdir(parent)).toEqual([]);
    expect(seen[0]).toMatch(new RegExp(`/\\.${BUNDLE_ID}\\.tmp-[0-9a-f]{12}$`));
  });

  it('a failed rename also cleans up', async () => {
    const parent = scratch();
    const failing: BundleFs = {
      ...NODE_BUNDLE_FS,
      rename: () => Promise.reject(new Error('EXDEV')),
    };
    await expect(writeBundle(parent, contents(), failing)).rejects.toThrow('EXDEV');
    expect(await readdir(parent)).toEqual([]);
  });

  it('refuses invalid contents before writing anything', async () => {
    const parent = scratch();
    const c = contents();
    await expect(
      writeBundle(parent, { ...c, manifest: { ...c.manifest, schemaVersion: '2.0.0' } }),
    ).rejects.toThrow();
    await expect(
      writeBundle(parent, { ...c, groundTruth: { ...c.groundTruth, affectedComponents: [] } }),
    ).rejects.toThrow();
    expect(await readdir(parent)).toEqual([]);
  });
});

describe('validator (B2)', () => {
  const patchManifest = async (dir: string, patch: (m: Record<string, unknown>) => void) => {
    const path = join(dir, 'manifest.json');
    const m = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    patch(m);
    await writeFile(path, canonicalJson(m));
  };

  it('reports a missing file', async () => {
    const dir = await writtenBundle();
    await NODE_BUNDLE_FS.rm(join(dir, 'logs.jsonl'), { recursive: true, force: true });
    expect(await errorsOf(dir)).toEqual(['logs.jsonl: missing file']);
  });

  it('reports a malformed line, with its file and line, and the count mismatch it causes', async () => {
    const dir = await writtenBundle();
    await writeFile(join(dir, 'metrics.jsonl'), '{not json}\n');
    const errors = await errorsOf(dir);
    expect(errors).toContain('metrics.jsonl: line 1: malformed JSON');
    expect(errors.some((e) => /^manifest\.json: files\.metrics\.jsonl\.sha256: /.test(e))).toBe(
      true,
    );
  });

  it('reports a line that breaks its schema, naming the field', async () => {
    const dir = await writtenBundle();
    const c = contents();
    const log = { ...c.logs[0], level: 'notice' };
    const text = toJsonl([log]);
    await writeFile(join(dir, 'logs.jsonl'), text);
    await patchManifest(dir, (m) => {
      const files = m.files as Record<string, Record<string, unknown>>;
      const entry = files['logs.jsonl'] ?? {};
      entry.sha256 = sha256(text);
      entry.bytes = Buffer.byteLength(text);
    });
    expect(await errorsOf(dir)).toEqual([
      expect.stringMatching(/^logs\.jsonl: line 1: level: /) as string,
    ]);
  });

  it('reports a trace line that mixes two trace IDs', async () => {
    const dir = await writtenBundle();
    const c = contents();
    const trace = structuredClone(c.traces[0]);
    const spans = trace?.resourceSpans[0]?.scopeSpans[0]?.spans;
    if (spans?.[1]) spans[1].traceId = 'e'.repeat(32);
    const text = toJsonl([trace]);
    await writeFile(join(dir, 'traces.jsonl'), text);
    await patchManifest(dir, (m) => {
      const files = m.files as Record<string, Record<string, unknown>>;
      const entry = files['traces.jsonl'] ?? {};
      entry.sha256 = sha256(text);
      entry.bytes = Buffer.byteLength(text);
    });
    expect(await errorsOf(dir)).toEqual([
      'traces.jsonl: line 1: one trace per line: found 2 trace IDs',
    ]);
  });

  it('reports each of a SHA-256, byte or record mismatch', async () => {
    for (const field of ['sha256', 'bytes', 'records'] as const) {
      const dir = await writtenBundle();
      await patchManifest(dir, (m) => {
        const files = m.files as Record<string, Record<string, unknown>>;
        const entry = files['traces.jsonl'] ?? {};
        entry[field] = field === 'sha256' ? '0'.repeat(64) : 999;
      });
      const errors = await errorsOf(dir);
      expect(errors, field).toHaveLength(1);
      expect(errors[0], field).toMatch(
        new RegExp(`^manifest\\.json: files\\.traces\\.jsonl\\.${field}: records `),
      );
    }
  });

  it('reports an unsupported major version, and nothing else from the manifest', async () => {
    const dir = await writtenBundle();
    await patchManifest(dir, (m) => {
      m.schemaVersion = '2.0.0';
      m.bundleId = 'wrong';
    });
    expect(await errorsOf(dir)).toEqual([
      'manifest.json: schemaVersion: unsupported major version in "2.0.0"; supported: 1',
    ]);
  });

  it('reports a manifest whose scenario disagrees with the ground truth', async () => {
    const dir = await writtenBundle();
    await patchManifest(dir, (m) => {
      m.scenario = { name: 'provider-outage', version: 1, seed: 7 };
    });
    expect(await errorsOf(dir)).toEqual([
      'manifest.json: scenario.name: "provider-outage" does not match ground_truth.json ("payment-timeouts")',
      'manifest.json: scenario.seed: 7 does not match ground_truth.json (42)',
    ]);
  });

  it('reports a bundle ID that is not the directory name, and inconsistent truncation', async () => {
    const dir = await writtenBundle();
    await patchManifest(dir, (m) => {
      m.bundleId = 'payment-timeouts-42-20261025T150000Z';
      const capture = m.capture as { traces: { services: { truncated: boolean }[] } };
      const service = capture.traces.services[0];
      if (service) service.truncated = true;
    });
    expect(await errorsOf(dir)).toEqual([
      `manifest.json: bundleId: "payment-timeouts-42-20261025T150000Z" does not match the directory name "${BUNDLE_ID}"`,
      'manifest.json: capture.traces.services.0.truncated: must be true exactly when truncationReasons is not empty',
    ]);
  });

  it('reports malformed JSON documents and an invalid ground truth', async () => {
    const dir = await writtenBundle();
    await writeFile(join(dir, 'manifest.json'), '{');
    await writeFile(
      join(dir, 'ground_truth.json'),
      canonicalJson({
        ...contents().groundTruth,
        affectedComponents: ['worker', 'payment-provider'],
      }),
    );
    expect(await errorsOf(dir)).toEqual([
      'manifest.json: malformed JSON',
      'ground_truth.json: affectedComponents: must be sorted and unique',
    ]);
    await writeFile(join(dir, 'ground_truth.json'), '{}');
    expect((await errorsOf(dir)).filter((e) => e.startsWith('ground_truth.json'))).toContain(
      'ground_truth.json: schemaVersion: Invalid input: expected string, received undefined',
    );
  });
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
