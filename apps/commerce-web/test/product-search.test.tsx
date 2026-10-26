// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { Product } from '../src/api';
import { App } from '../src/App';
import { deferred, product, stubFetch, type Call, type Reply } from './support';

const p = (n: number, name: string, overrides: Partial<Product> = {}) =>
  product(n, { name, ...overrides });
const CATALOG = [
  p(1, 'Lunar Anchor'),
  p(2, 'Brisk Lantern'),
  p(3, 'Lunar Beacon', { stockAvailable: 0 }),
  p(42, 'Quiet Mug', { stockAvailable: 4 }),
];
const MORE = [p(101, 'Lunar Kettle'), p(102, 'Cobalt Tripod')];

/** Paged catalog (limit=12) and the search index (limit=100, two pages by cursor). */
function catalog(extra: (c: Call) => Reply | Error | Promise<Reply> | undefined = () => undefined) {
  return stubFetch((c) => {
    const special = extra(c);
    if (special) return special;
    if (c.url.includes('limit=100&after=SKU-00042'))
      return { body: { items: MORE, nextCursor: null } };
    if (c.url.includes('limit=100')) return { body: { items: CATALOG, nextCursor: 'SKU-00042' } };
    if (c.url.startsWith('/api/products'))
      return { body: { items: CATALOG.slice(0, 2), nextCursor: null } };
    return { status: 500 };
  });
}

const open = () => {
  window.history.replaceState(null, '', '/');
  return render(<App />);
};
const box = () => screen.getByRole<HTMLInputElement>('combobox', { name: 'Search products' });
const type = (value: string) => {
  fireEvent.focus(box());
  fireEvent.change(box(), { target: { value } });
};
const key = (k: string) => {
  fireEvent.keyDown(box(), { key: k });
};
const options = () => screen.queryAllByRole('option');
const optionNames = () => options().map((o) => o.querySelector('.truncate')?.textContent);

describe('product search: matching', () => {
  it('suggests by name and SKU, case-insensitively and partially, best matches first', async () => {
    catalog();
    open();
    type('  LUNAR ');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Lunar Anchor', 'Lunar Beacon', 'Lunar Kettle']);
    });
    expect(box().getAttribute('aria-expanded')).toBe('true');
    type('sku-0004');
    await waitFor(() => {
      expect(optionNames()).toEqual(['Quiet Mug']);
    });
    type('anchor');
    expect(optionNames()).toEqual(['Lunar Anchor']);
    type('ern');
    expect(optionNames()).toEqual(['Brisk Lantern']);
  });

  it('highlights the matching part of the name and SKU', async () => {
    catalog();
    open();
    type('lant');
    await waitFor(() => {
      expect(options()).toHaveLength(1);
    });
    expect([...(options()[0]?.querySelectorAll('mark') ?? [])].map((m) => m.textContent)).toEqual([
      'Lant',
    ]);
    type('00042');
    await waitFor(() => {
      expect(options()[0]?.querySelector('mark')?.textContent).toBe('00042');
    });
  });

  it('shows nothing for a blank query and a clear message for no matches', async () => {
    catalog();
    open();
    type('   ');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(await screen.findByRole('list', { name: 'Products' })).toBeTruthy();
    type('zebra');
    expect(await screen.findByText('No products match “zebra”.')).toBeTruthy();
    expect(await screen.findByText('No products match “zebra”')).toBeTruthy();
    expect(screen.getAllByRole('status').some((s) => s.textContent === 'No products match.')).toBe(
      true,
    );
  });
});

describe('product search: keyboard, pointer and dismissal', () => {
  it('moves with the arrow keys, wraps back to the text, and selects with Enter', async () => {
    const calls = catalog();
    open();
    type('lunar');
    await waitFor(() => {
      expect(options()).toHaveLength(3);
    });
    key('ArrowDown');
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[0]?.id);
    expect(options()[0]?.getAttribute('aria-selected')).toBe('true');
    key('ArrowDown');
    key('ArrowDown');
    key('ArrowDown');
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
    key('ArrowUp');
    expect(box().getAttribute('aria-activedescendant')).toBe(options()[2]?.id);
    key('Enter');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    // The chosen product's card is highlighted and its Add button takes focus; nothing is ordered.
    const card = document.getElementById('product-SKU-00101');
    expect(card?.getAttribute('data-highlighted')).toBe('true');
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Add Lunar Kettle (SKU-00101)');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('Enter with no active suggestion closes the list and keeps the results', async () => {
    catalog();
    open();
    type('lunar');
    await waitFor(() => {
      expect(options()).toHaveLength(3);
    });
    key('Enter');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('heading', { name: '3 results for “lunar”' })).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('listitem'),
    ).toHaveLength(3);
    key('ArrowDown');
    expect(box().getAttribute('aria-expanded')).toBe('true');
  });

  it('closes on Escape and on a click outside, and selects with the mouse or touch', async () => {
    catalog();
    open();
    type('lunar');
    await waitFor(() => {
      expect(options()).toHaveLength(3);
    });
    key('Escape');
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().value).toBe('lunar');
    key('ArrowDown');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    fireEvent.pointerDown(document.body);
    expect(box().getAttribute('aria-expanded')).toBe('false');

    fireEvent.change(box(), { target: { value: 'lunar ' } });
    const option = options()[1] as HTMLElement;
    fireEvent.mouseEnter(option);
    expect(option.getAttribute('aria-selected')).toBe('true');
    // A press inside the list does not dismiss it; the click selects.
    fireEvent.pointerDown(option);
    expect(fireEvent.mouseDown(option)).toBe(false);
    fireEvent.click(option);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('product-SKU-00003')?.getAttribute('data-highlighted')).toBe(
      'true',
    );
    // A sold-out product cannot be added, so its card takes focus instead of a button.
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Lunar Beacon (SKU-00003) is out of stock',
      }).disabled,
    ).toBe(true);
  });

  it('clears the search and returns to the paged catalog', async () => {
    catalog();
    open();
    type('lunar');
    await screen.findByRole('list', { name: 'Search results' });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(box().value).toBe('');
    expect(document.activeElement).toBe(box());
    expect(screen.getByRole('list', { name: 'Products' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Search results' })).toBeNull();
    type('lunar');
    fireEvent.click(await screen.findByRole('button', { name: 'Show all products' }));
    expect(box().value).toBe('');
    expect(screen.getByRole('list', { name: 'Products' })).toBeTruthy();
  });
});

describe('product search: completeness and loading', () => {
  it('reads every catalog page once by cursor, without duplicates, before claiming full coverage', async () => {
    const page2 = deferred();
    const calls = catalog((c) =>
      c.url.includes('limit=100&after=SKU-00042') ? page2.promise : undefined,
    );
    open();
    type('lunar');
    // Only the first index page so far: the results say so.
    await waitFor(() => {
      expect(optionNames()).toEqual(['Lunar Anchor', 'Lunar Beacon']);
    });
    expect(
      screen.getByText(/Loading the catalog for search: 4 products so far\./, { selector: 'p' }),
    ).toBeTruthy();
    type('lunar k');
    type('lunar');
    page2.release({ body: { items: [...MORE, CATALOG[0]], nextCursor: null } });
    await waitFor(() => {
      expect(optionNames()).toEqual(['Lunar Anchor', 'Lunar Beacon', 'Lunar Kettle']);
    });
    expect(screen.queryByText(/Loading the catalog for search/)).toBeNull();
    const index = calls.filter((c) => c.url.includes('limit=100')).map((c) => c.url);
    expect(index).toEqual(['/api/products?limit=100', '/api/products?limit=100&after=SKU-00042']);
  });

  it('reports an index error, keeps what it has, and resumes from the same cursor on retry', async () => {
    let fail = true;
    const calls = catalog((c) =>
      c.url.includes('limit=100&after=SKU-00042') && fail
        ? { status: 503, body: { error: 'internal_error', message: 'database unavailable' } }
        : undefined,
    );
    open();
    type('lunar');
    expect(await screen.findByText('Could not load the whole catalog for search')).toBeTruthy();
    expect(
      screen.getByText(/Search covers only the 4 products loaded before an error\./, {
        selector: 'p',
      }),
    ).toBeTruthy();
    expect(optionNames()).toEqual(['Lunar Anchor', 'Lunar Beacon']);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
    await waitFor(() => {
      expect(optionNames()).toContain('Lunar Kettle');
    });
    expect(calls.filter((c) => c.url.includes('limit=100')).map((c) => c.url)).toEqual([
      '/api/products?limit=100',
      '/api/products?limit=100&after=SKU-00042',
      '/api/products?limit=100&after=SKU-00042',
    ]);
  });

  it('pages long result lists and reveals a selected product beyond the first page', async () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      p(200 + i, `Lunar Item ${String(i).padStart(2, '0')}`),
    );
    stubFetch((c) =>
      c.url.includes('limit=100')
        ? { body: { items: many, nextCursor: null } }
        : { body: { items: [], nextCursor: null } },
    );
    open();
    type('lunar item');
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(within(results).getAllByRole('listitem')).toHaveLength(24);
    fireEvent.click(screen.getByRole('button', { name: 'Show more results (6 more)' }));
    expect(within(results).getAllByRole('listitem')).toHaveLength(30);
    type('lunar item 2');
    type('lunar item');
    expect(
      within(screen.getByRole('list', { name: 'Search results' })).getAllByRole('listitem'),
    ).toHaveLength(24);
    type('item 29');
    key('ArrowDown');
    key('Enter');
    expect(document.getElementById('product-SKU-00229')?.getAttribute('data-highlighted')).toBe(
      'true',
    );
  });

  it('adds a found product to the order without placing it', async () => {
    const calls = catalog();
    open();
    type('quiet');
    await waitFor(() => {
      expect(options()).toHaveLength(1);
    });
    key('ArrowDown');
    key('Enter');
    fireEvent.click(screen.getByRole('button', { name: 'Add Quiet Mug (SKU-00042)' }));
    expect(screen.getByLabelText<HTMLInputElement>('SKU, item 1').value).toBe('SKU-00042');
    expect(document.getElementById('product-SKU-00042')?.textContent).toContain('1 in order');
    expect(document.getElementById('product-SKU-00042')?.textContent).toContain('Only 4 left');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });
});
