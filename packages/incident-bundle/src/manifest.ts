import { z } from 'zod';
import {
  count,
  hex,
  identifier,
  positive,
  PROMETHEUS_NAME,
  schemaVersion1,
  text,
  timestamp,
  uint32,
} from './formats.js';

/**
 * Incident bundle schema version 1: `manifest.json` (ADR 0007, docs/prompts/m5-design.md,
 * "Bundle documents"). Volatile, never compared byte for byte. Objects are loose.
 */
export const BUNDLE_FILES = [
  'ground_truth.json',
  'traces.jsonl',
  'metrics.jsonl',
  'logs.jsonl',
] as const;
export type BundleFile = (typeof BUNDLE_FILES)[number];
export const MANIFEST_FILE = 'manifest.json';

/** `<scenario>-<seed>-<YYYYMMDDTHHMMSSZ>`, equal to the bundle's directory name. */
export const BUNDLE_ID = /^[a-z][a-z0-9-]*-\d+-\d{8}T\d{6}Z$/;

export const TRUNCATION_REASONS = ['slice_saturated', 'service_cap'] as const;

const fileEntry = z.looseObject({ sha256: hex(64), bytes: count, records: count });

export const manifestSchema = z.looseObject({
  schemaVersion: schemaVersion1,
  bundleId: z.string().regex(BUNDLE_ID),
  createdAt: timestamp,
  scenario: z.looseObject({ name: identifier, version: positive, seed: uint32 }),
  window: z.looseObject({
    loadStartedAt: timestamp,
    loadEndedAt: timestamp,
    captureFrom: timestamp,
    captureTo: timestamp,
  }),
  trigger: z.looseObject({
    startedAt: timestamp,
    stoppedAt: timestamp.nullable(),
    requestedDurationMs: positive,
  }),
  detection: z.looseObject({
    detectedAt: timestamp.nullable(),
    latencyMs: count.nullable(),
    deadlineSeconds: positive,
  }),
  producer: z.looseObject({ repository: text, commit: hex(40), dirty: z.boolean() }),
  services: z.array(z.looseObject({ name: identifier, version: text, instanceId: text })).min(1),
  infrastructure: z.looseObject({ images: z.record(identifier, text) }),
  load: z.looseObject({ profile: identifier, seed: uint32, planHash: hex(64), runPrefix: text }),
  capture: z.looseObject({
    traces: z.looseObject({
      source: z.literal('jaeger-v3'),
      sliceSeconds: z.number().positive(),
      minSliceSeconds: z.number().positive(),
      searchDepth: positive,
      maxTracesPerService: positive,
      droppedAdminSpans: count,
      services: z.array(
        z.looseObject({
          name: identifier,
          traces: count,
          saturatedSlices: count,
          truncated: z.boolean(),
          truncationReasons: z.array(z.enum(TRUNCATION_REASONS)),
        }),
      ),
    }),
    metrics: z.looseObject({
      source: z.literal('prometheus'),
      stepSeconds: positive,
      series: z.array(
        z.looseObject({ name: z.string().regex(PROMETHEUS_NAME), seriesCount: count }),
      ),
    }),
    logs: z.looseObject({
      source: z.literal('docker-compose'),
      services: z.array(
        z.looseObject({
          name: identifier,
          records: count,
          nonJsonLines: count,
          droppedAdminLines: count,
        }),
      ),
    }),
  }),
  files: z.looseObject({
    'ground_truth.json': fileEntry,
    'traces.jsonl': fileEntry,
    'metrics.jsonl': fileEntry,
    'logs.jsonl': fileEntry,
  }),
});

export type Manifest = z.infer<typeof manifestSchema>;
/** Every manifest field except `files`, which the writer computes. */
export type ManifestBody = z.infer<ReturnType<typeof manifestSchema.omit<{ files: true }>>>;
export type FileEntry = z.infer<typeof fileEntry>;
