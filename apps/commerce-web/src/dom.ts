/**
 * Browser APIs that the DOM types declare as always present but that test DOMs such as jsdom,
 * and some older browsers, lack. Missing ones are skipped.
 */
type MaybeScrollable = Omit<Element, 'scrollIntoView'> & {
  scrollIntoView?: Element['scrollIntoView'];
};

export function scrollIntoView(el: Element | null, options: ScrollIntoViewOptions): void {
  (el as MaybeScrollable | null)?.scrollIntoView?.(options);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
