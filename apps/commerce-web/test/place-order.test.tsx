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
    const payment = screen.getByRole('group', { name: 'Payment method' });
    expect(within(payment).getByRole<HTMLInputElement>('radio', { name: /approves/ }).checked).toBe(
      true,
    );
    fireEvent.click(within(payment).getByRole('radio', { name: /declines/ }));
    submit();

    const placed = await screen.findByRole('heading', { name: 'Order placed' });
    expect(document.activeElement).toBe(placed);
    expect(screen.getByText(order().id)).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    const summary = screen.getByRole('status').parentElement?.textContent ?? '';
    expect(summary).toContain('Items2 product(s), 3 unit(s)');
    expect(summary).toContain('Total$30.85');
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
    const card = within(list).getByText('Product 42').closest('li');
    expect(card?.textContent).toContain('$10.42');
    expect(card?.textContent).toContain('50 in stock');
    expect(screen.getByText('2 products shown')).toBeTruthy();
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
      '/api/products?limit=12',
      '/api/products?limit=12&after=SKU-00042',
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

  it('marks low and sold-out stock, and does not offer sold-out products', async () => {
    stubFetch(() => ({
      body: {
        items: [product(1, { stockAvailable: 4 }), product(2, { stockAvailable: 0 })],
        nextCursor: null,
      },
    }));
    open();
    const list = await screen.findByRole('list', { name: 'Products' });
    expect(within(list).getAllByText('Only 4 left').length).toBeGreaterThan(0);
    expect(within(list).getAllByText('Out of stock').length).toBeGreaterThan(0);
    const soldOut = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Product 2 (SKU-00002) is out of stock',
    });
    expect(soldOut.disabled).toBe(true);
    expect(soldOut.textContent).toBe('Sold out');
  });
});

describe('order panel', () => {
  it('steps quantities within 1 to 100 and shows line totals and the estimate from catalog prices', async () => {
    stubFetch(() => ({ body: { items: [product(7), product(42)], nextCursor: null } }));
    open();
    await screen.findByRole('list', { name: 'Products' });
    const estimate = () => screen.getByTestId('estimate').textContent;
    expect(estimate()).toBe('—');
    expect(screen.getByText('0 units')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add Product 7 (SKU-00007)' }));
    const decrease = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Decrease quantity, item 1',
    });
    const increase = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Increase quantity, item 1',
    });
    expect(decrease.disabled).toBe(true);
    fireEvent.click(increase);
    fireEvent.click(increase);
    expect(quantity().value).toBe('3');
    expect(decrease.disabled).toBe(false);
    fireEvent.click(decrease);
    expect(quantity().value).toBe('2');
    expect(screen.getByText('Product 7 · $10.07 each')).toBeTruthy();
    expect(estimate()).toBe('$20.14');
    expect(screen.getByText('2 units')).toBeTruthy();
    const card7 = within(screen.getByRole('list', { name: 'Products' }))
      .getByText('Product 7')
      .closest('li');
    expect(card7?.textContent).toContain('2 in order');

    fireEvent.change(quantity(), { target: { value: '100' } });
    expect(increase.disabled).toBe(true);
    fireEvent.click(increase);
    expect(quantity().value).toBe('100');

    // A typed SKU that is not in the shown catalog has no price, and the estimate says so.
    fireEvent.click(screen.getByRole('button', { name: 'Add another item' }));
    fireEvent.change(sku(2), { target: { value: 'SKU-99999' } });
    expect(screen.getByText('Not shown in the catalog; the API will check it.')).toBeTruthy();
    expect(screen.getByText(/Excludes 1 item\(s\) without a shown price/)).toBeTruthy();
    expect(estimate()).toBe('$1,007.00');
    expect(
      screen.getByRole('link', { name: /Review order · 101 units/ }).getAttribute('href'),
    ).toBe('#your-order');
  });
});
