import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** A minimal history router: three routes do not justify a routing dependency. */
export function navigate(to: string): void {
  window.history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath(): string {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  return path;
}

export type Route =
  { name: 'place' } | { name: 'orders' } | { name: 'order'; id: string } | { name: 'not_found' };

export function matchRoute(path: string): Route {
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'place' };
  if (p === '/orders') return { name: 'orders' };
  const m = /^\/orders\/([^/]+)$/.exec(p);
  if (m?.[1]) return { name: 'order', id: decodeURIComponent(m[1]) };
  return { name: 'not_found' };
}

export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}
