import { describe, expect, it } from 'vitest';
import { ADMIN_PATH_PREFIX, isProbePath } from '../src/http.js';

/** M5a criterion A9: scenario control paths are excluded like probes, enabled or not. */
describe('admin path exclusion', () => {
  it('excludes /admin and everything under it, with or without a query', () => {
    expect(ADMIN_PATH_PREFIX).toBe('/admin');
    for (const url of ['/admin', '/admin/', '/admin/scenarios', '/admin/scenarios/x/start?y=1']) {
      expect(isProbePath(url), url).toBe(true);
    }
  });

  it('keeps probes excluded and leaves ordinary paths, including look-alikes, counted', () => {
    expect(isProbePath('/healthz')).toBe(true);
    expect(isProbePath('/readyz?x')).toBe(true);
    for (const url of ['/orders', '/administrator', '/products/admin', undefined, '']) {
      expect(isProbePath(url), String(url)).toBe(false);
    }
  });
});
