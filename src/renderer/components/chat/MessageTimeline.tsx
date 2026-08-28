import { ArrowDown, LoaderCircle } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { foldTimeline, type TimelineItem } from '@/stores/sessions/timeline';
import { NavRail } from './NavRail';
import { TimelineRow } from './TimelineRow';

/** 消息列/输入区共用的列：阶梯 max-w + 水平 padding。padding 必须在列上而不是 @container 上，否则两侧查询宽度差 2rem，会在断点附近上下错位。 */
export const CHAT_COL =
  'mx-auto w-full max-w-2xl px-4 @min-[56rem]:max-w-3xl @min-[72rem]:max-w-4xl @min-[96rem]:max-w-5xl';

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
  /** 会话 running：进行中的最后一轮工具行不折叠 */
  running: boolean;
  /** 本次 running 的起点，驱动运行中计时器 */
  runStartedAt?: number;
  error?: string;
  /** 空态标题（项目名） */
  emptyTitle: string;
}

/**
 * 虚拟化消息时间线：Virtuoso 动态测高 + 贴底跟随。
 * 跟随语义（ref-chat-b）：贴底时内容更新自动滚底；用户上滚脱离后停止，滚回底部恢复。
 */
export function MessageTimeline({
  ref,
  items,
  busy,
  running,
  runStartedAt,
  error,
  emptyTitle,
}: MessageTimelineProps) {
  const { t } = useI18n();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);

  // 工具组展开态：会话内记忆（组件随会话 key 重挂自动清零）
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const folded = useMemo(
    () => foldTimeline(items, running, expandedGroups),
    [items, running, expandedGroups]
  );

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
    const index = folded.findIndex((item) => item.key === key);
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
      ) : items.length === 0 ? (
        // spawn/resume 期间（历史消息尚未回放）：明确的加载态，不留空白页
        <div className="flex h-full flex-col items-center justify-center gap-2.5 text-center">
          <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{t('Preparing session…')}</p>
        </div>
      ) : (
        <Virtuoso
          ref={virtuosoRef}
          data={folded}
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
            for (let i = 0; i <= Math.min(startIndex + 1, folded.length - 1); i++) {
              if (folded[i]?.kind === 'user') current = folded[i].key;
            }
            setActiveNavKey(current);
          }}
          className="h-full select-text"
          components={{
            Header: () => <div className="h-6" />,
            Footer: () => (
              <div className={cn(CHAT_COL, 'pb-6 [overflow-wrap:anywhere]')}>
                {busy && (
                  <div className="flex items-center gap-2.5">
                    <LoadingDots />
                    {runStartedAt !== undefined && <ElapsedTimer since={runStartedAt} />}
                  </div>
                )}
                {error && (
                  <p className="text-sm text-destructive whitespace-pre-wrap">{t(error)}</p>
                )}
              </div>
            ),
          }}
          itemContent={(_, item) => (
            <div
              className={cn(CHAT_COL, 'pb-4 [overflow-wrap:anywhere]')}
              {...(item.kind === 'user' ? { 'data-nav-key': item.key } : {})}
            >
              <RowErrorBoundary itemKey={item.key}>
                <TimelineRow item={item} onToggleGroup={toggleGroup} />
              </RowErrorBoundary>
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

/** 秒级时长：45s / 2m42s */
const formatElapsed = (ms: number): string => {
  const whole = Math.max(0, Math.round(ms / 1000));
  if (whole < 60) return `${whole}s`;
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
};

/** 运行中计时器：memo 隔离，每秒只重渲染这一个小组件，不波及 Virtuoso 列表 */
const ElapsedTimer = memo(function ElapsedTimer({ since }: { since: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
      {formatElapsed(Date.now() - since)}
    </span>
  );
});

/** 单行渲染兜底：一条消息渲染崩溃不拖垮整个时间线 */
class RowErrorBoundary extends Component<
  { itemKey: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidUpdate(prev: { itemKey: string }): void {
    // 行内容更换（同槽位新消息）时给新内容重试机会
    if (prev.itemKey !== this.props.itemKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          message render failed · {this.props.itemKey}
        </p>
      );
    }
    return this.props.children;
  }
}
