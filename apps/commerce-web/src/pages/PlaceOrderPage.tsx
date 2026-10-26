import { useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react';
import { api, ApiError, type Order, type PaymentMethod, type Product } from '../api';
import {
  ArrowRightIcon,
  BagIcon,
  CardIcon,
  CheckIcon,
  MinusIcon,
  PlusIcon,
  Spinner,
  TrashIcon,
} from '../components/icons';
import { ProductArt } from '../components/ProductArt';
import {
  BUTTON,
  EmptyState,
  ErrorState,
  INPUT,
  LoadingState,
  Mono,
  PageHeader,
  StatusBadge,
  SURFACE,
} from '../components/ui';
import { formatMoney, PAYMENT_DETAIL, PAYMENT_TEXT, STATUS_HELP } from '../format';
import {
  MAX_LINES,
  MAX_QUANTITY,
  normalizeSku,
  quantityField,
  serverFieldErrors,
  SKU_PATTERN,
  skuField,
  unknownSkuErrors,
  validateOrder,
  type FieldErrors,
  type Line,
} from '../orderForm';
import { Link } from '../router';
import { useCatalog, type CatalogStatus } from '../useCatalog';

const PAYMENT_METHODS = Object.keys(PAYMENT_TEXT) as PaymentMethod[];
const newKey = () => crypto.randomUUID();

type Submit =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'success'; order: Order }
  | { status: 'error'; error: ApiError };

export function PlaceOrderPage() {
  const catalog = useCatalog();
  const nextLineKey = useRef(1);
  const [lines, setLines] = useState<Line[]>([{ key: 0, sku: '', quantity: '1' }]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('pm_card_ok');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submit, setSubmit] = useState<Submit>({ status: 'idle' });
  // One key per distinct request: kept for a retry of the same order, replaced when it changes.
  const idempotencyKey = useRef<string | null>(null);

  const bySku = useMemo(() => new Map(catalog.products.map((p) => [p.sku, p])), [catalog.products]);

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
  const step = (line: Line, delta: number) => {
    const q = Math.min(MAX_QUANTITY, Math.max(1, (Number(line.quantity) || 0) + delta));
    setLine(line.key, { quantity: String(q) });
  };
  const addProduct = (product: Product) => {
    const existing = lines.find((l) => normalizeSku(l.sku) === product.sku);
    if (existing) {
      step(existing, 1);
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

  if (submit.status === 'success') return <OrderPlaced order={submit.order} onAnother={reset} />;

  const inOrder = (sku: string) => {
    const line = lines.find((l) => normalizeSku(l.sku) === sku);
    return line ? Number(line.quantity) || 0 : 0;
  };
  // Units in lines that name a product; the blank starting line is not part of the order yet.
  const units = lines.reduce(
    (n, l) => n + (l.sku.trim() !== '' && Number(l.quantity) > 0 ? Number(l.quantity) : 0),
    0,
  );

  return (
    <div className="pb-24 lg:pb-0">
      <PageHeader
        eyebrow="Storefront"
        title="Shop the catalog"
        description="Products, prices and stock come live from the orders API. Add items, choose a test card, and place a real order on your local stack."
      />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-8 lg:grid-cols-[minmax(0,1fr)_23rem] xl:grid-cols-[minmax(0,1fr)_25rem]">
        <CatalogSection
          products={catalog.products}
          status={catalog.status}
          hasMore={catalog.hasMore}
          onMore={catalog.loadMore}
          onRetry={catalog.retry}
          onAdd={addProduct}
          inOrder={inOrder}
        />

        <section
          id="your-order"
          aria-labelledby="your-order-title"
          className={`${SURFACE} scroll-mt-24 lg:sticky lg:top-24`}
        >
          <form
            onSubmit={(e) => void onSubmit(e)}
            noValidate
            aria-describedby={errors.form ? 'form-error' : undefined}
          >
            <div className="flex items-center justify-between gap-3 border-b border-stone-200/80 px-5 py-4 dark:border-stone-800">
              <h2
                id="your-order-title"
                className="flex items-center gap-2 text-base font-semibold tracking-tight"
              >
                <BagIcon className="text-lg text-brand-600 dark:text-brand-400" />
                Your order
              </h2>
              <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-700 tabular-nums dark:bg-stone-800 dark:text-stone-300">
                {units} unit{units === 1 ? '' : 's'}
              </span>
            </div>

            <div className="space-y-5 px-5 py-5">
              <ul className="space-y-3" aria-label="Order items">
                {lines.map((line, i) => (
                  <OrderLine
                    key={line.key}
                    line={line}
                    index={i}
                    product={bySku.get(normalizeSku(line.sku))}
                    errors={errors}
                    onlyLine={lines.length === 1}
                    onChange={(patch) => {
                      setLine(line.key, patch);
                    }}
                    onStep={(delta) => {
                      step(line, delta);
                    }}
                    onRemove={() => {
                      removeLine(line.key);
                    }}
                  />
                ))}
              </ul>
              <button
                type="button"
                className={`${BUTTON.ghost} -ml-2.5 text-brand-700 dark:text-brand-300`}
                onClick={() => {
                  addLine();
                }}
                disabled={lines.length >= MAX_LINES}
              >
                <PlusIcon />
                Add another item
              </button>

              <fieldset>
                <legend className="text-sm font-semibold">Payment method</legend>
                <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-400">
                  The local payment simulator decides the charge result from the test card.
                </p>
                <div className="mt-3 space-y-2">
                  {PAYMENT_METHODS.map((m) => (
                    <label
                      key={m}
                      className="flex cursor-pointer items-start gap-3 rounded-xl border border-stone-200 p-3 transition-colors hover:border-stone-300 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-500 dark:border-stone-800 dark:hover:border-stone-700 dark:has-[:checked]:border-brand-400 dark:has-[:checked]:bg-brand-950/40"
                    >
                      <input
                        type="radio"
                        name="payment-method"
                        value={m}
                        checked={paymentMethod === m}
                        onChange={() => {
                          idempotencyKey.current = null;
                          setPaymentMethod(m);
                        }}
                        className="mt-0.5 h-4 w-4 accent-brand-600"
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <CardIcon className="text-stone-500" />
                          {PAYMENT_TEXT[m]}
                        </span>
                        <span className="mt-0.5 block text-xs text-stone-600 dark:text-stone-400">
                          {PAYMENT_DETAIL[m]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <Estimate lines={lines} bySku={bySku} />

              {errors.form && (
                <p
                  id="form-error"
                  role="alert"
                  className="text-sm font-medium text-rose-700 dark:text-rose-300"
                >
                  {errors.form}
                </p>
              )}
              {submit.status === 'error' && <SubmitError error={submit.error} />}

              <div>
                <button
                  type="submit"
                  className={`${BUTTON.primary} w-full py-3 text-[0.95rem]`}
                  disabled={submit.status === 'submitting'}
                >
                  {submit.status === 'submitting' ? (
                    <>
                      <Spinner />
                      Placing order…
                    </>
                  ) : (
                    'Place order'
                  )}
                </button>
                {submit.status === 'submitting' && (
                  <p
                    role="status"
                    className="mt-2 text-center text-xs text-stone-600 dark:text-stone-400"
                  >
                    Submitting your order
                  </p>
                )}
              </div>
            </div>
          </form>
        </section>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-stone-200 bg-white/90 px-4 py-3 backdrop-blur lg:hidden dark:border-stone-800 dark:bg-stone-900/90">
        <a href="#your-order" className={`${BUTTON.primary} w-full`}>
          <BagIcon />
          Review order · {units} unit{units === 1 ? '' : 's'}
        </a>
      </div>
    </div>
  );
}

function OrderLine({
  line,
  index,
  product,
  errors,
  onlyLine,
  onChange,
  onStep,
  onRemove,
}: {
  line: Line;
  index: number;
  product: Product | undefined;
  errors: FieldErrors;
  onlyLine: boolean;
  onChange: (patch: Partial<Line>) => void;
  onStep: (delta: number) => void;
  onRemove: () => void;
}) {
  const n = String(index + 1);
  const skuId = skuField(line.key);
  const qtyId = quantityField(line.key);
  const skuError = errors[skuId];
  const qtyError = errors[qtyId];
  const quantity = Number(line.quantity);
  const sku = normalizeSku(line.sku);
  return (
    <li className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
      <div className="flex items-start gap-3">
        {product ? (
          <ProductArt
            sku={product.sku}
            name={product.name}
            className="h-11 w-11 shrink-0 rounded-lg text-sm"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg border border-dashed border-stone-300 text-stone-400 dark:border-stone-700"
          >
            <BagIcon />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <label
            htmlFor={skuId}
            className="block text-xs font-medium text-stone-600 dark:text-stone-400"
          >
            SKU, item {n}
          </label>
          <input
            id={skuId}
            className={`${INPUT} mt-1 py-2 font-mono`}
            value={line.sku}
            placeholder="SKU-00042"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              onChange({ sku: e.target.value });
            }}
            aria-invalid={skuError ? true : undefined}
            aria-describedby={skuError ? `${skuId}-error` : undefined}
          />
          {skuError ? (
            <p
              id={`${skuId}-error`}
              className="mt-1 text-xs font-medium text-rose-700 dark:text-rose-300"
            >
              {skuError}
            </p>
          ) : (
            <p className="mt-1 truncate text-xs text-stone-600 dark:text-stone-400">
              {product
                ? `${product.name} · ${formatMoney(product.priceCents, product.currency)} each`
                : SKU_PATTERN.test(sku)
                  ? 'Not shown in the catalog; the API will check it.'
                  : 'Or add a product from the catalog.'}
            </p>
          )}
        </div>
        <button
          type="button"
          className={`${BUTTON.ghost} -mr-1 -mt-1 h-9 w-9 p-0`}
          onClick={onRemove}
          disabled={onlyLine}
          aria-label={`Remove item ${n}`}
          title="Remove"
        >
          <TrashIcon />
        </button>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <label
            htmlFor={qtyId}
            className="block text-xs font-medium text-stone-600 dark:text-stone-400"
          >
            Quantity
          </label>
          <div className="mt-1 flex items-center rounded-xl border border-stone-300 bg-white shadow-sm focus-within:border-brand-500 focus-within:ring-4 focus-within:ring-brand-500/15 has-[[aria-invalid=true]]:border-rose-500 dark:border-stone-700 dark:bg-stone-950">
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-l-xl text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:text-stone-300 dark:hover:bg-stone-800"
              onClick={() => {
                onStep(-1);
              }}
              disabled={!(quantity > 1)}
              aria-label={`Decrease quantity, item ${n}`}
            >
              <MinusIcon />
            </button>
            <input
              id={qtyId}
              className="h-9 w-12 bg-transparent text-center text-sm font-medium tabular-nums focus:outline-none"
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_QUANTITY}
              step={1}
              value={line.quantity}
              onChange={(e) => {
                onChange({ quantity: e.target.value });
              }}
              aria-invalid={qtyError ? true : undefined}
              aria-describedby={qtyError ? `${qtyId}-error` : undefined}
            />
            <button
              type="button"
              className="flex h-9 w-9 items-center justify-center rounded-r-xl text-stone-600 hover:bg-stone-100 disabled:opacity-40 dark:text-stone-300 dark:hover:bg-stone-800"
              onClick={() => {
                onStep(1);
              }}
              disabled={quantity >= MAX_QUANTITY}
              aria-label={`Increase quantity, item ${n}`}
            >
              <PlusIcon />
            </button>
          </div>
        </div>
        {product && quantity >= 1 && quantity <= MAX_QUANTITY && Number.isInteger(quantity) && (
          <p className="pb-2 text-sm font-semibold tabular-nums">
            {formatMoney(product.priceCents * quantity, product.currency)}
          </p>
        )}
      </div>
      {qtyError && (
        <p
          id={`${qtyId}-error`}
          className="mt-1.5 text-xs font-medium text-rose-700 dark:text-rose-300"
        >
          {qtyError}
        </p>
      )}
    </li>
  );
}

/** A display-only estimate from catalog prices; the API computes the real total. */
function Estimate({
  lines,
  bySku,
}: {
  lines: readonly Line[];
  bySku: ReadonlyMap<string, Product>;
}) {
  let cents = 0;
  let currency: string | null = null;
  let unpriced = 0;
  for (const l of lines) {
    if (l.sku.trim() === '') continue;
    const p = bySku.get(normalizeSku(l.sku));
    const q = Number(l.quantity);
    if (!p || !Number.isInteger(q) || q < 1) {
      unpriced += 1;
      continue;
    }
    cents += p.priceCents * q;
    currency ??= p.currency;
  }
  return (
    <div className="rounded-xl bg-stone-50 p-4 dark:bg-stone-950/60">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm text-stone-600 dark:text-stone-400">Estimated total</span>
        <span className="text-xl font-semibold tracking-tight tabular-nums" data-testid="estimate">
          {currency ? formatMoney(cents, currency) : '—'}
        </span>
      </div>
      <p className="mt-1 text-xs text-stone-600 dark:text-stone-400">
        {unpriced > 0 ? `Excludes ${String(unpriced)} item(s) without a shown price. ` : ''}The
        orders API sets the final total when the order is placed.
      </p>
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
      className="rounded-xl border border-rose-200 bg-rose-50 p-3.5 text-sm text-rose-900 dark:border-rose-900/70 dark:bg-rose-950/50 dark:text-rose-200"
    >
      <p className="font-semibold">The order was not placed</p>
      <p className="mt-0.5">{text}</p>
    </div>
  );
}

function OrderPlaced({ order, onAnother }: { order: Order; onAnother: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const units = order.items.reduce((n, i) => n + i.quantity, 0);
  return (
    <div className="mx-auto max-w-xl py-4">
      <section className={`${SURFACE} overflow-hidden`}>
        <div
          className="bg-gradient-to-br from-emerald-50 via-white to-brand-50 px-6 py-8 text-center sm:px-8 dark:from-emerald-950/40 dark:via-stone-900 dark:to-brand-950/40"
          role="status"
          aria-live="polite"
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600 text-2xl text-white shadow-lift">
            <CheckIcon />
          </div>
          <h2
            ref={heading}
            tabIndex={-1}
            className="mt-4 text-2xl font-semibold tracking-tight outline-none"
          >
            Order placed
          </h2>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-400">
            The orders API accepted your order. Processing happens in the background.
          </p>
        </div>
        <dl className="divide-y divide-stone-200/80 px-6 text-sm sm:px-8 dark:divide-stone-800">
          <Row label="Order ID">
            <Mono>{order.id}</Mono>
          </Row>
          <Row label="Status">
            <span className="flex flex-wrap items-center justify-end gap-2">
              <StatusBadge status={order.status} />
            </span>
          </Row>
          <Row label="Items">
            {order.items.length} product(s), {units} unit(s)
          </Row>
          <Row label="Total">
            <span className="text-base font-semibold tabular-nums">
              {formatMoney(order.totalCents, order.currency)}
            </span>
          </Row>
        </dl>
        <p className="px-6 pb-2 text-xs text-stone-600 sm:px-8 dark:text-stone-400">
          {STATUS_HELP[order.status]}
        </p>
        <div className="flex flex-col gap-3 px-6 pb-6 pt-4 sm:flex-row sm:px-8">
          <Link href={`/orders/${order.id}`} className={`${BUTTON.primary} flex-1`}>
            Track live status
            <ArrowRightIcon />
          </Link>
          <button type="button" className={`${BUTTON.secondary} flex-1`} onClick={onAnother}>
            Place another order
          </button>
        </div>
      </section>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="text-stone-600 dark:text-stone-400">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

const stockText = (stock: number) =>
  stock <= 0
    ? 'Out of stock'
    : stock < 10
      ? `Only ${String(stock)} left`
      : `${String(stock)} in stock`;

function StockBadge({ stock }: { stock: number }) {
  const tone =
    stock <= 0
      ? 'bg-rose-600 text-white'
      : stock < 10
        ? 'bg-amber-400 text-amber-950'
        : 'bg-white/85 text-stone-800 dark:bg-stone-900/85 dark:text-stone-200';
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[0.7rem] font-semibold shadow-sm backdrop-blur ${tone}`}
    >
      {stockText(stock)}
    </span>
  );
}

function CatalogSection({
  products,
  status,
  hasMore,
  onMore,
  onRetry,
  onAdd,
  inOrder,
}: {
  products: Product[];
  status: CatalogStatus;
  hasMore: boolean;
  onMore: () => void;
  onRetry: () => void;
  onAdd: (p: Product) => void;
  inOrder: (sku: string) => number;
}) {
  const first = status === 'loading' && products.length === 0;
  return (
    <section aria-labelledby="catalog-title">
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="catalog-title" className="text-lg font-semibold tracking-tight">
          Catalog
        </h2>
        {products.length > 0 && (
          <p className="text-sm text-stone-600 dark:text-stone-400">
            {products.length} product{products.length === 1 ? '' : 's'} shown
          </p>
        )}
      </div>
      {first && <LoadingState label="Loading products" variant="grid" />}
      {products.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="Products">
          {products.map((p) => {
            const count = inOrder(p.sku);
            const out = p.stockAvailable <= 0;
            return (
              <li
                key={p.sku}
                className="group flex overflow-hidden rounded-2xl border border-stone-200/80 bg-white shadow-card transition duration-200 hover:border-stone-300 hover:shadow-lift motion-safe:hover:-translate-y-0.5 sm:flex-col dark:border-stone-800 dark:bg-stone-900 dark:hover:border-stone-700"
              >
                <div className="relative w-28 shrink-0 sm:w-auto">
                  <ProductArt
                    sku={p.sku}
                    name={p.name}
                    className="h-full min-h-28 text-2xl sm:aspect-[16/10] sm:h-auto sm:min-h-0 sm:text-4xl"
                  />
                  <div className="absolute left-3 top-3 hidden sm:block">
                    <StockBadge stock={p.stockAvailable} />
                  </div>
                  {count > 0 && (
                    <span className="absolute right-3 top-3 hidden rounded-full bg-brand-600 sm:inline px-2.5 py-1 text-[0.7rem] font-semibold text-white shadow-sm">
                      {count} in order
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-4">
                  <h3 className="font-semibold tracking-tight">{p.name}</h3>
                  <p className="mt-0.5 text-xs text-stone-600 dark:text-stone-400">
                    <Mono>{p.sku}</Mono>
                  </p>
                  <p className="mt-1 text-xs font-medium text-stone-600 sm:hidden dark:text-stone-400">
                    {stockText(p.stockAvailable)}
                    {count > 0 && (
                      <span className="text-brand-700 dark:text-brand-300">
                        {' '}
                        · {count} in order
                      </span>
                    )}
                  </p>
                  <div className="mt-auto flex items-center justify-between gap-3 pt-3 sm:pt-4">
                    <p className="text-lg font-semibold tracking-tight tabular-nums">
                      {formatMoney(p.priceCents, p.currency)}
                    </p>
                    <button
                      type="button"
                      className={`${BUTTON.primary} px-3.5 py-2`}
                      onClick={() => {
                        onAdd(p);
                      }}
                      disabled={out}
                      aria-label={
                        out ? `${p.name} (${p.sku}) is out of stock` : `Add ${p.name} (${p.sku})`
                      }
                    >
                      {out ? (
                        'Sold out'
                      ) : (
                        <>
                          <PlusIcon />
                          Add
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {typeof status === 'object' && (
        <div className={products.length > 0 ? 'mt-4' : ''}>
          <ErrorState title="Could not load the catalog" error={status.error} onRetry={onRetry} />
        </div>
      )}
      {status === 'idle' && products.length === 0 && (
        <EmptyState title="The catalog is empty" icon={<BagIcon />}>
          Seed it with <Mono>pnpm db:seed</Mono>.
        </EmptyState>
      )}
      {(hasMore || (status === 'loading' && products.length > 0)) && typeof status !== 'object' && (
        <div className="mt-6 flex justify-center">
          <button
            type="button"
            className={BUTTON.secondary}
            onClick={onMore}
            disabled={status === 'loading'}
          >
            {status === 'loading' ? (
              <>
                <Spinner />
                Loading products…
              </>
            ) : (
              'Show more products'
            )}
          </button>
        </div>
      )}
      <p className="mt-4 text-xs text-stone-600 dark:text-stone-400">
        Stock is reserved when the order is processed, not when it is placed, so it can change in
        between.
      </p>
    </section>
  );
}
