import { z } from 'zod';

/** Shared field formats for the bundle documents (docs/prompts/m5-design.md, "Bundle documents"). */
export const IDENTIFIER = /^[a-z][a-z0-9-]*$/;
export const identifier = z.string().regex(IDENTIFIER);
export const text = z.string().min(1);
export const uint32 = z.number().int().min(0).max(0xffffffff);
export const count = z.number().int().min(0);
export const positive = z.number().int().positive();
/** ISO 8601 UTC with milliseconds, such as `2026-10-25T14:03:07.250Z`. */
export const timestamp = z.iso.datetime({ precision: 3 });
export const hex = (length: number) =>
  z.string().regex(new RegExp(`^[0-9a-f]{${String(length)}}$`));
/** A schema version this producer writes: major 1. */
export const schemaVersion1 = z.string().regex(/^1\.\d+\.\d+$/);
export const PROMETHEUS_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
export const PROMETHEUS_LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
