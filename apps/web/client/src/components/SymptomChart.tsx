import type { IncidentTelemetry } from '../api';

type Symptom = NonNullable<IncidentTelemetry['symptom']>;

/**
 * The captured primary-symptom series as an SVG step chart, with the trigger, stop and detection
 * marked. The values are the samples in the bundle's metrics.jsonl, summed across series.
 */
export function SymptomChart({ symptom }: { symptom: Symptom }) {
  const points = new Map<number, number>();
  for (const s of symptom.series)
    for (const [t, v] of s.samples) points.set(t, (points.get(t) ?? 0) + v);
  const data = [...points.entries()].sort((a, b) => a[0] - b[0]);
  if (data.length === 0) {
    return (
      <p className="text-sm text-slate-500 dark:text-slate-400">
        The bundle holds no samples for this series.
      </p>
    );
  }
  const W = 640;
  const H = 180;
  const P = 28;
  // Room on the left for the maximum value's label, which would otherwise be cut off.
  const PL = 48;
  const t0 = data[0]?.[0] ?? 0;
  const t1 = data[data.length - 1]?.[0] ?? t0 + 1;
  const maxV = Math.max(1, ...data.map(([, v]) => v));
  const x = (t: number) => PL + ((t - t0) / Math.max(1, t1 - t0)) * (W - PL - P);
  const y = (v: number) => H - P - (v / maxV) * (H - 2 * P);
  const path = data
    .map(([t, v], i) => `${i === 0 ? 'M' : 'L'}${x(t).toFixed(1)},${y(v).toFixed(1)}`)
    .join(' ');
  // Labels sit on two rows so that markers close in time, such as the start of a fault and its
  // detection seconds later, do not print over each other.
  const marker = (iso: string | null, label: string, color: string, row: 0 | 1) => {
    if (!iso) return null;
    const t = new Date(iso).getTime() / 1000;
    if (t < t0 || t > t1) return null;
    return (
      <g key={label}>
        <line x1={x(t)} x2={x(t)} y1={P / 2} y2={H - P} stroke={color} strokeDasharray="4 3" />
        <text x={x(t) + 4} y={P / 2 + 10 + row * 13} fontSize="11" fill={color}>
          {label}
        </text>
      </g>
    );
  };
  return (
    <figure>
      <svg
        viewBox={`0 0 ${String(W)} ${String(H)}`}
        role="img"
        aria-label={`${symptom.metric} over the capture window`}
        className="w-full"
      >
        <line
          x1={PL}
          x2={W - P}
          y1={H - P}
          y2={H - P}
          className="stroke-slate-300 dark:stroke-slate-700"
        />
        <text x={PL} y={H - 8} fontSize="11" className="fill-slate-500">
          {new Date(t0 * 1000).toISOString().slice(11, 19)}
        </text>
        <text x={W - P} y={H - 8} fontSize="11" textAnchor="end" className="fill-slate-500">
          {new Date(t1 * 1000).toISOString().slice(11, 19)}
        </text>
        <text x={PL - 4} y={y(maxV) + 4} fontSize="11" textAnchor="end" className="fill-slate-500">
          {maxV}
        </text>
        <path d={path} fill="none" strokeWidth="2" className="stroke-indigo-500" />
        {marker(symptom.triggerStartedAt, 'fault start', '#d97706', 0)}
        {marker(symptom.triggerStoppedAt, 'fault stop', '#64748b', 0)}
        {marker(symptom.detectedAt, 'detected', '#059669', 1)}
      </svg>
      <figcaption className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {symptom.series.length} series · {data.length} samples · max value {maxV}
      </figcaption>
    </figure>
  );
}
