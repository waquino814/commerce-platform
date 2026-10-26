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
  { href: '/', label: 'Shop', icon: BagIcon, active: (r) => r === 'place' },
  {
    href: '/orders',
    label: 'Your Orders',
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
      <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-white/85 backdrop-blur-md dark:border-stone-800/80 dark:bg-stone-950/80">
        <div className="mx-auto flex h-16 max-w-6xl items-stretch justify-between gap-3 px-4 sm:px-6">
          <Link
            href="/"
            className="flex items-center gap-2.5 self-center rounded-lg"
            aria-label="Commerce Platform, home"
          >
            <Logo />
            <span className="hidden leading-tight min-[480px]:block">
              <span className="block text-[0.95rem] font-semibold tracking-tight">
                Commerce Platform
              </span>
              <span className="hidden text-xs text-stone-500 sm:block dark:text-stone-400">
                Local storefront
              </span>
            </span>
          </Link>
          <nav aria-label="Main" className="flex items-stretch gap-1 sm:gap-2">
            {NAV.map((n) => {
              const active = n.active(route.name);
              const Icon = n.icon;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  aria-current={active ? 'page' : undefined}
                  className={`relative flex items-center gap-2 whitespace-nowrap px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-brand-500 after:absolute after:inset-x-2 after:bottom-0 after:h-0.5 after:rounded-full ${
                    active
                      ? 'text-stone-900 after:bg-brand-600 dark:text-white dark:after:bg-brand-400'
                      : 'text-stone-600 after:bg-transparent hover:text-stone-900 hover:after:bg-stone-300 dark:text-stone-400 dark:hover:text-white dark:hover:after:bg-stone-600'
                  }`}
                >
                  <Icon className="text-base" />
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
