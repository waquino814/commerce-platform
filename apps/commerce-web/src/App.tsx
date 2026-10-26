import { BagIcon, ReceiptIcon } from './components/icons';
import { BUTTON, EmptyState } from './components/ui';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { OrdersPage } from './pages/OrdersPage';
import { PlaceOrderPage } from './pages/PlaceOrderPage';
import { Link, matchRoute, usePath, type Route } from './router';

const NAV: {
  href: string;
  label: string;
  icon: typeof BagIcon;
  active: (r: Route['name']) => boolean;
}[] = [
  { href: '/', label: 'Place order', icon: BagIcon, active: (r) => r === 'place' },
  {
    href: '/orders',
    label: 'Order history',
    icon: ReceiptIcon,
    active: (r) => r === 'orders' || r === 'order',
  },
];

function Logo() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className="h-8 w-8">
      <rect width="32" height="32" rx="9" className="fill-brand-600" />
      <path
        d="M9 12.5h14l-1.2 10H10.2L9 12.5Z"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M12.5 12.5v-1a3.5 3.5 0 0 1 7 0v1"
        fill="none"
        stroke="white"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function App() {
  const route = matchRoute(usePath());
  return (
    <div className="min-h-screen bg-[radial-gradient(60rem_30rem_at_50%_-10rem,var(--color-brand-100),transparent)] dark:bg-[radial-gradient(60rem_30rem_at_50%_-10rem,color-mix(in_oklch,var(--color-brand-900)_45%,transparent),transparent)]">
      <a
        href="#main"
        className="sr-only rounded-lg bg-white px-3 py-2 font-medium shadow-lift focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 dark:bg-stone-900"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-30 border-b border-stone-200/70 bg-white/75 backdrop-blur-md dark:border-stone-800/70 dark:bg-stone-950/70">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2.5 rounded-lg"
            aria-label="Commerce Platform, home"
          >
            <Logo />
            <span className="hidden leading-tight min-[480px]:block">
              <span className="block font-semibold tracking-tight">Commerce Platform</span>
              <span className="hidden text-xs text-stone-500 sm:block dark:text-stone-400">
                Local storefront
              </span>
            </span>
          </Link>
          <nav
            aria-label="Main"
            className="flex gap-1 rounded-xl bg-stone-100/80 p-1 dark:bg-stone-900"
          >
            {NAV.map((n) => {
              const active = n.active(route.name);
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-brand-500 ${active ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-800 dark:text-white' : 'text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-white'}`}
                >
                  <Icon className="hidden sm:block" />
                  {n.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        {route.name === 'place' && <PlaceOrderPage />}
        {route.name === 'orders' && <OrdersPage />}
        {route.name === 'order' && <OrderDetailPage key={route.id} id={route.id} />}
        {route.name === 'not_found' && (
          <EmptyState title="Page not found">
            <Link href="/" className={BUTTON.link}>
              Back to the storefront
            </Link>
          </EmptyState>
        )}
      </main>
      <footer className="mx-auto max-w-6xl px-4 pb-10 text-xs text-stone-500 sm:px-6 dark:text-stone-400">
        Connected to the local orders API. Payments use the built-in simulator; no real charges are
        made.
      </footer>
    </div>
  );
}
