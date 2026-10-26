import { useEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { api, ApiError, type Order, type PaymentMethod, type Product } from '../api';
import {
  BUTTON,
  Card,
  EmptyState,
  ErrorState,
  INPUT,
  LoadingState,
  Mono,
  StatusBadge,
} from '../components/ui';
import { formatMoney, PAYMENT_TEXT, STATUS_HELP } from '../format';
import {
  MAX_LINES,
  MAX_QUANTITY,
  normalizeSku,
  quantityField,
  serverFieldErrors,
  skuField,
  unknownSkuErrors,
  validateOrder,
  type FieldErrors,
  type Line,
} from '../orderForm';
import { Link } from '../router';

const PAYMENT_METHODS = Object.keys(PAYMENT_TEXT) as PaymentMethod[];
const newKey = () => crypto.randomUUID();

type Submit =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; order: Order }
  | { status: 'error'; error: ApiError };

export function PlaceOrderPage() {
  const nextLineKey = useRef(1);
  const [lines, setLines] = useState<Line[]>([{ key: 0, sku: '', quantity: '1' }]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pm_card_ok');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submit, setSubmit] = useState<Submit>({ status: 'idle' });
  // One key per distinct request: kept for a retry of the same order, replaced when it changes.
  const idempotencyKey = useRef<string | null>(null);

  const edit = (update: (lines: Line[]) => Line[]) => {
    idempotencyKey.current = null;
    setLines(update);
    if (submit.status === 'error') setSubmit({ status: 'idle' });
  };
  const setLine = (key: number, patch: Partial<Line>) => {
    edit((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    setErrors((errs) => {
      const rest = { ...errs };
      for (const field of [skuField(key), quantityField(key), 'form'])
        Reflect.deleteProperty(rest, field);
      return rest;
    });
  };
  const addLine = (sku = '') => {
    edit((ls) => [...ls, { key: nextLineKey.current++, sku, quantity: '1' }]);
  };
  const removeLine = (key: number) => {
    edit((ls) => ls.filter((l) => l.key !== key));
  };
  const addProduct = (product: Product) => {
    const existing = lines.find((l) => normalizeSku(l.sku) === product.sku);
    if (existing) {
      const q = Math.min(MAX_QUANTITY, (Number(existing.quantity) || 0) + 1);
      setLine(existing.key, { quantity: String(q) });
      return;
    }
    const blank = lines.find((l) => l.sku.trim() === '');
    if (blank) setLine(blank.key, { sku: product.sku });
    else if (lines.length < MAX_LINES) addLine(product.sku);
  };

  const onSubmit = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (submit.status === 'submitting') return;
    const { errors: found, order } = validateOrder(lines, paymentMethod);
    setErrors(found);
    if (!order) {
      const first = Object.keys(found).find((k) => k !== 'form');
      if (first) document.getElementById(first)?.focus();
      return;
    }
    idempotencyKey.current ??= newKey();
    setSubmit({ status: 'submitting' });
    try {
      const created = await api.createOrder(order, idempotencyKey.current);
      idempotencyKey.current = null;
      setSubmit({ status: 'success', order: created });
    } catch (err) {
      const error = err instanceof ApiError ? err : new ApiError(0, 'network_error', String(err));
      if (error.code === 'unknown_product') setErrors(unknownSkuErrors(lines, error.details));
      else if (error.code === 'validation_error')
        setErrors(serverFieldErrors(lines, error.details));
      // A rejected request is final, so the next attempt is a new request with a new key.
      if (!error.transient) idempotencyKey.current = null;
      setSubmit({ status: 'error', error });
    }
  };

  const reset = () => {
    nextLineKey.current = 1;
    setLines([{ key: 0, sku: '', quantity: '1' }]);
    setErrors({});
    setSubmit({ status: 'idle' });
  };

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Place an order</h1>
        <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
          Add products by SKU, choose a test payment method, and submit. Prices, stock and the
          outcome are decided by the orders API and the order processor.
        </p>
      </header>
      {submit.status === 'success' ? (
        <OrderPlaced order={submit.order} onAnother={reset} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
          <Card title="Items">
            <form
              onSubmit={(e) => void onSubmit(e)}
              noValidate
              aria-describedby={errors.form ? 'form-error' : undefined}
            >
              <ul className="space-y-4" aria-label="Order items">
                {lines.map((line, i) => (
                  <li
                    key={line.key}
                    className="grid grid-cols-[minmax(0,1fr)_6rem_auto] items-start gap-3"
                  >
                    <Field
                      id={skuField(line.key)}
                      label={`SKU, item ${String(i + 1)}`}
                      error={errors[skuField(line.key)]}
                    >
                      <input
                        id={skuField(line.key)}
                        className={INPUT}
                        value={line.sku}
                        placeholder="SKU-00042"
                        autoComplete="off"
                        spellCheck={false}
                        onChange={(e) => {
                          setLine(line.key, { sku: e.target.value });
                        }}
                        aria-invalid={errors[skuField(line.key)] ? true : undefined}
                        aria-describedby={
                          errors[skuField(line.key)] ? `${skuField(line.key)}-error` : undefined
                        }
                      />
                    </Field>
                    <Field
                      id={quantityField(line.key)}
                      label="Quantity"
                      error={errors[quantityField(line.key)]}
                    >
                      <input
                        id={quantityField(line.key)}
                        className={INPUT}
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={MAX_QUANTITY}
                        step={1}
                        value={line.quantity}
                        onChange={(e) => {
                          setLine(line.key, { quantity: e.target.value });
                        }}
                        aria-invalid={errors[quantityField(line.key)] ? true : undefined}
                        aria-describedby={
                          errors[quantityField(line.key)]
                            ? `${quantityField(line.key)}-error`
                            : undefined
                        }
                      />
                    </Field>
                    <button
                      type="button"
                      className={`${BUTTON.secondary} mt-6`}
                      onClick={() => {
                        removeLine(line.key);
                      }}
                      disabled={lines.length === 1}
                      aria-label={`Remove item ${String(i + 1)}`}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className={`${BUTTON.secondary} mt-4`}
                onClick={() => {
                  addLine();
                }}
                disabled={lines.length >= MAX_LINES}
              >
                Add another item
              </button>

              <div className="mt-6 max-w-sm">
                <label htmlFor="payment-method" className="block text-sm font-medium">
                  Payment method
                </label>
                <select
                  id="payment-method"
                  className={`${INPUT} mt-1`}
                  value={paymentMethod}
                  onChange={(e) => {
                    idempotencyKey.current = null;
                    setPaymentMethod(e.target.value as PaymentMethod);
                  }}
                  aria-describedby="payment-help"
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {PAYMENT_TEXT[m]}
                    </option>
                  ))}
                </select>
                <p id="payment-help" className="mt-1 text-xs text-stone-500 dark:text-stone-400">
                  The local payment simulator decides the charge result from the test card.
                </p>
              </div>

              {errors.form && (
                <p
                  id="form-error"
                  role="alert"
                  className="mt-4 text-sm text-rose-700 dark:text-rose-300"
                >
                  {errors.form}
                </p>
              )}
              {submit.status === 'error' && <SubmitError error={submit.error} />}

              <div className="mt-6 flex items-center gap-3">
                <button
                  type="submit"
                  className={BUTTON.primary}
                  disabled={submit.status === 'submitting'}
                >
                  {submit.status === 'submitting' ? 'Placing order…' : 'Place order'}
                </button>
                {submit.status === 'submitting' && (
                  <span role="status" className="text-sm text-stone-500">
                    Submitting your order
                  </span>
                )}
              </div>
            </form>
          </Card>
          <CatalogPanel onAdd={addProduct} />
        </div>
      )}
    </div>
  );
}

function Field({
  id,
  label,
  error,
  children,
}: {
  id: string;
  label: string;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {error && (
        <p id={`${id}-error`} className="mt-1 text-xs text-rose-700 dark:text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}

function SubmitError({ error }: { error: ApiError }) {
  const text =
    error.code === 'unknown_product'
      ? 'Some SKUs do not match any product. They are marked above.'
      : error.code === 'validation_error'
        ? 'The orders API rejected the order. Check the marked fields.'
        : error.code === 'idempotency_key_conflict'
          ? 'This submission conflicted with an earlier one. Submit again to place it as a new order.'
          : error.transient
            ? `${error.message} The order may or may not have been placed; submitting again is safe and will not create a duplicate.`
            : error.message;
  return (
    <div
      role="alert"
      className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-900 dark:bg-rose-950 dark:text-rose-200"
    >
      <p className="font-medium">The order was not placed</p>
      <p className="mt-1">{text}</p>
    </div>
  );
}

function OrderPlaced({ order, onAnother }: { order: Order; onAnother: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <Card>
      <div className="space-y-3" role="status" aria-live="polite">
        <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold outline-none">
          Order placed
        </h2>
        <p className="text-sm">
          Order ID <Mono>{order.id}</Mono>
        </p>
        <p className="flex flex-wrap items-center gap-2 text-sm">
          Status <StatusBadge status={order.status} />
          <span className="text-stone-500">{STATUS_HELP[order.status]}</span>
        </p>
        <p className="text-sm">
          Total {formatMoney(order.totalCents, order.currency)} for {order.items.length} item(s)
        </p>
      </div>
      <div className="mt-5 flex flex-wrap gap-3">
        <Link href={`/orders/${order.id}`} className={BUTTON.primary}>
          Track live status
        </Link>
        <button type="button" className={BUTTON.secondary} onClick={onAnother}>
          Place another order
        </button>
      </div>
    </Card>
  );
}

const CATALOG_PAGE = 8;

/** Real catalog data from GET /products, paged by cursor. */
function CatalogPanel({ onAdd }: { onAdd: (p: Product) => void }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [request, setRequest] = useState<{ after: string | null; n: number }>({
    after: null,
    n: 0,
  });
  const [state, setState] = useState<'loading' | 'idle' | { error: Error }>('loading');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading');
    api.products(request.after, CATALOG_PAGE, controller.signal).then(
      (page) => {
        if (controller.signal.aborted) return;
        setProducts((ps) => (request.after === null ? page.items : [...ps, ...page.items]));
        setCursor(page.nextCursor);
        setState('idle');
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState({ error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => {
      controller.abort();
    };
  }, [request]);

  return (
    <Card title="Catalog">
      {products.length > 0 && (
        <ul className="divide-y divide-stone-200 dark:divide-stone-800" aria-label="Products">
          {products.map((p) => (
            <li key={p.sku} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{p.name}</p>
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  <Mono>{p.sku}</Mono> · {formatMoney(p.priceCents, p.currency)} ·{' '}
                  {p.stockAvailable} in stock
                </p>
              </div>
              <button
                type="button"
                className={BUTTON.secondary}
                onClick={() => {
                  onAdd(p);
                }}
                aria-label={`Add ${p.name} (${p.sku})`}
              >
                Add
              </button>
            </li>
          ))}
        </ul>
      )}
      {state === 'loading' && <LoadingState label="Loading products" />}
      {typeof state === 'object' && (
        <ErrorState
          title="Could not load the catalog"
          error={state.error}
          onRetry={() => {
            setRequest((r) => ({ ...r, n: r.n + 1 }));
          }}
        />
      )}
      {state === 'idle' && products.length === 0 && (
        <EmptyState title="The catalog is empty">Seed it with pnpm db:seed.</EmptyState>
      )}
      {state === 'idle' && cursor && (
        <button
          type="button"
          className={`${BUTTON.secondary} mt-3 w-full`}
          onClick={() => {
            setRequest((r) => ({ after: cursor, n: r.n + 1 }));
          }}
        >
          Show more products
        </button>
      )}
      <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
        Stock is checked when the order is processed, not when it is placed.
      </p>
    </Card>
  );
}
