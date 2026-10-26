// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { navigate } from '../src/router';
import { stubFetch, summary, type Call, type Reply } from './support';

const open = (path = '/orders') => {
  window.history.replaceState(null, '', path);
  return render(<App />);
};
const page = (items: unknown[], nextCursor: string | null = null): Reply => ({
  body: { items, nextCursor },
});
const params = (c: Call) => Object.fromEntries(new URL(c.url, 'http://x').searchParams);
const cards = () => screen.getAllByRole('article');
const search = () => screen.getByLabelText<HTMLInputElement>('Search orders');
const chip = (name: string) =>
  within(screen.getByRole('group', { name: 'Filter by status' })).getByRole('button', { name });

describe('Your Orders: cards', () => {
  it('shows a loading state, then a card per order with date, total, counts, status and items', async () => {
    const calls = stubFetch(() =>
      page([
        summary(1, {
          status: 'processing',
          createdAt: '2026-10-26T02:54:28.571Z',
          totalCents: 18711,
          itemCount: 5,
          totalQuantity: 9,
        }),
        summary(2, { status: 'failed', failureReason: 'payment_declined' }),
        summary(3, { status: 'payment_unknown' }),
        summary(4),
      ]),
    );
    open();
    expect(
      screen.getAllByRole('status').some((s) => s.textContent.includes('Loading orders')),
    ).toBe(true);
    await screen.findByRole('list', { name: 'Orders' });
    expect(calls.map((c) => c.url)).toEqual(['/api/orders?limit=20']);
    const [first, second] = cards();
    const text = first?.textContent ?? '';
    expect(text).toContain('Order placedOct 26, 202602:54 UTC');
    // The authoritative total from the API, not a sum of the preview.
    expect(text).toContain('Total$187.11');
    expect(text).toContain('Items5 products9 units');
    expect(text).toContain('#00000000');
    expect(text).toContain('Still in progress.');
    expect(text).toContain('Product 7SKU-00007 · Qty 1');
    expect(text).toContain('Product 42SKU-00042 · Qty 2');
    expect(text).toContain('and 3 more products');
    expect(first?.querySelector('[data-status]')?.textContent).toBe('Processing');
    expect(second?.textContent).toContain('The payment method was declined.');
    expect(cards().map((c) => c.querySelector('[data-status]')?.textContent)).toEqual([
      'Processing',
      'Failed',
      'Confirming payment',
      'Paid',
    ]);
    expect(screen.getByText('Showing 4 orders.')).toBeTruthy();
  });

  it('offers Track order for orders in progress and View order details for finished ones', async () => {
    stubFetch((c) =>
      c.url.startsWith('/api/orders?')
        ? page([summary(1, { status: 'pending' }), summary(2)])
        : { status: 404, body: { error: 'order_not_found', message: 'order not found' } },
    );
    open();
    const track = await screen.findByRole('link', { name: `Track order ${summary(1).id}` });
    expect(track.getAttribute('href')).toBe(`/orders/${summary(1).id}`);
    expect(
      screen
        .getByRole('link', { name: `View order details ${summary(2).id}` })
        .getAttribute('href'),
    ).toBe(`/orders/${summary(2).id}`);
    fireEvent.click(track);
    expect(window.location.pathname).toBe(`/orders/${summary(1).id}`);
    expect(await screen.findByText('Order not found')).toBeTruthy();
  });

  it('says where item details are when the API sends no preview', async () => {
    const legacy = summary(1);
    delete legacy.items;
    stubFetch(() => page([legacy]));
    open();
    expect(await screen.findByText('Item details are on the order page.')).toBeTruthy();
  });

  it('copies the full order ID and confirms it, or says it could not', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const clipboard = (value: unknown) => {
      Object.defineProperty(navigator, 'clipboard', { value, configurable: true });
    };
    clipboard({ writeText });
    stubFetch(() => page([summary(1)]));
    open();
    fireEvent.click(await screen.findByRole('button', { name: `Copy order ID ${summary(1).id}` }));
    expect(await screen.findByText('Order ID copied to the clipboard')).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(summary(1).id);
    expect(screen.getByText('Copied')).toBeTruthy();

    clipboard({ writeText: () => Promise.reject(new Error('denied')) });
    fireEvent.click(screen.getByRole('button', { name: `Copy order ID ${summary(1).id}` }));
    expect(await screen.findByText('Could not copy the order ID')).toBeTruthy();

    // No clipboard at all (an insecure context) is reported the same way.
    Reflect.deleteProperty(navigator, 'clipboard');
    await new Promise((r) => setTimeout(r, 2100));
    fireEvent.click(screen.getByRole('button', { name: `Copy order ID ${summary(1).id}` }));
    expect(await screen.findByText('Could not copy the order ID')).toBeTruthy();
  });
});

describe('Your Orders: search and filters', () => {
  it('searches on the server after a pause, ignoring a leading #, and resets the cursor', async () => {
    const calls = stubFetch((c) =>
      params(c).q ? page([summary(9)]) : page([summary(1), summary(2)], summary(2).id),
    );
    open();
    await screen.findByRole('list', { name: 'Orders' });
    fireEvent.change(search(), { target: { value: '  #ABC12 ' } });
    fireEvent.change(search(), { target: { value: '  #abc123 ' } });
    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
    // One debounced request for the final text, from the first page.
    expect(calls.map(params)).toEqual([{ limit: '20' }, { limit: '20', q: 'abc123' }]);
    expect(screen.getByText('Showing 1 order matching “abc123”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear order search' }));
    await waitFor(() => {
      expect(cards()).toHaveLength(2);
    });
    expect(params(calls.at(-1) as Call)).toEqual({ limit: '20' });
  });

  it('filters by status, combines it with search, and keeps both when paging and refreshing', async () => {
    const calls = stubFetch((c) => {
      const p = params(c);
      if (p.after) return page([summary(30, { status: 'failed' })]);
      if (p.status === 'failed') return page([summary(10, { status: 'failed' })], summary(10).id);
      return page([summary(1)], summary(1).id);
    });
    open();
    await screen.findByRole('list', { name: 'Orders' });
    expect(chip('All orders').getAttribute('aria-pressed')).toBe('true');
    expect(
      within(screen.getByRole('group', { name: 'Filter by status' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['All orders', 'Pending', 'Processing', 'Confirming payment', 'Paid', 'Failed']);
    fireEvent.click(chip('Failed'));
    expect(chip('Failed').getAttribute('aria-pressed')).toBe('true');
    expect(chip('All orders').getAttribute('aria-pressed')).toBe('false');
    await screen.findByText('Showing 1 order · Failed. Older orders load below.');
    // The cursor from the unfiltered list is never reused under the filter.
    expect(params(calls[1] as Call)).toEqual({ limit: '20', status: 'failed' });

    fireEvent.change(search(), { target: { value: 'lunar' } });
    await waitFor(() => {
      expect(params(calls.at(-1) as Call)).toEqual({ limit: '20', status: 'failed', q: 'lunar' });
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Load older orders' }));
    await waitFor(() => {
      expect(cards()).toHaveLength(2);
    });
    expect(params(calls.at(-1) as Call)).toEqual({
      limit: '20',
      status: 'failed',
      q: 'lunar',
      after: summary(10).id,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect(cards()).toHaveLength(1);
    });
    expect(params(calls.at(-1) as Call)).toEqual({ limit: '20', status: 'failed', q: 'lunar' });
  });

  it('tells an empty history apart from no matching orders', async () => {
    stubFetch(() => page([]));
    const view = open();
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Place the first order' }).getAttribute('href')).toBe(
      '/',
    );
    fireEvent.click(chip('Paid'));
    expect(await screen.findByText('No orders match')).toBeTruthy();
    expect(screen.getByText(/No orders have this status/)).toBeTruthy();
    fireEvent.change(search(), { target: { value: 'zzz' } });
    expect(await screen.findByText(/Nothing matches “zzz” with status Paid/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    expect(search().value).toBe('');
    view.unmount();
  });

  it('explains when the orders API is too old to search or filter', async () => {
    stubFetch((c) =>
      params(c).status
        ? {
            status: 400,
            body: { error: 'validation_error', message: 'request validation failed', details: [] },
          }
        : page([summary(1)]),
    );
    open();
    await screen.findByRole('list', { name: 'Orders' });
    fireEvent.click(chip('Paid'));
    expect(await screen.findByText('This orders API cannot search or filter yet')).toBeTruthy();
    // The unfiltered orders are not left on screen under the Paid filter.
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await screen.findByRole('list', { name: 'Orders' })).toBeTruthy();
    expect(chip('All orders').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Your Orders: paging and errors', () => {
  it('loads older orders with the cursor, keeping the order, and refreshes from the start', async () => {
    const calls = stubFetch((c) =>
      c.url.includes('after=') ? page([summary(3)]) : page([summary(1), summary(2)], summary(2).id),
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older orders' }));
    await waitFor(() => {
      expect(cards()).toHaveLength(3);
    });
    expect(cards().map((c) => c.textContent.match(/#?([0-9a-f]{8})Copy/)?.[1])).toEqual([
      '00000000',
      '00000000',
      '00000000',
    ]);
    expect(screen.queryByRole('button', { name: 'Load older orders' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Load older orders' });
    expect(cards()).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      '/api/orders?limit=20',
      `/api/orders?limit=20&after=${summary(2).id}`,
      '/api/orders?limit=20',
    ]);
  });

  it('shows errors with retry, for the first page and for later pages', async () => {
    let fail = true;
    stubFetch((call) => {
      if (call.url.includes('after=')) return fail ? { status: 502 } : page([summary(3)]);
      return fail ? new TypeError('fetch failed') : page([summary(1)], summary(1).id);
    });
    open();
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The orders API could not be reached.',
    );
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('list', { name: 'Orders' });
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Load older orders' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The orders API answered 502.',
    );
    expect(cards()).toHaveLength(1);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(cards()).toHaveLength(2);
    });
  });
});

describe('navigation', () => {
  it('marks the active page, routes client-side, and shows not found', async () => {
    stubFetch(() => page([]));
    open('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Shop' }).getAttribute('aria-current')).toBe(
      'page',
    );
    fireEvent.click(within(nav).getByRole('link', { name: 'Your Orders' }));
    expect(window.location.pathname).toBe('/orders');
    expect(await screen.findByRole('heading', { name: 'Your Orders' })).toBeTruthy();
    expect(
      within(nav).getByRole('link', { name: 'Your Orders' }).getAttribute('aria-current'),
    ).toBe('page');
    act(() => {
      navigate('/nowhere');
    });
    expect(screen.getByText('Page not found')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Skip to content' }).getAttribute('href')).toBe(
      '#main',
    );
  });
});
