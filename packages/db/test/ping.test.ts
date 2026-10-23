import { afterAll, describe, expect, it } from 'vitest';
import { pingDatabase } from '../src/index.js';
import { createTestPool, UNREACHABLE_DATABASE_URL } from './support.js';

describe('pingDatabase', () => {
  const reachable = createTestPool();
  const unreachable = createTestPool(UNREACHABLE_DATABASE_URL);
  afterAll(() => Promise.all([reachable.end(), unreachable.end()]));

  it('returns true when the database answers', async () => {
    expect(await pingDatabase(reachable, 1000)).toBe(true);
  });

  it('returns false and reports the error when the database is unreachable', async () => {
    const failures: unknown[] = [];
    expect(await pingDatabase(unreachable, 1000, (err) => failures.push(err))).toBe(false);
    expect(failures).toHaveLength(1);
  });

  it('returns false when the query exceeds the timeout', async () => {
    const slow = { query: () => new Promise(() => undefined) } as unknown as typeof reachable;
    const started = Date.now();
    expect(await pingDatabase(slow, 50)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
