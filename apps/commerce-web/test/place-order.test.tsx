// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { deferred, order, product, stubFetch, type Call, type Reply } from './support';

const catalog = (call: Call): Reply | undefined =>
  call.url.startsWith('/api/products')
    ? { body: { items: [product(7), product(42)], nextCursor: null } }
    : undefined;

const open = () => {
  window.history.replaceState(null, '', '/');
  return render(<App />);
};
const sku = (n = 1) => screen.getByLabelText<HTMLInputElement>(`SKU, item ${String(n)}`);
const quantity = (n = 0) => screen.getAllByLabelText('Quantity')[n] as HTMLInputElement;
const submit = () => {
  fireEvent.click(screen.getByRole('button', { name: /Place order|Placing order/ }));
};

describe('place an order', () => {
  it('submits a valid order with an Idempotency-Key and shows the order ID and status', async () => {
    const calls = stubFetch((call) => catalog(call) ?? { status: 201, body: order() });
    open();
    fireEvent.change(sku(), { target: { value: 'sku-00042' } });
    fireEvent.change(quantity(), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add another item' }));
    fireEvent.change(sku(2), { target: { value: 'SKU-00007' } });
    fireEvent.change(screen.getByLabelText('Payment method'), {
      target: { value: 'pm_card_declined' },
    });
    submit();

    const placed = await screen.findByRole('heading', { name: 'Order placed' });
    expect(document.activeElement).toBe(placed);
    expect(screen.getByText(order().id)).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    expect(screen.getByText(/Total \$30\.85 for 2 item/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Track live status' }).getAttribute('href')).toBe(
      `/orders/${order().id}`,
    );

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.url).toBe('/api/orders');
    expect(post?.body).toEqual({
      items: [
        { sku: 'SKU-00042', quantity: 2 },
        { sku: 'SKU-00007', quantity: 1 },
      ],
      paymentMethod: 'pm_card_declined',
    });
    expect(post?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(post?.headers['content-type']).toBe('application/json');

    fireEvent.click(screen.getByRole('button', { name: 'Place another order' }));
    expect(sku().value).toBe('');
  });

  it('validates before sending and focuses the first invalid field', async () => {
    const calls = stubFetch((call) => catalog(call) ?? { status: 201, body: order() });
    open();
    await screen.findByRole('list', { name: 'Products' });
    fireEvent.change(quantity(), { target: { value: '0' } });
    submit();
    expect(screen.getByText('Enter a SKU.')).toBeTruthy();
    expect(screen.getByText('Enter a whole number from 1 to 100.')).toBeTruthy();
    expect(sku().getAttribute('aria-invalid')).toBe('true');
    expect(sku().getAttribute('aria-describedby')).toBe('sku-0-error');
    expect(document.activeElement).toBe(sku());
    fireEvent.change(sku(), { target: { value: 'SKU-1' } });
    expect(screen.queryByText('Enter a SKU.')).toBeNull();
    submit();
    expect(screen.getByText('Use the format SKU-00042.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('disables the submit button while the request is in flight', async () => {
    const pending = deferred();
    const calls = stubFetch((call) => catalog(call) ?? pending.promise);
    open();
    fireEvent.change(sku(), { target: { value: 'SKU-00042' } });
    submit();
    submit();
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Placing order…' });
    expect(button.disabled).toBe(true);
    expect(screen.getByText('Submitting your order')).toBeTruthy();
    pending.release({ status: 201, body: order() });
    await screen.findByRole('heading', { name: 'Order placed' });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('marks SKUs the API does not know (422) and fields it rejects (400)', async () => {
    let reply: Reply = {
      status: 422,
      body: { error: 'unknown_product', message: 'unknown SKUs in order', details: ['SKU-99999'] },
    };
    stubFetch((call) => catalog(call) ?? reply);
    open();
    fireEvent.change(sku(), { target: { value: 'SKU-99999' } });
    submit();
    expect(await screen.findByText('No product has this SKU.')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('Some SKUs do not match any product');

    reply = {
      status: 400,
      body: {
        error: 'validation_error',
        message: 'request validation failed',
        details: [{ path: 'items.0.quantity', message: 'too big' }],
      },
    };
    fireEvent.change(sku(), { target: { value: 'SKU-00042' } });
    submit();
    expect(await screen.findByText('The API rejected this quantity.')).toBeTruthy();

    reply = { status: 409, body: { error: 'idempotency_key_conflict', message: 'conflict' } };
    submit();
    expect(await screen.findByText(/conflicted with an earlier one/)).toBeTruthy();
  });

  it('after a lost response, retrying reuses the same key; editing the order uses a new one', async () => {
    let fail = true;
    const calls = stubFetch(
      (call) =>
        catalog(call) ?? (fail ? new TypeError('fetch failed') : { status: 200, body: order() }),
    );
    open();
    fireEvent.change(sku(), { target: { value: 'SKU-00042' } });
    submit();
    const alert = await screen.findByText(
      /may or may not have been placed; submitting again is safe/,
    );
    expect(alert.textContent).toContain('The orders API could not be reached.');
    submit();
    await waitFor(() => {
      expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2);
    });
    fireEvent.change(quantity(), { target: { value: '3' } });
    fail = false;
    submit();
    await screen.findByRole('heading', { name: 'Order placed' });
    const keys = calls.filter((c) => c.method === 'POST').map((c) => c.headers['idempotency-key']);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[1]);
  });

  it('a server error is reported with its message', async () => {
    stubFetch(
      (call) =>
        catalog(call) ?? {
          status: 500,
          body: { error: 'internal_error', message: 'internal server error' },
        },
    );
    open();
    fireEvent.change(sku(), { target: { value: 'SKU-00042' } });
    submit();
    expect((await screen.findByText(/internal server error/)).textContent).toContain(
      'submitting again is safe',
    );
  });
});

describe('catalog', () => {
  it('adds products to the order from real catalog data, and pages with the cursor', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('after=SKU-00042')
        ? { body: { items: [product(43, { stockAvailable: 0 })], nextCursor: null } }
        : { body: { items: [product(7), product(42)], nextCursor: 'SKU-00042' } },
    );
    open();
    expect(screen.getByRole('status').textContent).toContain('Loading products');
    const list = await screen.findByRole('list', { name: 'Products' });
    expect(within(list).getByText(/SKU-00042/).parentElement?.textContent).toContain(
      '$10.42 · 50 in stock',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add Product 42 (SKU-00042)' }));
    expect(sku().value).toBe('SKU-00042');
    fireEvent.click(screen.getByRole('button', { name: 'Add Product 42 (SKU-00042)' }));
    expect(quantity().value).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: 'Add Product 7 (SKU-00007)' }));
    expect(sku(2).value).toBe('SKU-00007');
    fireEvent.click(screen.getByRole('button', { name: 'Remove item 2' }));
    expect(screen.queryByLabelText('SKU, item 2')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show more products' }));
    expect(await screen.findByText('Product 43')).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(3);
    expect(calls.map((c) => c.url)).toEqual([
      '/api/products?limit=8',
      '/api/products?limit=8&after=SKU-00042',
    ]);
  });

  it('shows an empty catalog and a catalog error with retry', async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    const view = open();
    expect(await screen.findByText('The catalog is empty')).toBeTruthy();
    view.unmount();

    let fail = true;
    stubFetch(() =>
      fail
        ? { status: 503, body: { error: 'internal_error', message: 'database unavailable' } }
        : { body: { items: [product(1)], nextCursor: null } },
    );
    open();
    expect(await screen.findByText('database unavailable')).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Product 1')).toBeTruthy();
  });
});
