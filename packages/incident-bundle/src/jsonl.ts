/**
 * JSON Lines as the bundle uses them (docs/prompts/m5-design.md, "JSONL rules"): UTF-8, one record
 * per line, every line ending in `\n`, no blank lines. An empty file has zero records.
 */
export function toJsonl(records: readonly unknown[]): string {
  return records.map((r) => `${JSON.stringify(r)}\n`).join('');
}

export type JsonlLine = { line: number; value: unknown } | { line: number; error: string };

/** Splits and parses a JSONL text. Line numbers start at 1. */
export function parseJsonl(text: string): { lines: JsonlLine[]; errors: JsonlLine[] } {
  const lines: JsonlLine[] = [];
  const errors: JsonlLine[] = [];
  if (text === '') return { lines, errors };
  const parts = text.split('\n');
  if (parts.at(-1) !== '') {
    errors.push({ line: parts.length, error: 'the last line does not end with a newline' });
  } else {
    parts.pop();
  }
  parts.forEach((raw, i) => {
    const line = i + 1;
    if (raw.trim() === '') {
      errors.push({ line, error: 'blank line' });
      return;
    }
    try {
      lines.push({ line, value: JSON.parse(raw) as unknown });
    } catch {
      errors.push({ line, error: 'malformed JSON' });
    }
  });
  return { lines, errors };
}

/** The record count of a JSONL text: its number of lines. */
export function jsonlRecordCount(text: string): number {
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
