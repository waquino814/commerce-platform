// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Order } from '../src/api';
import { App } from '../src/App';
import { navigate } from '../src/router';
import { deferred, flush, order, ORDER_ID, stubFetch, type Reply } from './support';

const open = (id = ORDER_ID) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  window.history.replaceState(null, '', `/orders/${id}`);
  return render(<App />);
};
const status = () => document.querySelector('header [data-status]')?.textContent;
const ok = (o: Partial<Order>): Reply => ({ body: order(o) });

describe('order details', () => {
  it('shows every field the API exposes', async () => {
    stubFetch(() =>
      ok({
        status: 'paid',
        paymentReference: 'ch_123',
        processingAttempts: 1,
        chargeAttempts: 1,
        paidAt: '2026-10-25T12:00:04.000Z',
        updatedAt: '2026-10-25T12:00:04.000Z',
        nextAttemptAt: null,
      }),
    );
    open();
    expect(screen.getByRole('status').textContent).toContain('Loading order');
    await flush();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(`Order ${ORDER_ID}`);
    expect(status()).toBe('Paid');
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('Product 42SKU-000422$10.39$20.78');
    expect(table.textContent).toContain('Total$30.85');
    const text = document.body.textContent;
    expect(text).toContain('Test card · approves');
    expect(text).toContain('ch_123');
    expect(text).toContain('Paid2026-10-25 12:00:04 UTC');
    expect(text).toContain('Processing attempts1');
    expect(text).toContain('Final status. Live updates have stopped.');
    expect(text).not.toContain('Next attempt');
    const progress = screen.getByRole('list', { name: 'Order progress' });
    expect(progress.textContent).toBe('Placed (done)Processed (done)Paid (done)');
  });

  it('shows the lifecycle step for each status', async () => {
    const sequence: Reply[] = [
      ok({ status: 'pending' }),
      ok({ status: 'payment_unknown' }),
      ok({ status: 'failed', failureReason: 'payment_declined' }),
    ];
    stubFetch(() => sequence.shift() ?? ok({ status: 'failed' }));
    open();
    const progress = () => screen.getByRole('list', { name: 'Order progress' });
    await flush();
    expect(progress().textContent).toBe('Placed (done)Processing (current)Paid (upcoming)');
    expect(progress().querySelector('[aria-current="step"]')?.textContent).toContain('Processing');
    await flush(2000);
    expect(progress().textContent).toBe('Placed (done)Confirming payment (current)Paid (upcoming)');
    await flush(2000);
    expect(progress().textContent).toBe('Placed (done)Processed (done)Failed (failed)');
    expect(document.body.textContent).toContain('2 products · 3 units');
  });

  it('polls while pending and processing, and stops when the order is paid', async () => {
    const sequence: Reply[] = [
      ok({ status: 'pending' }),
      ok({ status: 'processing', processingAttempts: 1 }),
      ok({ status: 'paid', paidAt: '2026-10-25T12:00:04.000Z' }),
    ];
    const calls = stubFetch(() => sequence.shift() ?? ok({ status: 'paid' }));
    open();
    await flush();
    expect(status()).toBe('Pending');
    expect(document.body.textContent).toContain('Updating live every 2 s');
    await flush(2000);
    expect(status()).toBe('Processing');
    await flush(2000);
    expect(status()).toBe('Paid');
    expect(calls).toHaveLength(3);
    await flush(60_000);
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === `/api/orders/${ORDER_ID}`)).toBe(true);
  });

  it('does not poll an order that is already failed, and explains the failure', async () => {
    const calls = stubFetch(() =>
      ok({
        status: 'failed',
        failureReason: 'out_of_stock',
        failedAt: '2026-10-25T12:00:03.000Z',
        lastError: 'insufficient stock',
      }),
    );
    open();
    await flush();
    expect(status()).toBe('Failed');
    expect(document.body.textContent).toContain('Not enough stock for one or more items.');
    expect(document.body.textContent).toContain('insufficient stock');
    await flush(30_000);
    expect(calls).toHaveLength(1);
  });

  it('keeps polling through payment_unknown', async () => {
    const sequence: Reply[] = [
      ok({ status: 'payment_unknown', reconciliationAttempts: 1 }),
      ok({ status: 'failed', failureReason: 'max_attempts_exceeded' }),
    ];
    stubFetch(() => sequence.shift() ?? ok({ status: 'failed' }));
    open();
    await flush();
    expect(status()).toBe('Confirming payment');
    await flush(2000);
    expect(status()).toBe('Failed');
  });

  it('never overlaps requests: the next poll waits for a slow response', async () => {
    const slow = deferred();
    let n = 0;
    const calls = stubFetch(() => (++n === 2 ? slow.promise : ok({ status: 'pending' })));
    open();
    await flush();
    await flush(2000);
    expect(calls).toHaveLength(2);
    await flush(20_000);
    expect(calls).toHaveLength(2);
    slow.release(ok({ status: 'processing' }));
    await flush();
    expect(status()).toBe('Processing');
    await flush(2000);
    expect(calls).toHaveLength(3);
  });

  it('keeps the last status through transient failures, backing off, then recovers', async () => {
    const sequence: (Reply | Error)[] = [
      ok({ status: 'pending' }),
      { status: 503, body: { error: 'internal_error', message: 'internal server error' } },
      new TypeError('fetch failed'),
      ok({ status: 'paid' }),
    ];
    const calls = stubFetch(() => sequence.shift() ?? ok({ status: 'paid' }));
    open();
    await flush();
    await flush(2000);
    expect(status()).toBe('Pending');
    expect(
      screen.getByText(
        /internal server error Retrying in 4 s\. The status shown is the last one received\./,
      ),
    ).toBeTruthy();
    await flush(3999);
    expect(calls).toHaveLength(2);
    await flush(1);
    expect(calls).toHaveLength(3);
    expect(screen.getByText(/The orders API could not be reached\. Retrying in 8 s/)).toBeTruthy();
    await flush(8000);
    expect(status()).toBe('Paid');
    expect(screen.queryByText(/Retrying/)).toBeNull();
  });

  it('caps the backoff at 30 s', async () => {
    const calls = stubFetch(() => ({ status: 500 }));
    open();
    for (const wait of [0, 4000, 8000, 16_000]) await flush(wait);
    expect(calls).toHaveLength(4);
    expect(screen.getByText(/Retrying in 30 s/)).toBeTruthy();
    await flush(30_000);
    expect(calls).toHaveLength(5);
  });

  it('stops on a missing order or an invalid ID', async () => {
    const calls = stubFetch(() => ({
      status: 404,
      body: { error: 'order_not_found', message: 'order not found' },
    }));
    const view = open();
    await flush();
    expect(screen.getByText('Order not found')).toBeTruthy();
    await flush(30_000);
    expect(calls).toHaveLength(1);
    view.unmount();

    stubFetch(() => ({
      status: 400,
      body: { error: 'validation_error', message: 'request validation failed' },
    }));
    open('not-a-uuid');
    await flush();
    expect(screen.getByText('Not a valid order ID')).toBeTruthy();
  });

  it('says so when live updates stop on a client error after the order loaded', async () => {
    const sequence: Reply[] = [
      ok({ status: 'pending' }),
      { status: 404, body: { error: 'order_not_found', message: 'order not found' } },
    ];
    stubFetch(() => sequence.shift() ?? { status: 404 });
    open();
    await flush();
    await flush(2000);
    expect(status()).toBe('Pending');
    expect(screen.getByText('Live updates stopped: order not found')).toBeTruthy();
  });

  it('stops polling and cancels the request when the user leaves the page', async () => {
    const slow = deferred();
    let n = 0;
    const calls = stubFetch(() => (++n === 2 ? slow.promise : ok({ status: 'pending' })));
    open();
    await flush();
    await flush(2000);
    expect(calls).toHaveLength(2);
    stubFetch(() => ({ body: { items: [], nextCursor: null } }));
    act(() => {
      navigate('/orders');
    });
    expect(calls[1]?.signal?.aborted).toBe(true);
    // Even a late non-terminal answer must not schedule another poll.
    slow.release(ok({ status: 'pending' }));
    await flush(60_000);
    expect(calls).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Your Orders' })).toBeTruthy();
  });
});
