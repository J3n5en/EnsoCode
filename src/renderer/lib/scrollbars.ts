/**
 * 滚动条不常驻：滚动时给滚动容器打 data-scrolling，停止 idleMs 后撤掉，CSS 只在此时画滑块。
 * scroll 不冒泡，用捕获阶段在 document 上统一监听。
 */
export function installScrollbarActivity(doc: Document = document, idleMs = 800): () => void {
  const timers = new Map<Element, ReturnType<typeof setTimeout>>();
  const onScroll = (event: Event) => {
    const target = event.target;
    const el =
      target && (target as Node).nodeType === 9
        ? (target as Document).documentElement
        : (target as Element | null);
    if (!el || typeof el.setAttribute !== 'function') return;
    el.setAttribute('data-scrolling', '');
    clearTimeout(timers.get(el));
    timers.set(
      el,
      setTimeout(() => {
        timers.delete(el);
        el.removeAttribute('data-scrolling');
      }, idleMs)
    );
  };
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    doc.removeEventListener('scroll', onScroll, { capture: true });
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
