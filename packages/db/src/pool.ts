import pg from 'pg';

export interface PoolConfig {
  connectionString: string;
  /** Upper bound for acquiring a connection, so callers fail fast when Postgres is down. */
  connectionTimeoutMillis?: number;
  /** Server-side `statement_timeout` for every connection. It also bounds lock waits. */
  statementTimeoutMillis?: number;
  max?: number;
}

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
/** Anything that can run a single statement: a pool or a checked-out client. */
export type Queryable = pg.Pool | pg.PoolClient;

/**
 * Creates a connection pool. `onError` receives errors from idle clients, for example when
 * Postgres restarts. Without a listener, pg would crash the process on those errors.
 */
export function createPool(config: PoolConfig, onError: (err: Error) => void): Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 2000,
    max: config.max ?? 10,
    ...(config.statementTimeoutMillis === undefined
      ? {}
      : { statement_timeout: config.statementTimeoutMillis }),
  });
  pool.on('error', onError);
  return pool;
}

/**
 * Returns true when `SELECT 1` succeeds within `timeoutMs`. Used by readiness endpoints.
 * Throws nothing: failures are reported through the optional `onFailure` callback.
 */
export async function pingDatabase(
  pool: Pool,
  timeoutMs: number,
  onFailure?: (err: unknown) => void,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`database ping timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([pool.query('SELECT 1'), timeout]);
    return true;
  } catch (err) {
    onFailure?.(err);
    return false;
  } finally {
    clearTimeout(timer);
  }
}
