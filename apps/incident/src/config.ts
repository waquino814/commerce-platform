import { SCENARIO_NAMES, type ScenarioName } from '@commerce/faults';
import { z } from 'zod';

/**
 * Incident CLI configuration (docs/prompts/m5c-design.md, section 8.1), validated with Zod. URLs
 * default to IP literals: the isolation checks reject hostnames, including `localhost`.
 */
export const DEFAULTS = {
  ORDERS_API_URL: 'http://127.0.0.1:3000',
  JAEGER_URL: 'http://127.0.0.1:16686',
  PROMETHEUS_URL: 'http://127.0.0.1:9090',
  INCIDENTS_DIR: 'incidents',
} as const;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface IncidentConfig {
  ordersApiUrl: string;
  jaegerUrl: string;
  prometheusUrl: string;
  incidentsDir: string;
  composeProjectName: string | undefined;
  dockerHost: string | undefined;
}

const envSchema = z.object({
  ORDERS_API_URL: z.string().trim().min(1).optional(),
  JAEGER_URL: z.string().trim().min(1).optional(),
  PROMETHEUS_URL: z.string().trim().min(1).optional(),
  INCIDENTS_DIR: z.string().trim().min(1).optional(),
  COMPOSE_PROJECT_NAME: z.string().optional(),
  DOCKER_HOST: z.string().optional(),
});

export function loadConfig(env: Record<string, string | undefined>): IncidentConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(
      `${String(issue?.path[0] ?? 'environment')}: ${issue?.message ?? 'invalid'}`,
    );
  }
  const e = parsed.data;
  const url = (name: 'ORDERS_API_URL' | 'JAEGER_URL' | 'PROMETHEUS_URL'): string => {
    const value = e[name] ?? DEFAULTS[name];
    if (!URL.canParse(value)) throw new ConfigError(`${name}: not a URL: ${value}`);
    return value.replace(/\/+$/, '');
  };
  return {
    ordersApiUrl: url('ORDERS_API_URL'),
    jaegerUrl: url('JAEGER_URL'),
    prometheusUrl: url('PROMETHEUS_URL'),
    incidentsDir: e.INCIDENTS_DIR ?? DEFAULTS.INCIDENTS_DIR,
    composeProjectName: e.COMPOSE_PROJECT_NAME === '' ? undefined : e.COMPOSE_PROJECT_NAME,
    dockerHost: e.DOCKER_HOST === '' ? undefined : e.DOCKER_HOST,
  };
}

export function parseScenario(value: string | undefined): ScenarioName {
  if (value === undefined) throw new ConfigError('--scenario is required');
  const name = SCENARIO_NAMES.find((n) => n === value);
  if (!name) {
    throw new ConfigError(
      `--scenario: unknown scenario "${value}"; available: ${SCENARIO_NAMES.join(', ')}`,
    );
  }
  return name;
}

export function parseSeed(value: string | undefined): number {
  if (value === undefined) throw new ConfigError('--seed is required');
  if (!/^\d+$/.test(value) || Number(value) > 0xffffffff) {
    throw new ConfigError('--seed: must be an integer from 0 to 4294967295');
  }
  return Number(value);
}
