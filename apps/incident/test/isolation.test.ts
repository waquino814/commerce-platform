import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  DEFAULTS,
  loadConfig,
  parseScenario,
  parseSeed,
  type IncidentConfig,
} from '../src/config.js';
import { containers } from './support.js';
import {
  RUNTIME_VERIFICATION,
  checkComposeOverride,
  checkDocker,
  checkIdentity,
  checkLoopback,
  checkMapping,
  checkProject,
  checkUrls,
  parseComposePs,
  runIsolationChecks,
  urlProblem,
  type ComposeContainer,
  type RunCommandSimple,
} from '../src/isolation.js';

/** M5c criterion C7: every isolation check fails closed. */
const VERIFIED = { composePsShape: true, composeOverride: true, containerIdentity: true };
/** Every runtime fact unverified: the gating behavior, independent of the production values. */
const UNVERIFIED = { composePsShape: false, composeOverride: false, containerIdentity: false };
const config = (over: Partial<IncidentConfig> = {}): IncidentConfig => ({
  ...loadConfig({}),
  ...over,
});

describe('runtime verification', () => {
  it('records the owner-verified facts; the checks still fail closed on every run', () => {
    expect(RUNTIME_VERIFICATION).toEqual({
      composePsShape: true,
      composeOverride: true,
      containerIdentity: true,
    });
    expect(Object.isFrozen(RUNTIME_VERIFICATION)).toBe(true);
    // Verified facts do not relax any check: the base stack's all-interface bindings still fail.
    const open = containers({
      'orders-api': {
        Publishers: [
          { URL: '0.0.0.0', TargetPort: 3000, PublishedPort: 3000, Protocol: 'tcp' },
          { URL: '::', TargetPort: 3000, PublishedPort: 3000, Protocol: 'tcp' },
        ],
      },
    });
    expect(checkLoopback(open, RUNTIME_VERIFICATION).status).toBe('FAIL');
    expect(checkMapping(open, config(), RUNTIME_VERIFICATION).status).toBe('FAIL');
    expect(
      checkProject(containers({ jaeger: { Project: 'other' } }), config(), RUNTIME_VERIFICATION)
        .status,
    ).toBe('FAIL');
  });
});

describe('configuration', () => {
  it('defaults to IP-literal URLs and validates', () => {
    expect(loadConfig({})).toEqual({
      ordersApiUrl: DEFAULTS.ORDERS_API_URL,
      jaegerUrl: DEFAULTS.JAEGER_URL,
      prometheusUrl: DEFAULTS.PROMETHEUS_URL,
      incidentsDir: 'incidents',
      composeProjectName: undefined,
      dockerHost: undefined,
    });
    expect(
      loadConfig({
        ORDERS_API_URL: 'http://127.0.0.1:3000/',
        COMPOSE_PROJECT_NAME: '',
        DOCKER_HOST: '',
      }),
    ).toMatchObject({
      ordersApiUrl: 'http://127.0.0.1:3000',
      composeProjectName: undefined,
      dockerHost: undefined,
    });
    expect(() => loadConfig({ JAEGER_URL: 'not a url' })).toThrow(/JAEGER_URL: not a URL/);
    expect(() => loadConfig({ INCIDENTS_DIR: '  ' })).toThrow(ConfigError);
  });

  it('parses the scenario and seed, naming the problem', () => {
    expect(parseScenario('poison-order')).toBe('poison-order');
    expect(() => parseScenario(undefined)).toThrow('--scenario is required');
    expect(() => parseScenario('missing-index')).toThrow(
      /unknown scenario "missing-index"; available: api-pool-exhaustion/,
    );
    expect(parseSeed('0')).toBe(0);
    expect(parseSeed('4294967295')).toBe(4294967295);
    for (const bad of ['-1', '1.5', 'x', '4294967296', ''])
      expect(() => parseSeed(bad)).toThrow(/--seed/);
    expect(() => parseSeed(undefined)).toThrow('--seed is required');
  });
});

describe('check 1: URL form', () => {
  it('accepts only http: on 127.0.0.1 or [::1], with no path, query or credentials', () => {
    expect(urlProblem('http://127.0.0.1:3000')).toBeUndefined();
    expect(urlProblem('http://[::1]:3000/')).toBeUndefined();
    expect(urlProblem('http://localhost:3000')).toMatch(/IP literal/);
    expect(urlProblem('https://127.0.0.1:3000')).toMatch(/http:/);
    expect(urlProblem('http://10.0.0.2:3000')).toMatch(/IP literal/);
    expect(urlProblem('http://u:p@127.0.0.1:3000')).toMatch(/credentials/);
    expect(urlProblem('http://127.0.0.1:3000/api')).toMatch(/no path/);
    expect(urlProblem('nope')).toMatch(/not a URL/);
    expect(checkUrls(config()).status).toBe('PASS');
    expect(checkUrls(config({ prometheusUrl: 'http://localhost:9090' }))).toMatchObject({
      status: 'FAIL',
      detail: expect.stringContaining('PROMETHEUS_URL') as string,
    });
  });
});

describe('check 2: local Docker', () => {
  const run =
    (out: { exitCode?: number; stdout?: string } | Error): RunCommandSimple =>
    () =>
      out instanceof Error
        ? Promise.reject(out)
        : Promise.resolve({ exitCode: out.exitCode ?? 0, stdout: out.stdout ?? '', stderr: 'err' });
  it('passes only for a local endpoint, and fails closed otherwise', async () => {
    expect(
      (await checkDocker(config(), run({ stdout: '"unix:///var/run/docker.sock"\n' }))).status,
    ).toBe('PASS');
    expect(
      (await checkDocker(config(), run({ stdout: '"npipe:////./pipe/docker_engine"' }))).status,
    ).toBe('PASS');
    expect((await checkDocker(config(), run({ stdout: '"tcp://10.0.0.5:2376"' }))).status).toBe(
      'FAIL',
    );
    expect(
      (
        await checkDocker(
          config({ dockerHost: 'tcp://remote:2376' }),
          run({ stdout: '"unix:///x"' }),
        )
      ).status,
    ).toBe('FAIL');
    expect(
      (await checkDocker(config({ dockerHost: 'unix:///x' }), run({ stdout: '"unix:///x"' })))
        .status,
    ).toBe('PASS');
    expect((await checkDocker(config(), run({ stdout: 'not json' }))).status).toBe('INCONCLUSIVE');
    expect((await checkDocker(config(), run({ stdout: '42' }))).status).toBe('INCONCLUSIVE');
    expect((await checkDocker(config(), run({ exitCode: 1 }))).status).toBe('INCONCLUSIVE');
    expect((await checkDocker(config(), run(new Error('ENOENT')))).status).toBe('INCONCLUSIVE');
  });
});

describe('docker compose ps parsing', () => {
  it('accepts an array or one object per line, and rejects anything else', () => {
    const list = containers();
    expect(parseComposePs(JSON.stringify(list))).toHaveLength(5);
    expect(parseComposePs(list.map((c) => JSON.stringify(c)).join('\n'))).toHaveLength(5);
    expect(parseComposePs('')).toEqual([]);
    expect(parseComposePs('{"Service": 1}')).toMatch(/unexpected shape/);
    expect(parseComposePs('[{')).toBe('output is not JSON');
    expect(parseComposePs('not json')).toBe('output is not JSON');
  });
});

describe('checks 3 to 5', () => {
  it('pass only when verified; unverified passes are INCONCLUSIVE, failures stay FAIL', () => {
    const list = containers();
    expect(checkProject(list, config(), VERIFIED).status).toBe('PASS');
    expect(checkMapping(list, config(), VERIFIED).status).toBe('PASS');
    expect(checkLoopback(list, VERIFIED).status).toBe('PASS');
    expect(checkProject(list, config(), UNVERIFIED).status).toBe('INCONCLUSIVE');
    expect(checkMapping(list, config(), UNVERIFIED).status).toBe('INCONCLUSIVE');
    expect(checkLoopback(list, UNVERIFIED).status).toBe('INCONCLUSIVE');
    expect(
      checkLoopback(
        containers({
          worker: {
            Publishers: [
              { URL: '0.0.0.0', TargetPort: 3001, PublishedPort: 3001, Protocol: 'tcp' },
            ],
          },
        }),
        UNVERIFIED,
      ).status,
    ).toBe('FAIL');
  });

  it('check 3 fails on the project name, foreign or duplicate containers, missing services and health', () => {
    const list = containers();
    expect(checkProject(list, config({ composeProjectName: 'other' }), VERIFIED).status).toBe(
      'FAIL',
    );
    expect(
      checkProject(containers({ jaeger: { Project: 'other' } }), config(), VERIFIED).detail,
    ).toMatch(/belongs to project other/);
    expect(
      checkProject([...list, { ...list[0], ID: 'dup' } as ComposeContainer], config(), VERIFIED)
        .detail,
    ).toMatch(/exactly one running orders-api/);
    expect(
      checkProject(
        list.filter((c) => c.Service !== 'prometheus'),
        config(),
        VERIFIED,
      ).detail,
    ).toMatch(/prometheus/);
    expect(
      checkProject(containers({ worker: { State: 'exited' } }), config(), VERIFIED).status,
    ).toBe('FAIL');
    expect(
      checkProject(containers({ 'orders-api': { Health: 'starting' } }), config(), VERIFIED).detail,
    ).toMatch(/not healthy/);
    expect(
      checkProject(list, config({ composeProjectName: 'commerce-platform' }), VERIFIED).status,
    ).toBe('PASS');
  });

  it('check 4 requires exactly one matching publisher of the expected service', () => {
    const pub = (ip: string, port: number) => ({
      URL: ip,
      TargetPort: port,
      PublishedPort: port,
      Protocol: 'tcp',
    });
    expect(
      checkMapping(
        containers({ 'orders-api': { Publishers: [pub('::1', 3000)] } }),
        config(),
        VERIFIED,
      ).status,
    ).toBe('FAIL');
    expect(
      checkMapping(
        containers({ 'orders-api': { Publishers: [pub('::1', 3000)] } }),
        config({ ordersApiUrl: 'http://[::1]:3000' }),
        VERIFIED,
      ).status,
    ).toBe('PASS');
    expect(
      checkMapping(
        containers({ jaeger: { Publishers: [pub('127.0.0.1', 16686), pub('127.0.0.1', 3000)] } }),
        config(),
        VERIFIED,
      ).detail,
    ).toMatch(/found orders-api, jaeger/);
    expect(
      checkMapping(containers({ prometheus: { Publishers: null } }), config(), VERIFIED).detail,
    ).toMatch(/found none/);
    expect(
      checkMapping(containers(), config({ ordersApiUrl: 'http://127.0.0.1' }), VERIFIED).detail,
    ).toMatch(/127\.0\.0\.1:80/);
  });

  it('check 5 fails on any non-loopback publisher, even beside a loopback one, and on none', () => {
    const pub = (ip: string) => ({
      URL: ip,
      TargetPort: 3000,
      PublishedPort: 3000,
      Protocol: 'tcp',
    });
    expect(
      checkLoopback(
        containers({ 'orders-api': { Publishers: [pub('127.0.0.1'), pub('::')] } }),
        VERIFIED,
      ).status,
    ).toBe('FAIL');
    expect(checkLoopback(containers({ worker: { Publishers: [] } }), VERIFIED).detail).toMatch(
      /publishes no port/,
    );
    expect(
      checkLoopback(
        containers({ worker: { Publishers: [{ ...pub('::1'), PublishedPort: 3001 }] } }),
        VERIFIED,
      ).status,
    ).toBe('PASS');
  });
});

describe('compose override and identity checks', () => {
  const run =
    (stdout: string, exitCode = 0): RunCommandSimple =>
    () =>
      Promise.resolve({ exitCode, stdout, stderr: 'boom' });
  const resolved = (apiIp: string | undefined) =>
    JSON.stringify({
      services: {
        'orders-api': { ports: [{ ...(apiIp ? { host_ip: apiIp } : {}), published: '3000' }] },
        worker: { ports: [{ host_ip: '127.0.0.1', published: '3001' }] },
      },
    });
  it('the override check reads the resolved ports and is gated on open item 2', async () => {
    expect((await checkComposeOverride(run(resolved('127.0.0.1')), VERIFIED)).status).toBe('PASS');
    expect((await checkComposeOverride(run(resolved('127.0.0.1')), UNVERIFIED)).status).toBe(
      'INCONCLUSIVE',
    );
    expect((await checkComposeOverride(run(resolved(undefined)), UNVERIFIED)).detail).toMatch(
      /all interfaces/,
    );
    expect(
      (await checkComposeOverride(run(JSON.stringify({ services: { worker: {} } })), VERIFIED))
        .status,
    ).toBe('FAIL');
    expect((await checkComposeOverride(run('x'), VERIFIED)).status).toBe('INCONCLUSIVE');
    expect((await checkComposeOverride(run('{"services": 3}'), VERIFIED)).status).toBe(
      'INCONCLUSIVE',
    );
    expect((await checkComposeOverride(run('', 15), VERIFIED)).status).toBe('INCONCLUSIVE');
    expect(
      (await checkComposeOverride(() => Promise.reject(new Error('ENOENT')), VERIFIED)).status,
    ).toBe('INCONCLUSIVE');
  });

  it('the identity check compares the Prometheus instance with the container ID, gated on open item 3', async () => {
    const prom =
      (instances: string[], status = 200) =>
      () =>
        Promise.resolve(
          Response.json(
            {
              status: 'success',
              data: { result: instances.map((instance) => ({ metric: { instance } })) },
            },
            { status },
          ),
        );
    const list = containers();
    expect(
      (await checkIdentity(list, 'http://127.0.0.1:9090', prom(['a1b2c3d4e5f6']), VERIFIED)).status,
    ).toBe('PASS');
    expect(
      (await checkIdentity(list, 'http://127.0.0.1:9090', prom(['a1b2c3d4e5f6']), UNVERIFIED))
        .status,
    ).toBe('INCONCLUSIVE');
    expect(
      (await checkIdentity(list, 'http://127.0.0.1:9090', prom(['ffffffffffff']), VERIFIED)).status,
    ).toBe('FAIL');
    expect(
      (await checkIdentity(list, 'http://127.0.0.1:9090', prom(['a1b2', 'a1b2c3d4e5f6']), VERIFIED))
        .status,
    ).toBe('FAIL');
    expect(
      (await checkIdentity(list, 'http://127.0.0.1:9090', prom([], 503), VERIFIED)).status,
    ).toBe('INCONCLUSIVE');
    expect(
      (await checkIdentity(list, 'http://x', () => Promise.reject(new Error('down')), VERIFIED))
        .status,
    ).toBe('INCONCLUSIVE');
    expect((await checkIdentity([], 'http://x', prom([]), VERIFIED)).status).toBe('FAIL');
  });
});

describe('runIsolationChecks', () => {
  const runner =
    (ps: { stdout?: string; exitCode?: number } | Error): RunCommandSimple =>
    (command, args) => {
      if (args[0] === 'context')
        return Promise.resolve({
          exitCode: 0,
          stdout: '"unix:///var/run/docker.sock"',
          stderr: '',
        });
      if (ps instanceof Error) return Promise.reject(ps);
      return Promise.resolve({
        exitCode: ps.exitCode ?? 0,
        stdout: ps.stdout ?? '',
        stderr: 'bad',
      });
    };
  const prom = () =>
    Promise.resolve(
      Response.json({
        status: 'success',
        data: { result: [{ metric: { instance: 'a1b2c3d4e5f6' } }] },
      }),
    );

  it('all pass when verified, and stop early when the URLs are wrong', async () => {
    const ok = await runIsolationChecks({
      config: config(),
      run: runner({ stdout: JSON.stringify(containers()) }),
      fetch: prom,
      verification: VERIFIED,
    });
    expect(ok.checks.map((c) => `${c.name}:${c.status}`)).toEqual([
      'url-form:PASS',
      'local-docker:PASS',
      'compose-project:PASS',
      'url-mapping:PASS',
      'fault-controls-loopback:PASS',
      'container-identity:PASS',
    ]);
    const blocked = await runIsolationChecks({
      config: config(),
      run: runner({ stdout: JSON.stringify(containers()) }),
      fetch: prom,
      verification: UNVERIFIED,
    });
    expect(blocked.checks.filter((c) => c.status === 'INCONCLUSIVE').map((c) => c.name)).toEqual([
      'compose-project',
      'url-mapping',
      'fault-controls-loopback',
      'container-identity',
    ]);
    const wrong = await runIsolationChecks({
      config: config({ ordersApiUrl: 'http://localhost:3000' }),
      run: runner(new Error('unused')),
      fetch: prom,
      verification: VERIFIED,
    });
    expect(wrong.checks).toHaveLength(1);
  });

  it('a missing or unparseable ps output makes checks 3 to 5 and identity INCONCLUSIVE', async () => {
    for (const ps of [new Error('ENOENT'), { exitCode: 1 }, { stdout: 'garbage' }]) {
      const res = await runIsolationChecks({
        config: config(),
        run: runner(ps),
        fetch: prom,
        verification: VERIFIED,
      });
      expect(res.checks.slice(2).every((c) => c.status === 'INCONCLUSIVE')).toBe(true);
      expect(res.checks).toHaveLength(6);
    }
  });
});
