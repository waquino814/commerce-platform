import { hostname } from 'node:os';
import { ConfigError, databaseUrlSchema, parseEnv } from '@commerce/db';
import { z } from 'zod';
import { processingBudgetMs, type Limits } from './lifecycle.js';

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

const schema = z.object({
  DATABASE_URL: databaseUrlSchema,
  WORKER_ID: z.string().trim().min(1).optional(),
  POLL_INTERVAL_MS: int(10, 60_000).default(1000),
  CLAIM_BATCH_SIZE: int(1, 1000).default(10),
  HEALTH_PORT: int(1, 65_535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  WORKER_CONCURRENCY: int(1, 100).default(5),
  CLAIM_TIMEOUT_MS: int(1000, 3_600_000).default(60_000),
  DB_CONNECT_TIMEOUT_MS: int(100, 60_000).default(2000),
  DB_STATEMENT_TIMEOUT_MS: int(100, 60_000).default(2000),
  PAYMENT_TIMEOUT_MS: int(100, 60_000).default(5000),
  PAYMENT_LATENCY_MS: int(0, 10_000).default(50),
  MAX_CLAIMS: int(2, 1000).default(10),
  MAX_CHARGE_ATTEMPTS: int(1, 100).default(3),
  MAX_RECONCILIATION_ATTEMPTS: int(1, 100).default(5),
  RETRY_BASE_DELAY_MS: int(100, 3_600_000).default(1000),
  RETRY_MAX_DELAY_MS: int(100, 3_600_000).default(30_000),
  RECONCILIATION_BASE_DELAY_MS: int(1000, 3_600_000).default(5000),
  RECONCILIATION_MAX_DELAY_MS: int(1000, 3_600_000).default(60_000),
  PAYMENT_UNKNOWN_RECHECK_MS: int(60_000, 86_400_000).default(900_000),
});

export interface Config {
  databaseUrl: string;
  workerId: string;
  pollIntervalMs: number;
  claimBatchSize: number;
  healthPort: number;
  logLevel: z.infer<typeof schema>['LOG_LEVEL'];
  concurrency: number;
  claimTimeoutMs: number;
  dbConnectTimeoutMs: number;
  dbStatementTimeoutMs: number;
  paymentTimeoutMs: number;
  paymentLatencyMs: number;
  /** Worst-case processing time for one pass: 2C + 11S + 2P. */
  processingBudgetMs: number;
  limits: Limits;
}

/** Reads and validates configuration. Throws ConfigError naming every invalid variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const p = parseEnv(schema, env);
  const budget = processingBudgetMs({
    connectMs: p.DB_CONNECT_TIMEOUT_MS,
    statementMs: p.DB_STATEMENT_TIMEOUT_MS,
    paymentMs: p.PAYMENT_TIMEOUT_MS,
  });
  const problems: string[] = [];
  if (p.CLAIM_TIMEOUT_MS < 1.5 * budget) {
    problems.push(
      `CLAIM_TIMEOUT_MS: must be at least 1.5 × the processing budget ` +
        `(2 × DB_CONNECT_TIMEOUT_MS + 11 × DB_STATEMENT_TIMEOUT_MS + 2 × PAYMENT_TIMEOUT_MS = ${budget} ms), ` +
        `so at least ${Math.ceil(1.5 * budget)} ms`,
    );
  }
  if (p.MAX_CLAIMS <= p.MAX_CHARGE_ATTEMPTS) {
    problems.push('MAX_CLAIMS: must be greater than MAX_CHARGE_ATTEMPTS');
  }
  if (p.RETRY_MAX_DELAY_MS < p.RETRY_BASE_DELAY_MS) {
    problems.push('RETRY_MAX_DELAY_MS: must be at least RETRY_BASE_DELAY_MS');
  }
  if (p.RECONCILIATION_MAX_DELAY_MS < p.RECONCILIATION_BASE_DELAY_MS) {
    problems.push('RECONCILIATION_MAX_DELAY_MS: must be at least RECONCILIATION_BASE_DELAY_MS');
  }
  if (problems.length > 0) {
    throw new ConfigError(`invalid configuration: ${problems.join('; ')}`);
  }
  return {
    databaseUrl: p.DATABASE_URL,
    workerId: p.WORKER_ID ?? hostname(),
    pollIntervalMs: p.POLL_INTERVAL_MS,
    claimBatchSize: p.CLAIM_BATCH_SIZE,
    healthPort: p.HEALTH_PORT,
    logLevel: p.LOG_LEVEL,
    concurrency: p.WORKER_CONCURRENCY,
    claimTimeoutMs: p.CLAIM_TIMEOUT_MS,
    dbConnectTimeoutMs: p.DB_CONNECT_TIMEOUT_MS,
    dbStatementTimeoutMs: p.DB_STATEMENT_TIMEOUT_MS,
    paymentTimeoutMs: p.PAYMENT_TIMEOUT_MS,
    paymentLatencyMs: p.PAYMENT_LATENCY_MS,
    processingBudgetMs: budget,
    limits: {
      maxClaims: p.MAX_CLAIMS,
      maxChargeAttempts: p.MAX_CHARGE_ATTEMPTS,
      maxReconciliationAttempts: p.MAX_RECONCILIATION_ATTEMPTS,
      retryBaseDelayMs: p.RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: p.RETRY_MAX_DELAY_MS,
      reconciliationBaseDelayMs: p.RECONCILIATION_BASE_DELAY_MS,
      reconciliationMaxDelayMs: p.RECONCILIATION_MAX_DELAY_MS,
      paymentUnknownRecheckMs: p.PAYMENT_UNKNOWN_RECHECK_MS,
    },
  };
}
