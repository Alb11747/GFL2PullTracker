/** Capture immediately before replacing rows, so scrolling during a fetch is respected. */
export function capturePaginationAnchor(
  button: HTMLElement | undefined,
  viewport: { innerHeight: number; scrollBy: (options: ScrollToOptions) => void } = window
): () => void {
  if (!button) return () => {};
  const before = button.getBoundingClientRect();
  if (before.bottom <= 0 || before.top >= viewport.innerHeight) return () => {};
  return () => {
    if (!button.isConnected) return;
    // Account for native scroll anchoring first; compensate only the remaining movement.
    const delta = button.getBoundingClientRect().top - before.top;
    if (Math.abs(delta) > 1) viewport.scrollBy({ top: delta, behavior: 'instant' });
  };
}
