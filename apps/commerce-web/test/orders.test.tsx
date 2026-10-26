// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { navigate } from '../src/router';
import { stubFetch, summary } from './support';
import { act } from '@testing-library/react';

const open = (path = '/orders') => {
  window.history.replaceState(null, '', path);
  return render(<App />);
};

describe('order history', () => {
  it('shows a loading state, then orders with status, failure reason and detail links', async () => {
    const calls = stubFetch(() => ({
      body: {
        items: [
          summary(1, { status: 'processing' }),
          summary(2, { status: 'failed', failureReason: 'payment_declined' }),
          summary(3, { status: 'payment_unknown' }),
          summary(4),
        ],
        nextCursor: null,
      },
    }));
    open();
    expect(screen.getByRole('status').textContent).toContain('Loading orders');
    const list = await screen.findByRole('list', { name: 'Orders' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('[data-status]')?.textContent)).toEqual([
      'Processing',
      'Failed',
      'Confirming payment',
      'Paid',
    ]);
    expect(rows[1]?.textContent).toContain('The payment method was declined.');
    expect(rows[0]?.textContent).toContain('3 unit(s) of 2 product(s) · $20.01');
    expect(rows[0]?.textContent).toContain('2026-10-25 12:00:00 UTC');
    expect(
      within(list)
        .getByRole('link', { name: `Order ${summary(1).id}` })
        .getAttribute('href'),
    ).toBe(`/orders/${summary(1).id}`);
    expect(calls.map((c) => c.url)).toEqual(['/api/orders?limit=20']);
    expect(screen.queryByRole('button', { name: 'Load older orders' })).toBeNull();
  });

  it('shows an empty state with a link to place an order', async () => {
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    open();
    expect(await screen.findByText('No orders yet')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Place the first order' }).getAttribute('href')).toBe(
      '/',
    );
  });

  it('loads older orders with the cursor, and refreshes from the start', async () => {
    const calls = stubFetch((call) =>
      call.url.includes('after=')
        ? { body: { items: [summary(3)], nextCursor: null } }
        : { body: { items: [summary(1), summary(2)], nextCursor: summary(2).id } },
    );
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older orders' }));
    expect(await screen.findByRole('link', { name: `Order ${summary(3).id}` })).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Orders' })).getAllByRole('listitem'),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('button', { name: 'Load older orders' });
    expect(
      within(screen.getByRole('list', { name: 'Orders' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    expect(calls.map((c) => c.url)).toEqual([
      '/api/orders?limit=20',
      `/api/orders?limit=20&after=${summary(2).id}`,
      '/api/orders?limit=20',
    ]);
  });

  it('shows errors with retry, for the first page and for later pages', async () => {
    let fail = true;
    stubFetch((call) => {
      if (call.url.includes('after='))
        return fail ? { status: 502 } : { body: { items: [summary(3)], nextCursor: null } };
      return fail
        ? new TypeError('fetch failed')
        : { body: { items: [summary(1)], nextCursor: summary(1).id } };
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
    expect(screen.getByRole('list', { name: 'Orders' })).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: `Order ${summary(3).id}` })).toBeTruthy();
  });
});

describe('navigation', () => {
  it('marks the active page, routes client-side, and shows not found', async () => {
    stubFetch((call) => ({
      body: { items: call.url.startsWith('/api/orders') ? [] : [], nextCursor: null },
    }));
    open('/');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(
      within(nav).getByRole('link', { name: 'Place order' }).getAttribute('aria-current'),
    ).toBe('page');
    fireEvent.click(within(nav).getByRole('link', { name: 'Order history' }));
    expect(window.location.pathname).toBe('/orders');
    expect(await screen.findByRole('heading', { name: 'Order history' })).toBeTruthy();
    expect(
      within(nav).getByRole('link', { name: 'Order history' }).getAttribute('aria-current'),
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
