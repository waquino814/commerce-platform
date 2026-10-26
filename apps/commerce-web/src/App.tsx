import { EmptyState } from './components/ui';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { PlaceOrderPage } from './pages/PlaceOrderPage';
import { Link, matchRoute, usePath, type Route } from './router';

const NAV: { href: string; label: string; active: (r: Route['name']) => boolean }[] = [
  { href: '/', label: 'Place order', active: (r) => r === 'place' },
  { href: '/orders', label: 'Order history', active: (r) => r === 'orders' || r === 'order' },
];

export function App() {
  const route = matchRoute(usePath());
  return (
    <div className="min-h-screen">
      <a
        href="#main"
        className="sr-only rounded bg-white px-3 py-2 focus:not-sr-only focus:absolute focus:left-3 focus:top-3 dark:bg-stone-900"
      >
        Skip to content
      </a>
      <header className="border-b border-stone-200 bg-white/80 backdrop-blur dark:border-stone-800 dark:bg-stone-900/80">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href="/" className="font-semibold tracking-tight">
            Commerce Platform
          </Link>
          <nav aria-label="Main" className="flex gap-1">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                aria-current={n.active(route.name) ? 'page' : undefined}
                className={`rounded-lg px-3 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-indigo-500 ${n.active(route.name) ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : 'hover:bg-stone-100 dark:hover:bg-stone-800'}`}
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-4 py-8">
        {route.name === 'place' && <PlaceOrderPage />}
        {route.name === 'orders' && <OrdersPage />}
        {route.name === 'order' && <OrderDetailPage key={route.id} id={route.id} />}
        {route.name === 'not_found' && (
          <EmptyState title="Page not found">
            <Link
              href="/"
              className="text-indigo-700 underline-offset-2 hover:underline dark:text-indigo-400"
            >
              Place an order
            </Link>
          </EmptyState>
        )}
      </main>
    </div>
  );
}
