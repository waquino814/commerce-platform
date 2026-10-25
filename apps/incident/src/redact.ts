/**
 * Redaction (docs/prompts/m5c-design.md, section 8.4), applied before anything is written: the
 * password in any postgres:// or postgresql:// URL, and the values of attributes named
 * authorization, cookie or set-cookie, become `***`. The count goes in the report only.
 */
const DATABASE_URL_PASSWORD = /(postgres(?:ql)?:\/\/[^:/\s@]+:)([^@\s]+)(@)/gi;
const SENSITIVE_KEYS = new Set(['authorization', 'cookie', 'set-cookie']);
export const REDACTED = '***';

export interface Redactor {
  count: number;
  text(value: string): string;
  value<T>(value: T): T;
}

export function createRedactor(): Redactor {
  const r: Redactor = {
    count: 0,
    text(value) {
      return value.replace(
        DATABASE_URL_PASSWORD,
        (_m, head: string, _password: string, at: string) => {
          r.count += 1;
          return `${head}${REDACTED}${at}`;
        },
      );
    },
    value<T>(value: T): T {
      return walk(value) as T;
    },
  };
  const sensitive = (key: string) => SENSITIVE_KEYS.has(key.toLowerCase());
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return r.text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v === null || typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    // An OTLP KeyValue: { key, value: AnyValue }.
    if (typeof obj.key === 'string' && 'value' in obj && sensitive(obj.key)) {
      r.count += 1;
      return { ...obj, value: { stringValue: REDACTED } };
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(obj)) {
      if (sensitive(k) && x !== null && x !== undefined) {
        r.count += 1;
        out[k] = REDACTED;
      } else {
        out[k] = walk(x);
      }
    }
    return out;
  };
  return r;
}
