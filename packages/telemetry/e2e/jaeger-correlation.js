// Criterion 12 (docs/prompts/m3-design.md): repeatable, local-only check that an order's creation
// trace and its worker pass trace are both findable in Jaeger by order.id, and linked.
//
// Prerequisites: the Compose stack is running with telemetry (`docker compose up -d --build --wait`),
// and DATABASE_URL points at its Postgres (the default .env does). Run: `pnpm e2e:jaeger`.
// Not a CI gate: CI has no Compose stack. Exits 0 on success and 1 with diagnostics on failure.
import { createPool } from '@commerce/db';

const API = process.env.ORDERS_API_URL ?? 'http://localhost:3000';
const JAEGER = process.env.JAEGER_URL ?? 'http://localhost:16686';
const SKU = process.env.E2E_SKU ?? 'SKU-00042';
const POLL_MS = 500;
const SEARCH_BUDGET_MS = 10_000;
const PAID_BUDGET_MS = 30_000;
// No single request may hang: each HTTP call and database query is bounded on its own.
const REQUEST_TIMEOUT_MS = Number(process.env.E2E_REQUEST_TIMEOUT_MS ?? 5_000);
const DB_CONNECT_TIMEOUT_MS = 3_000;
const DB_STATEMENT_TIMEOUT_MS = 5_000;
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

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

/**
 * Fetches `url` with a per-request timeout and parses a JSON body when there is one. Timeouts and
 * connection errors become a CheckError naming the service and operation.
 */
async function getJson(service, operation, url, init = {}) {
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

/** Status of a preflight request, or 0 with the reason when it could not complete. */
async function probe(service, operation, url) {
  try {
    return { status: (await getJson(service, operation, url)).status, reason: '' };
  } catch (err) {
    return { status: 0, reason: err.message };
  }
}

const redact = (url) => url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');

/** Maps a pg connection or query error to an actionable message. */
function databaseError(err, target) {
  const code = err?.code ?? '';
  // Connecting to localhost tries IPv6 and IPv4; the combined error has an empty message.
  const message = err?.message || err?.errors?.[0]?.message || String(err);
  const detail = code && !message.includes(code) ? `${code}: ${message}` : message;
  const start = 'start Postgres: docker compose up -d --wait postgres';
  if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH')
    return new CheckError(`cannot reach the database at ${target} (${detail})`, [start]);
  if (/timeout/i.test(err?.message ?? ''))
    return new CheckError(`database at ${target} did not answer in time (${detail})`, [start]);
  if (code === '28P01' || code === '28000')
    return new CheckError(`database rejected the credentials in DATABASE_URL (${detail})`, [
      'compare DATABASE_URL in .env with .env.example',
    ]);
  if (code === '3D000')
    return new CheckError(`database in DATABASE_URL does not exist (${detail})`, [
      'run the migrations: docker compose up migrate',
    ]);
  return new CheckError(`database error at ${target} (${detail})`);
}

/** Validates DATABASE_URL and opens a one-connection pool that has been proven to work. */
async function connectDatabase() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new CheckError('DATABASE_URL is not set', [
      'copy .env.example to .env, or export DATABASE_URL for the Compose Postgres',
    ]);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new CheckError('DATABASE_URL is not a valid URL');
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new CheckError(`DATABASE_URL must use postgres://, got ${parsed.protocol}//`);
  }
  const target = redact(url);
  const pool = createPool(
    {
      connectionString: url,
      max: 1,
      connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
      statementTimeoutMillis: DB_STATEMENT_TIMEOUT_MS,
    },
    () => undefined,
  );
  let column;
  try {
    column = await pool.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = 'trace_context'`,
    );
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw databaseError(err, target);
  }
  if (column.rowCount === 0) {
    await pool.end().catch(() => undefined);
    throw new CheckError(`orders.trace_context does not exist in ${target}`, [
      'is migration 003 applied? check: docker compose logs migrate',
    ]);
  }
  return { pool, target };
}

/** Flattens a Jaeger v3 response into { traceId -> [{ service, span }] }. */
function tracesOf(body) {
  const byTrace = new Map();
  for (const rs of body?.result?.resourceSpans ?? []) {
    const service =
      rs.resource?.attributes?.find((a) => a.key === 'service.name')?.value?.stringValue ?? '?';
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        if (!byTrace.has(span.traceId)) byTrace.set(span.traceId, []);
        byTrace.get(span.traceId).push({ service, span });
      }
    }
  }
  return byTrace;
}

const iso = (date) => date.toISOString();
const describeTrace = (entries) =>
  [...new Set(entries.map((e) => `${e.service}:${e.span.name}`))].sort().join(', ');
const linkAttribute = (link, key) =>
  link.attributes?.find((a) => a.key === key)?.value?.stringValue;

async function main() {
  // Preflight: configuration and every dependency, before any order is placed.
  const { pool, target } = await connectDatabase();
  log(`database reachable at ${target}`);
  try {
    await run(pool);
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function run(pool) {
  const ready = await probe('orders API', 'GET /readyz', `${API}/readyz`);
  if (ready.status !== 200) {
    fail(`orders API not ready at ${API}/readyz (status ${ready.status})`, [
      ...(ready.reason ? [ready.reason] : []),
      'start the stack: docker compose up -d --build --wait',
    ]);
  }
  const jaegerUp = await probe('Jaeger', 'GET /', `${JAEGER}/`);
  if (jaegerUp.status !== 200) {
    fail(`Jaeger UI not reachable at ${JAEGER}/ (status ${jaegerUp.status})`, [
      ...(jaegerUp.reason ? [jaegerUp.reason] : []),
      'check: docker compose ps jaeger',
    ]);
  }

  // Place an order through the API and wait until it is paid: its pass span has then ended.
  const created = await getJson('orders API', 'POST /orders', `${API}/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ sku: SKU, quantity: 1 }], paymentMethod: 'pm_card_ok' }),
  });
  if (created.status !== 201)
    fail(`POST /orders returned ${created.status}: ${JSON.stringify(created.body)}`);
  const orderId = created.body.id;
  const createdAt = new Date(created.body.createdAt);
  log(`order ${orderId} created at ${created.body.createdAt}`);

  const paidDeadline = Date.now() + PAID_BUDGET_MS;
  let order = created.body;
  while (order.status !== 'paid') {
    if (Date.now() > paidDeadline) {
      fail(`order did not reach paid within ${PAID_BUDGET_MS / 1000} s (status ${order.status})`, [
        `lastError: ${order.lastError ?? 'none'}`,
        'check: docker compose logs worker',
      ]);
    }
    await sleep(100);
    order = (await getJson('orders API', 'GET /orders/:id', `${API}/orders/${orderId}`)).body;
  }
  const paidSeenAt = Date.now();
  log('order is paid; searching Jaeger');

  // The creation trace and span ids come from the stored traceparent.
  let stored;
  try {
    const result = await pool.query('SELECT trace_context FROM orders WHERE id = $1', [orderId]);
    stored = result.rows[0]?.trace_context ?? null;
  } catch (err) {
    throw databaseError(err, 'DATABASE_URL');
  }
  if (!stored) {
    fail('the order has no stored trace_context', [
      'is telemetry enabled for orders-api? Compose sets OTEL_EXPORTER_OTLP_ENDPOINT',
      'does DATABASE_URL point at the Postgres the Compose orders-api uses?',
    ]);
  }
  const parsedContext = TRACEPARENT.exec(stored);
  if (!parsedContext) fail(`stored trace_context is not a W3C traceparent: ${stored}`);
  const [, creationTraceId, creationSpanId] = parsedContext;
  log(`stored traceparent ${stored} (creation trace ${creationTraceId}, span ${creationSpanId})`);

  // Poll the v3 search every 500 ms for up to 10 s from the moment the order is seen as paid.
  const attributes = JSON.stringify({ 'order.id': orderId });
  const startTimeMin = iso(new Date(createdAt.getTime() - 10 * 60_000));
  let found = new Map();
  let creation;
  let pass;
  let lastSearchStatus;
  while (Date.now() - paidSeenAt <= SEARCH_BUDGET_MS) {
    const params = new URLSearchParams({
      'query.attributes': attributes,
      'query.startTimeMin': startTimeMin,
      'query.startTimeMax': iso(new Date(Date.now() + 60_000)),
    });
    const search = await getJson('Jaeger', 'trace search', `${JAEGER}/api/v3/traces?${params}`);
    lastSearchStatus = search.status;
    found = search.status === 200 ? tracesOf(search.body) : new Map();
    creation = found.get(creationTraceId);
    pass = [...found.entries()].find(([, entries]) =>
      entries.some((e) => e.span.name === 'order.process'),
    );
    if (creation && pass) break;
    await sleep(POLL_MS);
  }
  const elapsed = ((Date.now() - paidSeenAt) / 1000).toFixed(2);

  if (!creation || !pass) {
    const byId = await getJson(
      'Jaeger',
      'get trace by id',
      `${JAEGER}/api/v3/traces/${creationTraceId}`,
    );
    const creationById = byId.status === 200 ? tracesOf(byId.body).get(creationTraceId) : undefined;
    const hints = [
      `last search status: ${lastSearchStatus}; traces found: ${
        [...found.keys()].join(', ') || 'none'
      }`,
    ];
    if (!creation) {
      hints.push(
        creationById
          ? `creation trace ${creationTraceId} exists by id but did not match order.id: correlation defect (spans: ${describeTrace(creationById)})`
          : `creation trace ${creationTraceId} not found by id either: export or indexing problem (check: docker compose logs otel-collector)`,
      );
    }
    if (!pass) {
      hints.push(
        `no order.process trace matched order.id; find the pass trace id with: docker compose logs worker | grep ${orderId}`,
      );
    }
    fail(
      `both traces not found within ${SEARCH_BUDGET_MS / 1000} s of paid (${elapsed} s elapsed)`,
      hints,
    );
  }

  const [passTraceId, passEntries] = pass;
  const creationNames = new Set(creation.map((e) => e.span.name));
  const passNames = new Set(passEntries.map((e) => e.span.name));
  const root = passEntries.find((e) => e.span.name === 'order.process').span;
  const problems = [];
  for (const name of ['POST /orders', 'order.create']) {
    if (!creationNames.has(name)) problems.push(`creation trace ${creationTraceId} lacks ${name}`);
  }
  if (![...creationNames].some((n) => n.startsWith('pg.')))
    problems.push('creation trace has no database spans');
  // The stored traceparent was captured inside order.create, so its span id must be that span.
  const storedSpan = creation.find((e) => e.span.spanId === creationSpanId)?.span;
  if (storedSpan?.name !== 'order.create') {
    problems.push(
      `stored span id ${creationSpanId} is ${storedSpan ? storedSpan.name : 'not in the creation trace'}, expected order.create`,
    );
  }
  for (const name of ['order.process', 'payment.charge']) {
    if (!passNames.has(name)) problems.push(`pass trace ${passTraceId} lacks ${name}`);
  }
  if (![...passNames].some((n) => n.startsWith('pg.')))
    problems.push('pass trace has no database spans');
  if (passTraceId === creationTraceId)
    problems.push('the pass shares the creation trace; it must be a new trace');
  const links = root.links ?? [];
  const link = links.find((l) => l.traceId === creationTraceId && l.spanId === creationSpanId);
  if (!link) {
    problems.push(
      `order.process in ${passTraceId} has no link to creation span ${creationTraceId}/${creationSpanId} (links: ${JSON.stringify(links)})`,
    );
  } else if (!link.attributes) {
    // Jaeger 2.22 returns link attributes; if a later version drops them, say so rather than pass.
    problems.push('Jaeger returned the link without attributes, so order.id cannot be verified');
  } else if (linkAttribute(link, 'order.id') !== orderId) {
    problems.push(
      `link order.id is ${linkAttribute(link, 'order.id') ?? 'missing'}, expected ${orderId}`,
    );
  }
  if (problems.length > 0) fail('trace shapes or link are wrong', problems);
  log(`found both traces ${elapsed} s after paid`);
  log(`  creation ${creationTraceId}: ${describeTrace(creation)}`);
  log(`  pass     ${passTraceId}: ${describeTrace(passEntries)}`);
  log(
    `  pass root links to creation span ${creationTraceId}/${creationSpanId} with order.id ${orderId}`,
  );

  const byId = await getJson(
    'Jaeger',
    'get trace by id',
    `${JAEGER}/api/v3/traces/${creationTraceId}`,
  );
  if (byId.status !== 200 || !tracesOf(byId.body).get(creationTraceId)) {
    fail(
      `GET /api/v3/traces/${creationTraceId} returned ${byId.status} without the creation trace`,
    );
  }
  log(`GET /api/v3/traces/${creationTraceId}: 200`);

  // Control: the search without time bounds must be rejected, guarding against a contract change.
  const control = await getJson(
    'Jaeger',
    'control search without time bounds',
    `${JAEGER}/api/v3/traces?${new URLSearchParams({ 'query.attributes': attributes })}`,
  );
  if (control.status !== 400) {
    fail(`control search without time bounds returned ${control.status}, expected 400`, [
      'the Jaeger v3 search contract may have changed; recheck docs/prompts/m3-design.md "Trace search"',
    ]);
  }
  log(`control search without time bounds: 400 (${control.body?.error?.message ?? 'no message'})`);
  log('PASS: criterion 12');
}

main().catch((err) => {
  if (err instanceof CheckError) fail(err.message, err.hints);
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
});
