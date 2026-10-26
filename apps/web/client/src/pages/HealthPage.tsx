import { api, type HealthReport } from '../api';
import { Badge, Card, ErrorState, LoadingState, Mono, type Tone } from '../components/ui';
import { formatMs, formatTime } from '../format';
import { useApi } from '../useApi';

const POLL_MS = 10_000;
const TONE: Record<HealthReport['components'][number]['status'], Tone> = {
  up: 'ok',
  down: 'bad',
  unreachable: 'warn',
};
const LABEL: Record<HealthReport['components'][number]['name'], string> = {
  'orders-api': 'Orders API',
  worker: 'Worker',
  prometheus: 'Prometheus',
  jaeger: 'Jaeger',
};

/** Live readiness, read by the dashboard server from each component's own endpoint every 10 s. */
export function HealthPage() {
  const state = useApi((signal) => api.health(signal), [], { pollMs: POLL_MS });
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">System health</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            Each component's own readiness endpoint, checked live by the dashboard server every 10
            seconds.
          </p>
        </div>
        <button
          type="button"
          onClick={state.reload}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {state.refreshing ? 'Checking…' : 'Check now'}
        </button>
      </header>
      {state.status === 'loading' && <LoadingState label="Checking components" />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={state.reload} />}
      {state.status === 'success' && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="Components">
            {state.data.components.map((c) => (
              <Card key={c.name}>
                <div className="flex items-center justify-between">
                  <h2 className="font-medium">{LABEL[c.name]}</h2>
                  <Badge tone={TONE[c.status]}>{c.status}</Badge>
                </div>
                <p className="mt-2 text-sm text-slate-500">
                  {c.detail}
                  {c.latencyMs !== null && ` · ${formatMs(c.latencyMs)}`}
                </p>
                <p className="mt-1 text-xs text-slate-400">
                  <Mono>{c.url}</Mono>
                </p>
              </Card>
            ))}
          </div>
          <Card title="Fault controls">
            <p className="text-sm">
              {state.data.faults.controls === 'enabled' && (
                <>
                  Enabled · active scenario:{' '}
                  <Mono>{state.data.faults.activeScenario ?? 'none'}</Mono>
                </>
              )}
              {state.data.faults.controls === 'disabled' && 'Disabled (FAULTS_ENABLED is not set).'}
              {state.data.faults.controls === 'unknown' &&
                'Unknown: the orders API did not report scenario state.'}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Read-only. The dashboard cannot start or stop scenarios.
            </p>
          </Card>
          <p className="text-xs text-slate-500">Last checked {formatTime(state.data.checkedAt)}</p>
        </>
      )}
    </div>
  );
}
