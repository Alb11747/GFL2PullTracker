/** Preserve native reload position while lazy routes and local archives rebuild. */
export function preserveReloadScroll() {
  const root = document.documentElement;
  const target = Number(root.dataset.reloadScroll);
  let observer: MutationObserver | undefined;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let restoring = Boolean(root.dataset.reloadScroll);
  const save = () => {
    try {
      sessionStorage.setItem('gfl2.reload-scroll', JSON.stringify({
        path: location.pathname + location.search, y: restoring ? target : window.scrollY,
        height: document.documentElement.scrollHeight, time: Date.now()
      }));
    } catch { /* Keep normal browser behavior when storage is blocked. */ }
  };
  const finish = (restore: boolean) => {
    if (!restoring) return;
    restoring = false;
    observer?.disconnect();
    clearTimeout(settle);
    clearTimeout(deadline);
    delete root.dataset.reloadScroll;
    root.style.removeProperty('--reload-height');
    if (restore) window.scrollTo({ top: target, behavior: 'instant' });
  };
  const cancel = () => finish(false);
  const key = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
  };
  if (restoring) {
    const check = () => {
      clearTimeout(settle);
      settle = setTimeout(() => {
        if (document.querySelector('[aria-busy="true"]')) return;
        // The temporary body minimum is excluded: measure the actual route/footer.
        const contentBottom = Math.max(0, ...Array.from(document.querySelectorAll('main, footer'))
          .map(node => node.getBoundingClientRect().bottom + window.scrollY));
        if (contentBottom >= target + window.innerHeight) finish(true);
      }, 500);
    };
    observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true });
    deadline = setTimeout(() => finish(true), 10000);
    void document.fonts.ready.then(check);
    check();
  }
  window.addEventListener('pagehide', save);
  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('keydown', key);
  window.addEventListener('pointerdown', cancel, { passive: true });
  return () => {
    finish(false);
    window.removeEventListener('pagehide', save);
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    window.removeEventListener('keydown', key);
    window.removeEventListener('pointerdown', cancel);
  };
}
