import { z } from 'zod';
import type { Plan } from './plan.js';
import type { HttpFetch } from './runner.js';
import { REQUEST_TIMEOUT_MS } from './stats.js';

/**
 * Preflight (docs/prompts/m4-design.md, "Preflight"): before a live run, check the orders API's
 * readiness, the catalog, and the starting stock, through public GET endpoints only. It never
 * writes, resets or reseeds anything, and it cannot guarantee stock during the run.
 */
export const SHORTFALL_THRESHOLD_PERCENT = 5;
const PAGE_LIMIT = 100;
/** A safety stop far above the 1,000-product catalog, in case a server never ends paging. */
const MAX_PAGES = 1_000;

const productsPage = z.object({
  items: z.array(z.object({ sku: z.string(), stockAvailable: z.number().int() })),
  nextCursor: z.string().nullable(),
});

export interface ShortSku {
  readonly sku: string;
  readonly planned: number;
  readonly available: number;
  readonly unmet: number;
}

export interface StockCheck {
  readonly plannedQuantity: number;
  readonly unmetQuantity: number;
  readonly shortfallPercent: number;
  readonly thresholdPercent: number;
  /** Every SKU whose planned quantity exceeds its available stock: unmet desc, then SKU. */
  readonly shortSkus: readonly ShortSku[];
}

export interface PreflightResult {
  readonly passed: boolean;
  readonly readyz: { readonly status: number | null; readonly error?: string };
  readonly catalog?: { readonly products: number; readonly missingSkus: readonly string[] };
  readonly stock?: StockCheck;
  /** Why the run stops, when it does. */
  readonly failure?: string;
}

export interface PreflightDeps {
  readonly baseUrl: string;
  readonly fetch: HttpFetch;
  readonly timeoutSignal?: (ms: number) => AbortSignal;
}

/** Planned quantity per SKU, summed over every order.create item in the whole plan. */
export function plannedQuantities(plan: Plan): Map<string, number> {
  const planned = new Map<string, number>();
  for (const entry of plan.entries) {
    if (entry.op !== 'order.create') continue;
    for (const item of entry.params.items) {
      planned.set(item.sku, (planned.get(item.sku) ?? 0) + item.quantity);
    }
  }
  return planned;
}

/**
 * shortfall (%) = 100 * sum of max(0, planned - available) / sum of planned. A SKU missing from
 * `available` counts as having no stock.
 */
export function checkStock(
  planned: ReadonlyMap<string, number>,
  available: ReadonlyMap<string, number>,
): StockCheck {
  let plannedQuantity = 0;
  let unmetQuantity = 0;
  const shortSkus: ShortSku[] = [];
  for (const [sku, quantity] of planned) {
    const stock = available.get(sku) ?? 0;
    const unmet = Math.max(0, quantity - stock);
    plannedQuantity += quantity;
    unmetQuantity += unmet;
    if (unmet > 0) shortSkus.push({ sku, planned: quantity, available: stock, unmet });
  }
  shortSkus.sort((a, b) => b.unmet - a.unmet || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0));
  return {
    plannedQuantity,
    unmetQuantity,
    shortfallPercent: plannedQuantity === 0 ? 0 : (100 * unmetQuantity) / plannedQuantity,
    thresholdPercent: SHORTFALL_THRESHOLD_PERCENT,
    shortSkus,
  };
}

const describe = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

export async function runPreflight(plan: Plan, deps: PreflightDeps): Promise<PreflightResult> {
  const base = deps.baseUrl.replace(/\/+$/, '');
  const timeoutSignal = deps.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));
  const get = (path: string) =>
    deps.fetch(`${base}${path}`, {
      method: 'GET',
      headers: {},
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
    });

  // 1. Readiness: the orders API only. The worker is not a prerequisite.
  let readyStatus: number;
  try {
    const response = await get('/readyz');
    await response.text();
    readyStatus = response.status;
  } catch (err) {
    return {
      passed: false,
      readyz: { status: null, error: describe(err) },
      failure: `the orders API at ${base} did not answer /readyz (${describe(err)}); start it with: docker compose up -d --build --wait`,
    };
  }
  if (readyStatus !== 200) {
    return {
      passed: false,
      readyz: { status: readyStatus },
      failure: `the orders API at ${base} is not ready: /readyz returned ${String(readyStatus)}; check: docker compose up -d --build --wait`,
    };
  }

  // 2. The catalog and its stock, through every page of GET /products.
  const available = new Map<string, number>();
  let after: string | null = null;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) {
      return {
        passed: false,
        readyz: { status: readyStatus },
        failure: `GET /products did not finish paging after ${String(MAX_PAGES)} pages`,
      };
    }
    const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
    if (after !== null) query.set('after', after);
    let parsed: z.infer<typeof productsPage>;
    try {
      const response = await get(`/products?${query.toString()}`);
      const body = await response.text();
      if (response.status !== 200) {
        throw new Error(`GET /products returned ${String(response.status)}`);
      }
      parsed = productsPage.parse(JSON.parse(body));
    } catch (err) {
      return {
        passed: false,
        readyz: { status: readyStatus },
        failure: `could not read the catalog from ${base}/products (${describe(err)})`,
      };
    }
    for (const item of parsed.items) available.set(item.sku, item.stockAvailable);
    if (parsed.nextCursor === null) break;
    if (parsed.nextCursor === after) {
      return {
        passed: false,
        readyz: { status: readyStatus },
        failure: 'GET /products returned the same cursor twice; paging cannot advance',
      };
    }
    after = parsed.nextCursor;
  }

  const planned = plannedQuantities(plan);
  const missingSkus = [...planned.keys()].filter((sku) => !available.has(sku)).sort();
  const stock = checkStock(planned, available);
  const catalog = { products: available.size, missingSkus };
  if (missingSkus.length > 0) {
    return {
      passed: false,
      readyz: { status: readyStatus },
      catalog,
      stock,
      failure: `${String(missingSkus.length)} planned SKUs are missing from the API's catalog (first: ${missingSkus.slice(0, 5).join(', ')}); was the database seeded from the same catalog? Run: pnpm db:seed`,
    };
  }

  // 3. Starting stock. Exactly 5% passes; the per-SKU list is informational.
  if (stock.shortfallPercent > SHORTFALL_THRESHOLD_PERCENT) {
    return {
      passed: false,
      readyz: { status: readyStatus },
      catalog,
      stock,
      failure: `stock shortfall is ${stock.shortfallPercent.toFixed(2)}% of planned order-item quantity (${String(stock.unmetQuantity)} of ${String(stock.plannedQuantity)} units), above ${String(SHORTFALL_THRESHOLD_PERCENT)}%. pnpm db:seed never changes existing SKUs, so restoring stock means recreating the database by hand. The load generator never resets or reseeds it.`,
    };
  }
  return { passed: true, readyz: { status: readyStatus }, catalog, stock };
}
