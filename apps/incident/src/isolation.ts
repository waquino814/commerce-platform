import { z } from 'zod';
import type { HttpFetch } from './capture/deps.js';
import type { IncidentConfig } from './config.js';

/**
 * Local isolation checks (docs/prompts/m5c-design.md, section 8.2), shared by `run` and
 * `capture-check`. Every check fails closed: a check that cannot run, gets unparseable output, or
 * finds an ambiguous mapping never passes.
 */
export type CheckStatus = 'PASS' | 'FAIL' | 'INCONCLUSIVE';
export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

/**
 * Runtime facts behind the isolation checks (docs/prompts/m5c-design.md, section 14, open items 1
 * to 3). A check that depends on a fact still `false` reports INCONCLUSIVE instead of PASS. A fact
 * changes only after the owner reviews evidence from an authorized container-integration test.
 * Each flag asserts only what its comment says; every check still runs, and fails closed, on
 * every invocation.
 */
export interface RuntimeVerification {
  /**
   * Open item 1: the parser reads the real `docker compose ps --format json` output correctly:
   * one object per line, with `ID`, `Service`, `Project`, `Image`, `State`, `Health` and
   * `Publishers`. It says nothing about which addresses are bound; check 5 tests that each time.
   */
  composePsShape: boolean;
  /**
   * Open item 2: the installed Compose supports `!override`, and the resolved
   * `docker compose config --format json` ports are read correctly. Configuration only.
   */
  composeOverride: boolean;
  /**
   * Open item 3: inside the orders-api container, `hostname()` (its `service.instance.id`) is the
   * short container ID, so the Prometheus `instance` label of `job="orders-api"` can be matched
   * against `docker compose ps`. This ties the Prometheus backend to that container only: it does
   * not prove the CLI's HTTP traffic reaches the same container, the worker is not tied to its
   * container ID, and Jaeger is not tied to the project.
   */
  containerIdentity: boolean;
}

/**
 * Verified by the owner on 2026-10-25 from container-integration evidence on Docker Compose
 * v5.4.0 (docs/prompts/m5c-design.md, section 14): items 1 and 3 against the running stack,
 * item 2 for configuration resolution. Trace volume and Jaeger capture time (item 4) have no flag
 * here and remain unverified.
 */
export const RUNTIME_VERIFICATION: RuntimeVerification = Object.freeze({
  composePsShape: true,
  composeOverride: true,
  containerIdentity: true,
});

export const PROJECT_NAME = 'commerce-platform';
export const EXPECTED_SERVICES = [
  'orders-api',
  'worker',
  'jaeger',
  'prometheus',
  'otel-collector',
] as const;
export const FAULT_CONTROL_SERVICES = ['orders-api', 'worker'] as const;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

export type RunCommandSimple = (
  command: string,
  args: readonly string[],
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const pass = (name: string, detail: string): CheckResult => ({ name, status: 'PASS', detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: 'FAIL', detail });
const inconclusive = (name: string, detail: string): CheckResult => ({
  name,
  status: 'INCONCLUSIVE',
  detail,
});

/** A PASS that rests on an unverified runtime fact becomes INCONCLUSIVE; FAIL stays FAIL. */
function gated(result: CheckResult, verified: boolean, item: string): CheckResult {
  if (result.status !== 'PASS' || verified) return result;
  return inconclusive(result.name, `${result.detail}; not trusted until ${item} is verified`);
}

/** Check 1: `http:` and the IP literal 127.0.0.1 or [::1]; hostnames, including localhost, fail. */
export function checkUrls(config: IncidentConfig): CheckResult {
  const name = 'url-form';
  const urls = {
    ORDERS_API_URL: config.ordersApiUrl,
    JAEGER_URL: config.jaegerUrl,
    PROMETHEUS_URL: config.prometheusUrl,
  };
  for (const [variable, value] of Object.entries(urls)) {
    const problem = urlProblem(value);
    if (problem) return fail(name, `${variable}: ${problem}`);
  }
  return pass(name, 'every URL is http: on 127.0.0.1 or [::1]');
}

export function urlProblem(value: string): string | undefined {
  if (!URL.canParse(value)) return `not a URL: ${value}`;
  const u = new URL(value);
  if (u.protocol !== 'http:') return `must use http:, not ${u.protocol}`;
  if (u.hostname !== '127.0.0.1' && u.hostname !== '[::1]') {
    return `host must be the IP literal 127.0.0.1 or [::1], not ${u.hostname}`;
  }
  if (u.username || u.password) return 'must not contain credentials';
  if ((u.pathname !== '/' && u.pathname !== '') || u.search || u.hash)
    return 'must have no path, query or fragment';
  return undefined;
}

/** The host IP and port a URL connects to; the port defaults to 80. */
export function urlEndpoint(value: string): { ip: string; port: number } {
  const u = new URL(value);
  return {
    ip: u.hostname === '[::1]' ? '::1' : u.hostname,
    port: u.port === '' ? 80 : Number(u.port),
  };
}

/** Check 2: `DOCKER_HOST` unset or local, and the current context's endpoint local. */
export async function checkDocker(
  config: IncidentConfig,
  run: RunCommandSimple,
): Promise<CheckResult> {
  const name = 'local-docker';
  const local = (host: string) => host.startsWith('unix://') || host.startsWith('npipe://');
  if (config.dockerHost !== undefined && !local(config.dockerHost)) {
    return fail(name, `DOCKER_HOST is not a local endpoint: ${config.dockerHost}`);
  }
  let result;
  try {
    result = await run('docker', [
      'context',
      'inspect',
      '--format',
      '{{json .Endpoints.docker.Host}}',
    ]);
  } catch (err) {
    return inconclusive(name, `docker context inspect could not run: ${message(err)}`);
  }
  if (result.exitCode !== 0)
    return inconclusive(
      name,
      `docker context inspect exited ${String(result.exitCode)}: ${result.stderr.trim()}`,
    );
  let host: unknown;
  try {
    host = JSON.parse(result.stdout.trim());
  } catch {
    return inconclusive(name, 'docker context inspect output is not JSON');
  }
  if (typeof host !== 'string')
    return inconclusive(name, 'docker context inspect gave no endpoint');
  return local(host)
    ? pass(name, `local Docker endpoint ${host}`)
    : fail(name, `the Docker context is not local: ${host}`);
}

const publisherSchema = z.looseObject({
  URL: z.string(),
  TargetPort: z.number().int(),
  PublishedPort: z.number().int(),
  Protocol: z.string(),
});
const containerSchema = z.looseObject({
  ID: z.string().min(1),
  Service: z.string().min(1),
  Project: z.string().min(1),
  Image: z.string(),
  State: z.string(),
  Health: z.string(),
  Publishers: z.array(publisherSchema).nullable(),
});
export type ComposeContainer = z.infer<typeof containerSchema>;

/** Parses `docker compose ps --format json`: one object per line, or one JSON array. */
export function parseComposePs(stdout: string): ComposeContainer[] | string {
  const text = stdout.trim();
  if (text === '') return [];
  let values: unknown[];
  try {
    if (text.startsWith('[')) {
      const parsed = JSON.parse(text) as unknown;
      if (!Array.isArray(parsed)) return 'expected a JSON array';
      values = parsed;
    } else {
      values = text.split('\n').map((line) => JSON.parse(line) as unknown);
    }
  } catch {
    return 'output is not JSON';
  }
  const result = z.array(containerSchema).safeParse(values);
  return result.success
    ? result.data
    : `unexpected shape: ${result.error.issues[0]?.message ?? ''}`;
}

/** Check 3: one project, exactly one running container per expected service, healthy apps. */
export function checkProject(
  containers: readonly ComposeContainer[],
  config: IncidentConfig,
  verification: RuntimeVerification,
): CheckResult {
  const name = 'compose-project';
  const result = (() => {
    if (config.composeProjectName !== undefined && config.composeProjectName !== PROJECT_NAME) {
      return fail(
        name,
        `COMPOSE_PROJECT_NAME is ${config.composeProjectName}, not ${PROJECT_NAME}`,
      );
    }
    const foreign = containers.find((c) => c.Project !== PROJECT_NAME);
    if (foreign) return fail(name, `container ${foreign.ID} belongs to project ${foreign.Project}`);
    for (const service of EXPECTED_SERVICES) {
      const running = containers.filter((c) => c.Service === service && c.State === 'running');
      if (running.length !== 1) {
        return fail(
          name,
          `expected exactly one running ${service} container, found ${String(running.length)}`,
        );
      }
    }
    for (const service of FAULT_CONTROL_SERVICES) {
      const c = containers.find((x) => x.Service === service);
      if (c?.Health !== 'healthy')
        return fail(name, `${service} is not healthy (${c?.Health ?? 'unknown'})`);
    }
    return pass(name, `project ${PROJECT_NAME}, one running container per service, apps healthy`);
  })();
  return gated(result, verification.composePsShape, 'the docker compose ps shape (open item 1)');
}

/** Check 4: each URL matches exactly one publisher of its service, and no other service. */
export function checkMapping(
  containers: readonly ComposeContainer[],
  config: IncidentConfig,
  verification: RuntimeVerification,
): CheckResult {
  const name = 'url-mapping';
  const result = (() => {
    const pairs = [
      ['ORDERS_API_URL', config.ordersApiUrl, 'orders-api'],
      ['JAEGER_URL', config.jaegerUrl, 'jaeger'],
      ['PROMETHEUS_URL', config.prometheusUrl, 'prometheus'],
    ] as const;
    for (const [variable, url, service] of pairs) {
      const { ip, port } = urlEndpoint(url);
      const matches = containers.flatMap((c) =>
        (c.Publishers ?? [])
          .filter((p) => p.URL === ip && p.PublishedPort === port)
          .map(() => c.Service),
      );
      if (matches.length !== 1 || matches[0] !== service) {
        return fail(
          name,
          `${variable} (${ip}:${String(port)}) must match exactly one publisher of ${service}; found ${matches.length === 0 ? 'none' : matches.join(', ')}`,
        );
      }
    }
    return pass(name, 'each URL matches exactly one publisher of its service');
  })();
  return gated(result, verification.composePsShape, 'the docker compose ps shape (open item 1)');
}

/** Check 5: every publisher of orders-api and worker is bound to 127.0.0.1 or ::1. */
export function checkLoopback(
  containers: readonly ComposeContainer[],
  verification: RuntimeVerification,
): CheckResult {
  const name = 'fault-controls-loopback';
  const result = (() => {
    for (const service of FAULT_CONTROL_SERVICES) {
      const publishers = containers
        .filter((c) => c.Service === service)
        .flatMap((c) => c.Publishers ?? []);
      if (publishers.length === 0)
        return fail(name, `${service} publishes no port; nothing to verify`);
      const open = publishers.find((p) => !LOOPBACK.has(p.URL));
      if (open)
        return fail(
          name,
          `${service} publishes ${String(open.PublishedPort)} on ${open.URL}, not loopback`,
        );
    }
    return pass(name, 'orders-api and worker publish only on loopback');
  })();
  return gated(result, verification.composePsShape, 'the docker compose ps shape (open item 1)');
}

const composeConfigSchema = z.looseObject({
  services: z.record(
    z.string(),
    z.looseObject({
      ports: z
        .array(
          z.looseObject({
            host_ip: z.string().optional(),
            published: z.union([z.string(), z.number()]).optional(),
          }),
        )
        .optional(),
    }),
  ),
});

/** The resolved fault-control ports from `docker compose ... config --format json`, read-only. */
export async function checkComposeOverride(
  run: RunCommandSimple,
  verification: RuntimeVerification,
): Promise<CheckResult> {
  const name = 'compose-override';
  let out;
  try {
    out = await run('docker', [
      'compose',
      '-f',
      'compose.yaml',
      '-f',
      'compose.faults.yaml',
      'config',
      '--format',
      'json',
    ]);
  } catch (err) {
    return inconclusive(name, `docker compose config could not run: ${message(err)}`);
  }
  if (out.exitCode !== 0)
    return inconclusive(
      name,
      `docker compose config exited ${String(out.exitCode)}: ${out.stderr.trim()}`,
    );
  let parsed;
  try {
    parsed = composeConfigSchema.safeParse(JSON.parse(out.stdout) as unknown);
  } catch {
    return inconclusive(name, 'docker compose config output is not JSON');
  }
  if (!parsed.success)
    return inconclusive(name, 'docker compose config output has an unexpected shape');
  const result = (() => {
    for (const service of FAULT_CONTROL_SERVICES) {
      const ports = parsed.data.services[service]?.ports ?? [];
      if (ports.length === 0)
        return fail(name, `${service} has no published ports in the resolved configuration`);
      const open = ports.find((p) => !LOOPBACK.has(p.host_ip ?? ''));
      if (open)
        return fail(
          name,
          `${service} port ${String(open.published ?? '?')} resolves to ${open.host_ip ?? 'all interfaces'}`,
        );
    }
    return pass(name, 'compose.faults.yaml resolves the fault-control ports to loopback');
  })();
  return gated(result, verification.composeOverride, '!override support (open item 2)');
}

/**
 * Identity cross-check (open item 3): the Prometheus `instance` label of `job="orders-api"` against
 * the orders-api container ID. Whether the container's hostname is its short ID is not evidenced,
 * so a match only counts once item 3 is verified.
 */
export async function checkIdentity(
  containers: readonly ComposeContainer[],
  prometheusUrl: string,
  fetch: HttpFetch,
  verification: RuntimeVerification,
): Promise<CheckResult> {
  const name = 'container-identity';
  const api = containers.filter((c) => c.Service === 'orders-api');
  if (api.length !== 1 || !api[0]) return fail(name, 'no single orders-api container to compare');
  const query = 'group by (instance) (db_client_connection_count{job="orders-api"})';
  let instances: string[];
  try {
    const res = await fetch(
      `${prometheusUrl}/api/v1/query?${new URLSearchParams({ query }).toString()}`,
    );
    const body = z
      .looseObject({
        status: z.literal('success'),
        data: z.looseObject({
          result: z.array(z.looseObject({ metric: z.record(z.string(), z.string()) })),
        }),
      })
      .safeParse(await res.json().catch(() => undefined));
    if (res.status !== 200 || !body.success)
      return inconclusive(
        name,
        `Prometheus answered ${String(res.status)} with an unexpected body`,
      );
    instances = body.data.data.result.map((r) => r.metric.instance ?? '');
  } catch (err) {
    return inconclusive(name, `Prometheus could not be queried: ${message(err)}`);
  }
  const id = api[0].ID;
  const result =
    instances.length === 1 &&
    instances[0] &&
    instances[0].length >= 12 &&
    (id.startsWith(instances[0]) || instances[0].startsWith(id))
      ? pass(name, `Prometheus instance ${instances[0]} matches container ${id}`)
      : fail(name, `Prometheus instances [${instances.join(', ')}] do not match container ${id}`);
  return gated(result, verification.containerIdentity, 'the identity cross-check (open item 3)');
}

export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * The isolation checks `run` requires before taking the lock: 1 to 5 and the identity
 * cross-check. A missing or unparseable `ps` output fails checks 3 to 5 and the identity check.
 */
export async function runIsolationChecks(deps: {
  config: IncidentConfig;
  run: RunCommandSimple;
  fetch: HttpFetch;
  verification: RuntimeVerification;
}): Promise<{ checks: CheckResult[]; containers: ComposeContainer[] }> {
  const { config, run, fetch, verification } = deps;
  const checks: CheckResult[] = [checkUrls(config)];
  if (checks[0]?.status !== 'PASS') return { checks, containers: [] };
  checks.push(await checkDocker(config, run));
  let containers: ComposeContainer[] = [];
  let psProblem: string | undefined;
  try {
    const out = await run('docker', ['compose', 'ps', '--format', 'json']);
    if (out.exitCode !== 0)
      psProblem = `docker compose ps exited ${String(out.exitCode)}: ${out.stderr.trim()}`;
    else {
      const parsed = parseComposePs(out.stdout);
      if (typeof parsed === 'string') psProblem = `docker compose ps: ${parsed}`;
      else containers = parsed;
    }
  } catch (err) {
    psProblem = `docker compose ps could not run: ${message(err)}`;
  }
  if (psProblem !== undefined) {
    for (const name of [
      'compose-project',
      'url-mapping',
      'fault-controls-loopback',
      'container-identity',
    ]) {
      checks.push(inconclusive(name, psProblem));
    }
    return { checks, containers };
  }
  checks.push(checkProject(containers, config, verification));
  checks.push(checkMapping(containers, config, verification));
  checks.push(checkLoopback(containers, verification));
  checks.push(await checkIdentity(containers, config.prometheusUrl, fetch, verification));
  return { checks, containers };
}
