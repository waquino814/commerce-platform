import { z } from 'zod';

/** Accepts only postgres:// or postgresql:// URLs. */
export const databaseUrlSchema = z.url({
  protocol: /^postgres(ql)?$/,
  error: 'must be a postgres:// or postgresql:// URL',
});

export class ConfigError extends Error {
  override name = 'ConfigError';
}

/** Parses `env` with `schema`, throwing a ConfigError that names every invalid variable. */
export function parseEnv<T extends z.ZodType>(schema: T, env: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ConfigError(`invalid configuration: ${details}`);
  }
  return result.data;
}
