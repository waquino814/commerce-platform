import { api, type IncidentList } from '../api';
import { Badge, Card, EmptyState, ErrorState, LoadingState, Mono } from '../components/ui';
import { formatMs, formatTime } from '../format';
import { Link } from '../router';
import { useApi } from '../useApi';

type Summary = IncidentList['incidents'][number];

export function DetectionBadge({ detection }: { detection: Summary['detection'] }) {
  if (detection.status === 'detected') {
    const late =
      detection.deadlineSeconds !== null &&
      (detection.latencyMs ?? 0) > detection.deadlineSeconds * 1000;
    return <Badge tone={late ? 'warn' : 'ok'}>detected · {formatMs(detection.latencyMs)}</Badge>;
  }
  if (detection.status === 'not_detected') return <Badge tone="bad">not detected</Badge>;
  return <Badge tone="warn">unknown</Badge>;
}

export function ValidationBadge({
  summary,
}: {
  summary: Pick<Summary, 'validation' | 'complete'>;
}) {
  if (!summary.validation.valid)
    return <Badge tone="bad">invalid · {summary.validation.errorCount} error(s)</Badge>;
  return summary.complete ? (
    <Badge tone="ok">valid · complete</Badge>
  ) : (
    <Badge tone="warn">valid · incomplete</Badge>
  );
}

export function IncidentsPage() {
  const state = useApi((signal) => api.incidents(signal), []);
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Incident runs</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Bundles written by <Mono>pnpm incident run</Mono>, read from the local incidents
          directory. This dashboard never starts a run.
        </p>
      </header>
      {state.status === 'loading' && <LoadingState label="Loading incident runs" />}
      {state.status === 'error' && <ErrorState error={state.error} onRetry={state.reload} />}
      {state.status === 'success' && <IncidentTable list={state.data} />}
    </div>
  );
}

function IncidentTable({ list }: { list: IncidentList }) {
  if (!list.directoryExists) {
    return (
      <EmptyState title="No incidents directory yet">
        Bundles appear here after an approved incident run writes them.
      </EmptyState>
    );
  }
  return (
    <>
      {list.incidents.length === 0 ? (
        <EmptyState title="No incident bundles yet">
          The incidents directory exists but holds no bundle.
        </EmptyState>
      ) : (
        <Card>
          <ul
            className="divide-y divide-slate-200 dark:divide-slate-800"
            aria-label="Incident runs"
          >
            {list.incidents.map((s) => (
              <li
                key={s.bundleId}
                className="grid gap-2 py-3 md:grid-cols-[1.5fr_1fr_1fr_1fr] md:items-center"
              >
                <div>
                  <Link
                    href={`/incidents/${encodeURIComponent(s.bundleId)}`}
                    className="font-medium text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    {s.scenario ?? 'unknown scenario'}
                  </Link>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    seed {s.seed ?? '—'} · <Mono>{s.bundleId}</Mono>
                  </div>
                </div>
                <div>
                  <DetectionBadge detection={s.detection} />
                </div>
                <div>
                  <ValidationBadge summary={s} />
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {formatTime(s.createdAt)}
                </div>
                <p className="text-sm text-slate-600 md:col-span-4 dark:text-slate-300">
                  <span className="text-slate-400">Primary symptom:</span>{' '}
                  {s.primarySymptom.description ?? '—'}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {list.failed.length > 0 && (
        <Card title="Failed evidence">
          <p className="mb-2 text-sm text-slate-500 dark:text-slate-400">
            Partial evidence from runs that could not produce a valid bundle. These are not bundles.
          </p>
          <ul className="space-y-1 text-sm" aria-label="Failed evidence">
            {list.failed.map((f) => (
              <li key={f.directory}>
                <Mono>{f.directory}</Mono> · {f.stage ?? '—'} · {f.category ?? '—'} ·{' '}
                {formatTime(f.occurredAt)}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
