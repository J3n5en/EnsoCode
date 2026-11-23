import { Quote } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '@/hooks/useViewport';
import { useI18n } from '@/i18n';
import { useSettingsStore } from '@/stores/settings';
import { insertComposerQuote } from './composerMentionBridge';
import {
  buildQuoteSegment,
  type QuoteAnchorRect,
  quoteButtonPosition,
  selectionQuoteText,
} from './quoteSelection';

const BUTTON_SIZE = { width: 72, height: 28 };

/** 视口内的消息操作行 / 模型抬头：按钮不能压在它们上面 */
function visibleObstacles(container: HTMLElement, viewportHeight: number): QuoteAnchorRect[] {
  const rects: QuoteAnchorRect[] = [];
  for (const element of container.querySelectorAll('[data-quote-skip]')) {
    const r = element.getBoundingClientRect();
    if (r.height > 0 && r.bottom > 0 && r.top < viewportHeight) rects.push(r);
  }
  return rects;
}

/** 时间线里选中文字时浮出的「引用」按钮：点击把选区作为引用块放进主输入框 */
export function QuoteSelectionButton({
  containerRef,
}: {
  containerRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const enabled = useSettingsStore((s) => s.quoteSelectionButton);
  const mobile = useIsMobile();
  const [anchor, setAnchor] = useState<{ text: string; top: number; left: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setAnchor(null);
      return;
    }
    const update = () => {
      const container = containerRef.current;
      const selection = window.getSelection();
      const text = container ? selectionQuoteText(selection, container) : null;
      if (!text || !selection || !container) {
        setAnchor(null);
        return;
      }
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const obstacles = visibleObstacles(container, viewport.height);
      setAnchor({ text, ...quoteButtonPosition(rect, viewport, BUTTON_SIZE, mobile, obstacles) });
    };
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [enabled, mobile, containerRef]);

  if (!enabled || !anchor) return null;
  // 挂到 body：时间线祖先上的 transform / containment 会让 fixed 定位偏移
  return createPortal(
    <button
      type="button"
      data-enso="quote-selection"
      title={t('Quote into the input box')}
      // 按下时不能抢走选区，否则 click 时选区已经没了
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        const quote = buildQuoteSegment(anchor.text);
        if (!quote || !insertComposerQuote(quote)) return;
        window.getSelection()?.removeAllRanges();
        setAnchor(null);
      }}
      style={{ top: anchor.top, left: anchor.left, minWidth: BUTTON_SIZE.width }}
      className="fixed z-50 inline-flex h-7 items-center justify-center gap-1 rounded-full border bg-card px-2.5 text-xs text-foreground shadow-float hover:bg-muted"
    >
      <Quote className="h-3 w-3" />
      {t('Quote')}
    </button>,
    document.body
  );
}
