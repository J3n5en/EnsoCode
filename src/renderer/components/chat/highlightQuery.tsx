import { createContext, Fragment, type ReactNode, useContext } from 'react';

export const ChatSearchHighlightContext = createContext({
  query: '',
  activeKey: '',
  activeNth: -1,
});

export function useChatSearchHighlight() {
  return useContext(ChatSearchHighlightContext);
}

const MARK_BASE = 'rounded-[2px] px-0.5 py-px';
export const MARK_OTHER = `${MARK_BASE} bg-yellow-300 text-foreground dark:bg-yellow-500/80`;
export const MARK_ACTIVE = `${MARK_BASE} bg-orange-600 text-white dark:bg-orange-500`;

export function renderHighlighted(
  text: string,
  query: string,
  activeNth: number,
  counter: { n: number }
): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const lower = text.toLowerCase();
  const needle = q.toLowerCase();
  let start = 0;
  let i = lower.indexOf(needle, start);
  if (i < 0) return text;
  const out: ReactNode[] = [];
  while (i >= 0) {
    if (i > start) out.push(text.slice(start, i));
    const nth = counter.n++;
    out.push(
      <mark key={nth} className={nth === activeNth ? MARK_ACTIVE : MARK_OTHER}>
        {text.slice(i, i + q.length)}
      </mark>
    );
    start = i + q.length;
    i = lower.indexOf(needle, start);
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

export function highlightNode(
  node: ReactNode,
  query: string,
  activeNth: number,
  counter: { n: number }
): ReactNode {
  if (node == null || typeof node === 'boolean') return node;
  if (typeof node === 'string' || typeof node === 'number') {
    return renderHighlighted(String(node), query, activeNth, counter);
  }
  if (Array.isArray(node)) {
    return node.map((child, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: 混合 ReactNode 没有稳定 identity
      <Fragment key={index}>{highlightNode(child, query, activeNth, counter)}</Fragment>
    ));
  }
  return node;
}
