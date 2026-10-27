import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const here = (name: string) => new URL(`../${name}`, import.meta.url);

describe('the storefront page', () => {
  it('links an icon file that exists, so browsers do not request /favicon.ico', () => {
    const html = readFileSync(here('index.html'), 'utf8');
    const href = /<link rel="icon"[^>]* href="\/([^"]+)"/.exec(html)?.[1];
    expect(href).toBe('favicon.svg');
    expect(existsSync(here(`public/${href ?? ''}`))).toBe(true);
  });
});
