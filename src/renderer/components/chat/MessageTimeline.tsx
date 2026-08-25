import { ArrowDown } from 'lucide-react';
import type { Ref } from 'react';
import { useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { NavRail } from './NavRail';
import { TimelineRow } from './TimelineRow';

/** 消息列/输入区共用的列宽：随容器宽度阶梯放宽，宽屏不留大片空白 */
export const CHAT_COL =
  'mx-auto w-full max-w-2xl @min-[56rem]:max-w-3xl @min-[72rem]:max-w-4xl @min-[96rem]:max-w-5xl';

/** 贴底判定阈值（px）：与旧实现一致，离底 40px 内视为贴底 */
const AT_BOTTOM_THRESHOLD = 40;

export interface MessageTimelineHandle {
  /** 滚到底并恢复跟随（发送消息后调用） */
  scrollToBottom(): void;
}

interface MessageTimelineProps {
  ref?: Ref<MessageTimelineHandle>;
  items: TimelineItem[];
  busy: boolean;
  error?: string;
  /** 空态标题（项目名） */
  emptyTitle: string;
}

/**
 * 虚拟化消息时间线：Virtuoso 动态测高 + 贴底跟随。
 * 跟随语义（ref-chat-b）：贴底时内容更新自动滚底；用户上滚脱离后停止，滚回底部恢复。
 */
export function MessageTimeline({ ref, items, busy, error, emptyTitle }: MessageTimelineProps) {
  const { t } = useI18n();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);

  // 导航条数据：每条 user 轮次 + 其后首个回答摘要
  const navItems = useMemo(() => {
    const result: { key: string; question: string; answer: string }[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind !== 'user') continue;
      let answer = '';
      for (let j = i + 1; j < items.length; j++) {
        const next = items[j];
        if (next.kind === 'user') break;
        if (next.kind === 'text') {
          answer = next.text;
          break;
        }
      }
      result.push({ key: item.key, question: item.text || '[image]', answer });
    }
    return result;
  }, [items]);

  const scrollToBottom = () => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
    setAtBottom(true);
  };
  useImperativeHandle(ref, () => ({ scrollToBottom }));

  const jumpTo = (key: string) => {
    const index = items.findIndex((item) => item.key === key);
    if (index >= 0) {
      virtuosoRef.current?.scrollToIndex({ index, align: 'start' });
    }
  };

  return (
    <div className="@container relative min-h-0 flex-1">
      <NavRail items={navItems} activeKey={activeNavKey} onJump={jumpTo} />
      {items.length === 0 && !busy ? (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <p className="text-lg font-medium">{emptyTitle}</p>
          <p className="text-sm text-muted-foreground">{t('Ask the agent…')}</p>
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          data={items}
          computeItemKey={(_, item) => item.key}
          // 贴底时新内容自动跟随（含流式增高）；非贴底不抢滚
          followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
          atBottomThreshold={AT_BOTTOM_THRESHOLD}
          atBottomStateChange={setAtBottom}
          initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
          increaseViewportBy={{ top: 600, bottom: 600 }}
          // 可视范围起点附近的 user 轮次作为导航条高亮
          rangeChanged={({ startIndex }) => {
            let current: string | null = null;
            for (let i = 0; i <= Math.min(startIndex + 1, items.length - 1); i++) {
              if (items[i]?.kind === 'user') current = items[i].key;
            }
            setActiveNavKey(current);
          }}
          className="h-full select-text"
          components={{
            Header: () => <div className="h-6" />,
            Footer: () => (
              <div className={cn(CHAT_COL, 'px-4 pb-6 [overflow-wrap:anywhere]')}>
                {busy && <LoadingDots />}
                {error && <p className="text-sm text-destructive whitespace-pre-wrap">{error}</p>}
              </div>
            ),
          }}
          itemContent={(_, item) => (
            <div
              className={cn(CHAT_COL, 'px-4 pb-4 [overflow-wrap:anywhere]')}
              {...(item.kind === 'user' ? { 'data-nav-key': item.key } : {})}
            >
              <TimelineRow item={item} />
            </div>
          )}
        />
      )}
      {!atBottom && items.length > 0 && (
        <button
          type="button"
          onClick={scrollToBottom}
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border bg-background p-2 text-muted-foreground shadow-md transition-colors hover:bg-muted hover:text-foreground"
          title={t('Scroll to bottom')}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

function LoadingDots() {
  return (
    <div className="flex items-center gap-1 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${i * 150}ms` }}
        />
      ))}
    </div>
  );
}
