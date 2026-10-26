import { api, type IncidentDetailResponse, type IncidentTelemetry } from '../api';
import { SymptomChart } from '../components/SymptomChart';
import { Badge, Card, ErrorState, LoadingState, Mono } from '../components/ui';
import { formatBytes, formatMs, formatTime, renderCondition } from '../format';
import { Link } from '../router';
import { useApi } from '../useApi';
import { DetectionBadge, ValidationBadge } from './IncidentsPage';

export function IncidentDetailPage({ id }: { id: string }) {
  const detail = useApi((signal) => api.incident(id, signal), [id]);
  const telemetry = useApi((signal) => api.telemetry(id, signal), [id]);
  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-indigo-600 hover:underline dark:text-indigo-400">
        ← All incident runs
      </Link>
      {detail.status === 'loading' && <LoadingState label="Loading incident" />}
      {detail.status === 'error' && <ErrorState error={detail.error} onRetry={detail.reload} />}
      {detail.status === 'success' && <Detail d={detail.data} telemetry={telemetry} />}
    </div>
  );
}

function Detail({
  d,
  telemetry,
}: {
  d: IncidentDetailResponse;
  telemetry: ReturnType<typeof useApi<IncidentTelemetry>>;
}) {
  const gt = d.groundTruth;
  return (
    <>
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          {d.scenario ?? 'unknown scenario'}{' '}
          <span className="text-base font-normal text-slate-500">seed {d.seed ?? '—'}</span>
        </h1>
        <p className="text-xs text-slate-500">
          <Mono>{d.bundleId}</Mono>
        </p>
        <div className="flex flex-wrap gap-2">
          <DetectionBadge detection={d.detection} />
          <ValidationBadge summary={d} />
          {d.producer.dirty && <Badge tone="warn">built from uncommitted changes</Badge>}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Run">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-slate-500">Fault</dt>
            <dd>
              {formatTime(d.trigger.startedAt)} →{' '}
              {d.trigger.stoppedAt ? formatTime(d.trigger.stoppedAt) : 'stop not confirmed'}
            </dd>
            <dt className="text-slate-500">Detection</dt>
            <dd>
              {d.detection.status === 'detected'
                ? formatMs(d.detection.latencyMs)
                : d.detection.status.replace('_', ' ')}
              {d.detection.deadlineSeconds !== null && (
                <span className="text-slate-500"> · deadline {d.detection.deadlineSeconds} s</span>
              )}
            </dd>
            <dt className="text-slate-500">Load</dt>
            <dd>
              {formatTime(d.window?.loadStartedAt)} → {formatTime(d.window?.loadEndedAt)}
            </dd>
            <dt className="text-slate-500">Producer</dt>
            <dd>
              <Mono>{d.producer.commit ?? '—'}</Mono>
            </dd>
            <dt className="text-slate-500">Traces</dt>
            <dd>
              {d.traces
                .map((t) => `${t.service}: ${String(t.traces)}${t.truncated ? ' (truncated)' : ''}`)
                .join(' · ') || '—'}
            </dd>
          </dl>
        </Card>

        <Card title="Ground truth">
          <p className="text-sm">{gt.description ?? '—'}</p>
          {gt.rootCause && (
            <p className="mt-2 text-sm">
              <span className="text-slate-500">Root cause:</span>{' '}
              <Mono>{gt.rootCause.component}</Mono>: {gt.rootCause.summary}
            </p>
          )}
          <p className="mt-2 flex flex-wrap gap-1 text-sm">
            <span className="text-slate-500">Affected:</span>
            {gt.affectedComponents.map((c) => (
              <Badge key={c} tone="neutral">
                {c}
              </Badge>
            ))}
          </p>
          {gt.expectedRemediation.length > 0 && (
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
              {gt.expectedRemediation.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ol>
          )}
        </Card>
      </div>

      <Card title="Primary symptom">
        {gt.primarySymptom ? (
          <>
            <p className="text-sm">{gt.primarySymptom.description}</p>
            <p className="mt-1 text-xs text-slate-500">
              <Mono>{renderCondition(gt.primarySymptom)}</Mono>
            </p>
            <div className="mt-4">
              {telemetry.status === 'loading' && <LoadingState label="Loading telemetry" />}
              {telemetry.status === 'error' && (
                <ErrorState error={telemetry.error} onRetry={telemetry.reload} />
              )}
              {telemetry.status === 'success' &&
                (telemetry.data.symptom ? (
                  <SymptomChart symptom={telemetry.data.symptom} />
                ) : (
                  <p className="text-sm text-slate-500">
                    The bundle has no readable symptom series.
                  </p>
                ))}
            </div>
          </>
        ) : (
          <p className="text-sm text-slate-500">No readable primary symptom.</p>
        )}
      </Card>

      {telemetry.status === 'success' && (
        <div className="grid gap-6 lg:grid-cols-2">
          <TracesCard telemetry={telemetry.data} jaegerUrl={d.jaegerUrl} />
          <LogsCard telemetry={telemetry.data} />
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Validation">
          {d.validationErrors.length === 0 ? (
            <p className="text-sm text-emerald-700 dark:text-emerald-400">
              The bundle passes the M5b validator.
            </p>
          ) : (
            <ul className="space-y-1 text-sm text-rose-700 dark:text-rose-300">
              {d.validationErrors.map((e, i) => (
                <li key={i}>
                  <Mono>
                    {e.file}
                    {e.field ? `: ${e.field}` : ''}: {e.message}
                  </Mono>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Evidence files">
          <ul className="space-y-1 text-sm">
            {d.files.map((f) => (
              <li key={f.name} className="flex justify-between gap-3">
                {f.bytes === null ? (
                  <Mono>{f.name}</Mono>
                ) : (
                  <a
                    href={api.fileUrl(d.bundleId, f.name)}
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                  >
                    <Mono>{f.name}</Mono>
                  </a>
                )}
                <span className={f.bytes === null ? 'text-rose-600' : 'text-slate-500'}>
                  {formatBytes(f.bytes)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

function TracesCard({ telemetry, jaegerUrl }: { telemetry: IncidentTelemetry; jaegerUrl: string }) {
  const { total, samples } = telemetry.traces;
  return (
    <Card title={`Traces · ${String(total)} in the bundle`}>
      {samples.length === 0 ? (
        <p className="text-sm text-slate-500">No traces in the bundle.</p>
      ) : (
        <>
          <ul
            className="divide-y divide-slate-200 text-sm dark:divide-slate-800"
            aria-label="Sample traces"
          >
            {samples.map((t) => (
              <li
                key={t.traceId}
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="min-w-0">
                  {t.error && (
                    <>
                      <Badge tone="bad">error</Badge>{' '}
                    </>
                  )}
                  {t.rootName}
                  <span className="block text-xs text-slate-500">
                    {t.services.join(', ')} · {t.spanCount} spans · {formatMs(t.durationMs)}
                  </span>
                </span>
                <a
                  href={`${jaegerUrl}/trace/${t.traceId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  Jaeger ↗
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Errors first, then the earliest. Jaeger keeps traces in memory, so a link may no longer
            resolve; the full traces are in traces.jsonl.
          </p>
        </>
      )}
    </Card>
  );
}

function LogsCard({ telemetry }: { telemetry: IncidentTelemetry }) {
  const { total, byLevel, byService, sampleErrors } = telemetry.logs;
  return (
    <Card title={`Logs · ${String(total)} records`}>
      <div className="flex flex-wrap gap-2 text-sm">
        {Object.entries(byLevel)
          .sort()
          .map(([level, n]) => (
            <Badge
              key={level}
              tone={
                level === 'error' || level === 'fatal'
                  ? 'bad'
                  : level === 'warn'
                    ? 'warn'
                    : 'neutral'
              }
            >
              {level}: {n}
            </Badge>
          ))}
      </div>
      <p className="mt-2 text-xs text-slate-500">
        {Object.entries(byService)
          .map(([s, n]) => `${s}: ${String(n)}`)
          .join(' · ')}
      </p>
      {sampleErrors.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs" aria-label="Sample errors">
          {sampleErrors.map((e, i) => (
            <li key={i}>
              <span className="text-slate-500">{formatTime(e.time)}</span> {e.service}: {e.message}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
