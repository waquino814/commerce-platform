// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { navigate } from '../src/router';
import { detail, health, ID, stubFetch, summary, telemetry } from './support';

const at = (path: string) => {
  window.history.replaceState(null, '', path);
  return render(<App />);
};

describe('incident overview', () => {
  it('shows a loading state, then each run with detection and validation', async () => {
    stubFetch(() => ({
      body: {
        directoryExists: true,
        incidents: [
          summary(),
          summary({
            bundleId: 'poison-order-42-20261025T175901Z',
            detection: { status: 'not_detected', latencyMs: null, deadlineSeconds: 120 },
            validation: { valid: false, errorCount: 2 },
            complete: false,
          }),
          summary({
            bundleId: 'x-42-20261025T000000Z',
            scenario: null,
            detection: { status: 'unknown', latencyMs: null, deadlineSeconds: null },
            complete: false,
          }),
        ],
        failed: [
          {
            directory: 'provider-outage-42-x',
            bundleId: null,
            stage: 'capture-traces',
            category: 'timeout',
            occurredAt: null,
            files: [],
          },
        ],
      },
    }));
    at('/');
    expect(screen.getByRole('status').textContent).toContain('Loading incident runs');
    const list = await screen.findByRole('list', { name: 'Incident runs' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain('detected · 65.0 s');
    expect(rows[0]?.textContent).toContain('valid · complete');
    expect(rows[1]?.textContent).toContain('not detected');
    expect(rows[1]?.textContent).toContain('invalid · 2 error(s)');
    expect(rows[2]?.textContent).toContain('unknown scenario');
    expect(rows[2]?.textContent).toContain('valid · incomplete');
    expect(within(list).getAllByRole('link')[0]?.getAttribute('href')).toBe(`/incidents/${ID}`);
    expect(screen.getByRole('list', { name: 'Failed evidence' }).textContent).toContain(
      'provider-outage-42-x · capture-traces · timeout',
    );
  });

  it('flags a detection later than the deadline', async () => {
    stubFetch(() => ({
      body: {
        directoryExists: true,
        incidents: [
          summary({ detection: { status: 'detected', latencyMs: 130_000, deadlineSeconds: 120 } }),
        ],
        failed: [],
      },
    }));
    at('/');
    expect((await screen.findByText('detected · 130.0 s')).className).toContain('bg-amber-50');
  });

  it('distinguishes a missing directory from an empty one', async () => {
    stubFetch(() => ({ body: { directoryExists: false, incidents: [], failed: [] } }));
    at('/');
    expect(await screen.findByText('No incidents directory yet')).toBeTruthy();
    stubFetch(() => ({ body: { directoryExists: true, incidents: [], failed: [] } }));
    at('/');
    expect(await screen.findByText('No incident bundles yet')).toBeTruthy();
  });

  it('shows the server error and retries', async () => {
    let fail = true;
    const calls = stubFetch(() =>
      fail
        ? {
            status: 500,
            body: { error: 'internal_error', message: 'The incident evidence could not be read.' },
          }
        : { body: { directoryExists: true, incidents: [], failed: [] } },
    );
    at('/');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The incident evidence could not be read.',
    );
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No incident bundles yet')).toBeTruthy();
    expect(calls).toEqual(['/api/incidents', '/api/incidents']);
  });

  it('reports an unreachable server, and a non-JSON error body', async () => {
    stubFetch(() => new TypeError('fetch failed'));
    at('/');
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The dashboard server could not be reached.',
    );
    stubFetch(() => ({ status: 502 }));
    at('/');
    expect(await screen.findByText('The server answered 502.')).toBeTruthy();
  });
});

describe('incident detail', () => {
  it('shows ground truth, the condition, the symptom chart, traces, logs, validation and evidence files', async () => {
    const calls = stubFetch((path) => ({
      body: path.endsWith('/telemetry') ? telemetry() : detail(),
    }));
    at(`/incidents/${ID}`);
    expect((await screen.findByRole('heading', { level: 1 })).textContent).toContain(
      'poison-order seed 42',
    );
    expect(calls.sort()).toEqual([`/api/incidents/${ID}`, `/api/incidents/${ID}/telemetry`]);
    expect(screen.getByText('A poison order crashes processing.')).toBeTruthy();
    expect(screen.getByText('Quarantine the order.')).toBeTruthy();
    expect(
      screen.getByText(
        'sum(increase(commerce_claims_recovered_total{job="worker", order_status="pending"}[60s])) > 0',
      ),
    ).toBeTruthy();
    const chart = await screen.findByRole('img', {
      name: 'commerce_claims_recovered_total over the capture window',
    });
    expect(chart.textContent).toContain('fault start');
    expect(chart.textContent).toContain('detected');
    expect(screen.getByText(/1 series · 4 samples · max value 3/)).toBeTruthy();
    const traces = screen.getByRole('list', { name: 'Sample traces' });
    expect(traces.textContent).toContain('order.process');
    expect(within(traces).getByRole('link').getAttribute('href')).toBe(
      `http://127.0.0.1:16686/trace/${'a'.repeat(32)}`,
    );
    expect(screen.getByText('error: 5')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Sample errors' }).textContent).toContain(
      'worker: processing failed',
    );
    expect(screen.getByText('The bundle passes the M5b validator.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'manifest.json' }).getAttribute('href')).toBe(
      `/api/incidents/${ID}/files/manifest.json`,
    );
    expect(screen.queryByRole('link', { name: 'logs.jsonl' })).toBeNull();
    expect(screen.getByText('missing')).toBeTruthy();
  });

  it('lists validator errors, an unconfirmed stop and a dirty producer, and handles empty telemetry', async () => {
    stubFetch((path) => ({
      body: path.endsWith('/telemetry')
        ? telemetry({
            symptom: null,
            traces: { total: 0, samples: [] },
            logs: { total: 0, byLevel: {}, byService: {}, sampleErrors: [] },
          })
        : detail({
            validationErrors: [
              { file: 'metrics.jsonl', field: 'line 1', message: 'malformed JSON' },
            ],
            trigger: {
              startedAt: '2026-10-26T01:55:30.000Z',
              stoppedAt: null,
              requestedDurationMs: 90_000,
            },
            producer: { commit: null, dirty: true },
            detection: { status: 'not_detected', latencyMs: null, deadlineSeconds: 120 },
          }),
    }));
    at(`/incidents/${ID}`);
    expect(await screen.findByText('metrics.jsonl: line 1: malformed JSON')).toBeTruthy();
    expect(screen.getByText(/stop not confirmed/)).toBeTruthy();
    expect(screen.getByText('built from uncommitted changes')).toBeTruthy();
    expect(await screen.findByText('The bundle has no readable symptom series.')).toBeTruthy();
    expect(screen.getByText('No traces in the bundle.')).toBeTruthy();
  });

  it('says so when the series has no samples or the bundle has no primary symptom', async () => {
    const empty = telemetry();
    if (empty.symptom) empty.symptom.series = [{ labels: {}, samples: [] }];
    stubFetch((path) => ({ body: path.endsWith('/telemetry') ? empty : detail() }));
    at(`/incidents/${ID}`);
    expect(await screen.findByText('The bundle holds no samples for this series.')).toBeTruthy();
    const d = detail();
    d.groundTruth.primarySymptom = null;
    stubFetch((path) => ({ body: path.endsWith('/telemetry') ? telemetry() : d }));
    at(`/incidents/${ID}`);
    expect(await screen.findByText('No readable primary symptom.')).toBeTruthy();
  });

  it('shows the 404 for an unknown bundle and a telemetry error separately', async () => {
    stubFetch(() => ({
      status: 404,
      body: { error: 'incident_not_found', message: 'no incident bundle nope' },
    }));
    at('/incidents/nope');
    expect(await screen.findByText('no incident bundle nope')).toBeTruthy();
    stubFetch((path) =>
      path.endsWith('/telemetry')
        ? { status: 500, body: { error: 'internal_error', message: 'telemetry broke' } }
        : { body: detail() },
    );
    at(`/incidents/${ID}`);
    expect(await screen.findByText('telemetry broke')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });
});

describe('system health', () => {
  it('shows each component status, the fault controls and when it was checked', async () => {
    stubFetch(() => ({ body: health() }));
    at('/health');
    const cards = await screen.findByLabelText('Components');
    expect(cards.textContent).toContain('Orders API');
    expect(within(cards).getAllByText('up')).toHaveLength(2);
    expect(within(cards).getByText('down').className).toContain('bg-rose-50');
    expect(within(cards).getByText('unreachable').className).toContain('bg-amber-50');
    expect(cards.textContent).toContain('timed out');
    expect(screen.getByText('Disabled (FAULTS_ENABLED is not set).')).toBeTruthy();
    expect(screen.getByText('Last checked 2026-10-26 03:00:00 UTC')).toBeTruthy();
  });

  it('shows an active scenario or unknown fault state', async () => {
    stubFetch(() => ({
      body: health({ faults: { controls: 'enabled', activeScenario: 'poison-order' } }),
    }));
    at('/health');
    expect(await screen.findByText('poison-order')).toBeTruthy();
    stubFetch(() => ({ body: health({ faults: { controls: 'unknown', activeScenario: null } }) }));
    at('/health');
    expect(await screen.findByText(/Unknown: the orders API/)).toBeTruthy();
  });

  it('polls every 10 seconds and checks on demand', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const calls = stubFetch(() => ({ body: health() }));
    at('/health');
    await screen.findByLabelText('Components');
    expect(calls).toHaveLength(1);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    fireEvent.click(screen.getByRole('button', { name: /Check now|Checking/ }));
    await waitFor(() => {
      expect(calls).toHaveLength(3);
    });
  });
});

describe('navigation', () => {
  it('routes with history, marks the active tab, and shows not found', async () => {
    stubFetch((path) => ({
      body:
        path === '/api/health' ? health() : { directoryExists: true, incidents: [], failed: [] },
    }));
    at('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Incidents' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(within(nav).getByRole('link', { name: 'System health' }));
    expect(window.location.pathname).toBe('/health');
    expect(await screen.findByRole('heading', { name: 'System health' })).toBeTruthy();
    // Modified clicks are left to the browser (open in a new tab).
    // jsdom cannot open a new tab; stop it after the router has declined the click.
    const block = (e: Event) => {
      e.preventDefault();
    };
    document.addEventListener('click', block);
    fireEvent.click(within(nav).getByRole('link', { name: 'Incidents' }), { metaKey: true });
    expect(window.location.pathname).toBe('/health');
    document.removeEventListener('click', block);
    act(() => {
      navigate('/nowhere');
    });
    expect(screen.getByText('Page not found')).toBeTruthy();
    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/health');
    });
  });
});
