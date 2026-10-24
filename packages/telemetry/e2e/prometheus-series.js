// Criterion 15 (docs/prompts/m3-design.md): repeatable, local-only check that the M3c metric
// catalog reaches Prometheus with the expected names, labels, and job and instance labels.
//
// Prerequisites: the Compose stack is running with telemetry (`docker compose up -d --build --wait`).
// Run: `pnpm e2e:prometheus`. It places a few real orders through the API.
// Not a CI gate: CI has no Compose stack. Exits 0 on success and 1 with diagnostics on failure.

const API = process.env.ORDERS_API_URL ?? 'http://localhost:3000';
const PROMETHEUS = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const COLLECTOR_HEALTH = process.env.COLLECTOR_HEALTH_URL ?? 'http://localhost:13133/';
const SKU = process.env.E2E_SKU ?? 'SKU-00042';
/** The worker's WORKER_ID in Compose. */
const WORKER_INSTANCE = process.env.E2E_WORKER_INSTANCE ?? 'worker-1';
/** Optional: the API's service.instance.id. Defaults to its container hostname, unknown here. */
const API_INSTANCE = process.env.E2E_API_INSTANCE ?? null;
const SERIES_BUDGET_MS = 30_000;
const POLL_MS = 1000;
const REQUEST_TIMEOUT_MS = Number(process.env.E2E_REQUEST_TIMEOUT_MS ?? 5_000);

const CATALOG_NAMES = [
  'http_server_request_duration_seconds_count',
  'db_client_connection_count',
  'db_client_connection_pending_requests',
  'db_client_connection_max',
  'commerce_orders',
  'commerce_worker_passes_total',
  'commerce_worker_inflight',
  'commerce_payment_calls_total',
  'commerce_payment_duration_seconds_count',
  'commerce_claims_recovered_total',
  'commerce_claims_released_total',
];
const STATUSES = ['failed', 'paid', 'payment_unknown', 'pending', 'processing'];
const POOLS = ['metrics', 'orders-api', 'simulator', 'worker'];
/** Label keys allowed on catalog series: the design's labels plus Prometheus and collector ones. */
const ALLOWED_LABELS = new Set([
  '__name__',
  'job',
  'instance',
  'le',
  'otel_scope_name',
  'otel_scope_version',
  'otel_scope_schema_url',
  'http_request_method',
  'http_route',
  'http_response_status_code',
  'db_client_connection_pool_name',
  'db_client_connection_state',
  'order_status',
  'order_pass_type',
  'order_pass_outcome',
  'payment_operation',
  'payment_result',
  'payment_replayed',
  'release_result',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (msg) => console.log(msg);
function fail(reason, hints = []) {
  console.error(`\nFAIL: ${reason}`);
  for (const hint of hints) console.error(`  - ${hint}`);
  process.exit(1);
}

/** A failure with a known cause: reported as a message and hints, without a stack trace. */
class CheckError extends Error {
  constructor(message, hints = []) {
    super(message);
    this.hints = hints;
  }
}

/** Fetches with a per-request timeout; timeouts and connection errors name the service. */
async function request(service, operation, url, init = {}) {
  let res;
  let text;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    text = await res.text();
  } catch (err) {
    if (err?.name === 'TimeoutError') {
      throw new CheckError(
        `${service} ${operation} timed out after ${REQUEST_TIMEOUT_MS} ms (${url})`,
        [`${service} accepted the connection but did not answer in time; check its logs`],
      );
    }
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? String(err);
    throw new CheckError(`${service} ${operation} failed: ${cause} (${url})`, [
      'start the stack: docker compose up -d --build --wait',
    ]);
  }
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

async function probe(service, url, hint) {
  let status = 0;
  let reason = '';
  try {
    status = (await request(service, `GET ${new URL(url).pathname}`, url)).status;
  } catch (err) {
    reason = err.message;
  }
  if (status !== 200) {
    fail(`${service} not ready at ${url} (status ${status})`, [...(reason ? [reason] : []), hint]);
  }
}

/** Runs an instant PromQL query and returns its result vector. */
async function query(promql) {
  const url = `${PROMETHEUS}/api/v1/query?${new URLSearchParams({ query: promql })}`;
  const res = await request('Prometheus', 'query', url);
  if (res.status !== 200 || res.body?.status !== 'success') {
    throw new CheckError(`Prometheus query failed (status ${res.status}): ${promql}`, [
      JSON.stringify(res.body?.error ?? res.body),
    ]);
  }
  return res.body.data.result;
}

async function labelNames() {
  const params = new URLSearchParams();
  params.append('match[]', `{__name__=~"${CATALOG_NAMES.join('|')}"}`);
  const res = await request('Prometheus', 'label names', `${PROMETHEUS}/api/v1/labels?${params}`);
  if (res.status !== 200) throw new CheckError(`Prometheus label names returned ${res.status}`);
  return res.body.data;
}

const sorted = (values) => [...new Set(values)].sort();
const labelsOf = (result, key) => sorted(result.map((r) => r.metric[key] ?? '(absent)'));

/** Every criterion-15 check, as a list of problems; empty means all passed. */
async function checkSeries() {
  const problems = [];
  const expectEqual = (what, actual, expected) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    }
  };

  const http422 = await query(
    'http_server_request_duration_seconds_count{http_route="/orders",http_response_status_code="422"}',
  );
  if (http422.length === 0) problems.push('no request-duration series for POST /orders with 422');
  const orders = await query('max by (order_status) (commerce_orders)');
  expectEqual('commerce_orders statuses', labelsOf(orders, 'order_status'), STATUSES);
  const pools = await query(
    'count by (db_client_connection_pool_name) (db_client_connection_count)',
  );
  expectEqual('connection-count pools', labelsOf(pools, 'db_client_connection_pool_name'), POOLS);
  for (const name of ['commerce_worker_passes_total', 'commerce_payment_calls_total']) {
    if ((await query(name)).length === 0) problems.push(`no ${name} series`);
  }

  // Job and instance labels, kept by honor_labels: true.
  const workerSeries = await query(
    'count by (job, instance) ({__name__=~"commerce_orders|commerce_worker_passes_total|commerce_payment_calls_total|db_client_connection_count", db_client_connection_pool_name!="orders-api"})',
  );
  expectEqual(
    'worker job and instance',
    workerSeries.map((r) => `${r.metric.job}/${r.metric.instance}`),
    [`worker/${WORKER_INSTANCE}`],
  );
  const apiSeries = await query(
    'count by (job, instance) ({__name__=~"http_server_request_duration_seconds_count|db_client_connection_count", db_client_connection_pool_name!~"worker|simulator|metrics"})',
  );
  const apiPairs = apiSeries.map((r) => `${r.metric.job}/${r.metric.instance}`);
  if (apiSeries.length !== 1 || apiSeries[0].metric.job !== 'orders-api') {
    problems.push(`API job and instance: got ${JSON.stringify(apiPairs)}, expected one orders-api`);
  } else {
    const instance = apiSeries[0].metric.instance ?? '';
    if (!instance || instance.includes('otel-collector')) {
      problems.push(`API instance is "${instance}", expected its service.instance.id`);
    } else if (API_INSTANCE !== null && instance !== API_INSTANCE) {
      problems.push(`API instance is "${instance}", expected E2E_API_INSTANCE=${API_INSTANCE}`);
    }
  }
  for (const label of ['exported_job', 'exported_instance']) {
    const leaked = await query(`count({__name__=~"${CATALOG_NAMES.join('|')}", ${label}!=""})`);
    if (leaked.length > 0) {
      problems.push(`catalog series carry ${label}; is honor_labels: true set on the scrape job?`);
    }
  }

  // Closed label keys: nothing outside the catalog, such as an order id or a raw URL.
  const unexpected = (await labelNames()).filter((l) => !ALLOWED_LABELS.has(l));
  if (unexpected.length > 0) problems.push(`unexpected label keys: ${unexpected.join(', ')}`);

  return {
    problems,
    summary: {
      orders: Object.fromEntries(orders.map((r) => [r.metric.order_status, r.value[1]])),
      pools: labelsOf(pools, 'db_client_connection_pool_name'),
      worker: workerSeries.map((r) => `${r.metric.job}/${r.metric.instance}`),
      api: apiPairs,
    },
  };
}

async function main() {
  await probe(
    'orders API',
    `${API}/readyz`,
    'start the stack: docker compose up -d --build --wait',
  );
  await probe('Prometheus', `${PROMETHEUS}/-/ready`, 'check: docker compose ps prometheus');
  await probe(
    'OpenTelemetry Collector',
    COLLECTOR_HEALTH,
    'check: docker compose ps otel-collector',
  );

  // Mixed traffic: paid and declined orders, their lookups, a catalog read, one 422 and one 404.
  const placed = [];
  for (const paymentMethod of ['pm_card_ok', 'pm_card_ok', 'pm_card_declined']) {
    const res = await request('orders API', 'POST /orders', `${API}/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], paymentMethod }),
    });
    if (res.status !== 201)
      fail(`POST /orders returned ${res.status}: ${JSON.stringify(res.body)}`);
    placed.push(res.body.id);
  }
  for (const id of placed) await request('orders API', 'GET /orders/:id', `${API}/orders/${id}`);
  await request('orders API', 'GET /products', `${API}/products?limit=5`);
  const unknownSku = await request('orders API', 'POST /orders (unknown SKU)', `${API}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [{ sku: 'SKU-99999', quantity: 1 }],
      paymentMethod: 'pm_card_ok',
    }),
  });
  if (unknownSku.status !== 422) fail(`unknown-SKU order returned ${unknownSku.status}, not 422`);
  await request('orders API', 'GET unmatched URL', `${API}/no/such/path`);
  const trafficDoneAt = Date.now();
  log(`placed ${placed.length} orders, one 422 and one 404; polling Prometheus`);

  let result;
  while (true) {
    result = await checkSeries();
    if (result.problems.length === 0 || Date.now() - trafficDoneAt > SERIES_BUDGET_MS) break;
    await sleep(POLL_MS);
  }
  const elapsed = ((Date.now() - trafficDoneAt) / 1000).toFixed(1);
  if (result.problems.length > 0) {
    fail(`series incomplete ${elapsed} s after traffic (budget ${SERIES_BUDGET_MS / 1000} s)`, [
      ...result.problems,
      'is telemetry enabled for both apps? Compose sets OTEL_EXPORTER_OTLP_ENDPOINT',
      'check: docker compose logs otel-collector worker orders-api',
    ]);
  }
  log(`all series present ${elapsed} s after traffic`);
  log(`  commerce_orders: ${JSON.stringify(result.summary.orders)}`);
  log(`  pools: ${result.summary.pools.join(', ')}`);
  log(`  worker job/instance: ${result.summary.worker.join(', ')}`);
  log(`  API job/instance: ${result.summary.api.join(', ')}`);
  log('  no exported_job or exported_instance labels; label keys are closed');
  log('PASS: criterion 15');
}

main().catch((err) => {
  if (err instanceof CheckError) fail(err.message, err.hints);
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
