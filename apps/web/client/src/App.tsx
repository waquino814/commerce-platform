import { HealthPage } from './pages/HealthPage';
import { IncidentDetailPage } from './pages/IncidentDetailPage';
import { IncidentsPage } from './pages/IncidentsPage';
import { EmptyState } from './components/ui';
import { Link, matchRoute, usePath } from './router';

const NAV = [
  { href: '/', label: 'Incidents', active: (r: string) => r === 'incidents' || r === 'incident' },
  { href: '/health', label: 'System health', active: (r: string) => r === 'health' },
];

export function App() {
  const route = matchRoute(usePath());
  return (
    <div className="min-h-screen">
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="font-semibold tracking-tight">
            Commerce Platform <span className="font-normal text-slate-500">· incidents</span>
          </Link>
          <nav className="flex gap-1" aria-label="Main">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.active(route.name) ? 'page' : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${n.active(route.name) ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        {route.name === 'incidents' && <IncidentsPage />}
        {route.name === 'incident' && <IncidentDetailPage id={route.id} />}
        {route.name === 'health' && <HealthPage />}
        {route.name === 'not_found' && (
          <EmptyState title="Page not found">
            <Link href="/" className="text-indigo-600 hover:underline">
              Back to incident runs
            </Link>
          </EmptyState>
        )}
      </main>
    </div>
  );
}
