import { ArrowDown, LoaderCircle } from 'lucide-react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import {
  Component,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type ListProps, Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  type HistoryPageChrome,
  historyPageChrome,
  shouldPrefetchOlderHistory,
  type TimelineItem,
} from '@/stores/sessions/timeline';
import { useSettingsStore } from '@/stores/settings';
import { EnsoMark } from './EnsoMark';
import { diffFoldMotion, EMPTY_FOLD_MOTION } from './foldMotion';
import { ChatSearchHighlightContext } from './highlightQuery';
import { NavRail } from './NavRail';
import {
  isCompactRow,
  isToolStepRow,
  ReplyHeader,
  RetryTurnButton,
  TimelineRow,
} from './TimelineRow';
import { nextTimelineReveal } from './timelineReveal';
import {
  nextTimelineRowOrigin,
  type TimelineRowAnchor,
  virtuosoScrollIndex,
} from './timelineRowOrigin';
import { REPLY_ROW_KINDS } from './turnMeta';
import { useFoldedTimeline } from './useFoldedTimeline';
import { WelcomeSuggestions } from './WelcomeSuggestions';

/** 消息列/输入区共用的列：阶梯 max-w + 水平 padding。padding 必须在列上而不是 @container 上，否则两侧查询宽度差 2rem，会在断点附近上下错位。宽模式由 globals.css 去掉 max-w。 */
export const CHAT_COL =
  'enso-chat-col mx-auto w-full max-w-2xl px-4 @min-[56rem]:max-w-3xl @min-[72rem]:max-w-4xl @min-[84rem]:max-w-5xl @min-[96rem]:max-w-6xl @min-[112rem]:max-w-7xl';

/** 探后折叠组动效窗口：超过后行重挂（虚拟化滚回）不再重播 */
const FOLD_MOTION_MS = 1000;

/** 空状态容器：挂载后播放错峰入场（texts-reveal，rAF 后加 is-shown 触发过渡） */
function EmptyReveal({ className, children }: { className?: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  return <div className={cn('t-stagger', shown && 'is-shown', className)}>{children}</div>;
}

/** 贴底判定阈值（px）：与旧实现一致，离底 40px 内视为贴底 */
const AT_BOTTOM_THRESHOLD = 40;

// 稳定引用。库每次渲染都重发 props；按引用去重的输入不能每次都是新对象。
const INITIAL_TOP_MOST_ITEM_INDEX = { index: 'LAST', align: 'end' } as const;
const VIEWPORT_OVERSCAN = { top: 600, bottom: 600 };
const followChatOutput = (isAtBottom: boolean) => (isAtBottom ? 'auto' : false);

function TimelineList({ style, ...props }: ListProps) {
  const hidden = style?.visibility === 'hidden';
  const [reveal, setReveal] = useState(false);
  const hiddenSince = useRef<number | null>(null);
  useEffect(() => {
    const next = nextTimelineReveal(Date.now(), hiddenSince.current, hidden, reveal);
    hiddenSince.current = next.hiddenSince;
    if (next.delayMs === null) return;
    const timer = window.setTimeout(() => setReveal(true), next.delayMs);
    return () => window.clearTimeout(timer);
  }, [hidden, reveal]);
  return <div {...props} style={hidden && reveal ? { ...style, visibility: 'visible' } : style} />;
}

export interface MessageTimelineHandle {
  /** 滚到底并恢复跟随（发送消息 / 点回到底部按钮） */
  scrollToBottom(): void;
  /** 单次贴底，不起循环（流式输出跟随，每次内容更新调一次） */
  pinToBottom(): void;
  /** 当前是否贴底（Virtuoso 的判定，比自己算 scrollHeight 可靠） */
  isAtBottom(): boolean;
  /** 非虚拟化模式的滚动容器（手机端分页需要读写 scrollTop 补偿锚点）；虚拟化下为 null */
  getScroller(): HTMLElement | null;
  /** 滚到指定时间线行（会话内搜索） */
  scrollToKey(key: string): void;
}

interface MessageTimelineProps {
  ref?: Ref<MessageTimelineHandle>;
  items: TimelineItem[];
  busy: boolean;
  /** busy 来自加载（冷会话恢复 / 读历史 / 等快照），脚点显示「加载中」而非「生成中」 */
  loading?: boolean;
  /** 会话 running：进行中的最后一轮工具行不折叠 */
  running: boolean;
  /** 本次 running 的起点，无任何返回时作计时兜底起点 */
  runStartedAt?: number;
  /** 最近一次返回落地时间：运行中计时显示「距上次返回」 */
  lastOutputAt?: number;
  error?: string;
  /** 空态标题（项目名） */
  emptyTitle: string;
  /** 空态副标题；默认「Ask the agent…」，传 '' 隐藏（如委派排队中） */
  emptyDescription?: string;
  /** 空会话建议卡片的点击回调；不传则不显示建议 */
  onSuggestion?: (prompt: string) => void;
  /** 空时间线且 resume 失败时：再走一遍 jsonl 回放 */
  onRetryResume?: () => void;
  /**
   * 是否虚拟化。移动端置 false：真机实测 Virtuoso 在 WebKit 上跳转到底时，
   * 渲染范围切换的中间态列表变短会被浏览器钳位滚动位置，之后模型再也涨不回去，
   * 末条消息永远差一截露不出来（表现为点「回到底部」滚不到底、画面来回跳）。
   * 手机一次只看一个会话、条数有限，直接全量渲染更可靠。
   */
  virtualize?: boolean;
  /**
   * 滚动接近顶部时回调（带锁存，离开顶部区域后才会再次触发）。
   * 桌面 Virtuoso / 手机全量渲染都走这条：上滑加载更早的历史分页。
   */
  onStartReached?: () => void;
  /** 上滑翻页在途：顶部转圈 */
  historyLoading?: boolean;
  /** 还有更早一页；false = 已到第 0 条，顶部给出到头提示 */
  hasOlder?: boolean;
  /** 翻页游标（已加载的最早绝对下标）：变化即新页已落地 */
  olderCursor?: number;
  searchQuery?: string;
  activeHit?: { key: string; nth: number } | null;
}

/**
 * 虚拟化消息时间线：Virtuoso 动态测高 + 贴底跟随。
 * 跟随语义（ref-chat-b）：贴底时内容更新自动滚底；用户上滚脱离后停止，滚回底部恢复。
 */
export function MessageTimeline({
  ref,
  items,
  busy,
  loading = false,
  running,
  runStartedAt,
  lastOutputAt,
  error,
  emptyTitle,
  emptyDescription,
  onSuggestion,
  onRetryResume,
  virtualize = true,
  onStartReached,
  historyLoading = false,
  hasOlder,
  olderCursor,
  searchQuery = '',
  activeHit = null,
}: MessageTimelineProps) {
  const { t } = useI18n();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [fitsViewport, setFitsViewport] = useState(false);
  // ref 镜像：imperative handle 里读，避免闭包拿到旧值
  const atBottomRef = useRef(true);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const settleRef = useRef(0);
  const followSettleRef = useRef(0);
  const observerRef = useRef<ResizeObserver | null>(null);
  /** 内容长高贴底纠正中：忽略这段期间的 scroll 误判，避免展开瞬间被当成用户上滚 */
  const pinningRef = useRef(false);
  /** 用户正在/刚触摸过滚动容器：只有这时才允许解除跟随 */
  const userScrollingRef = useRef(false);
  const userScrollTimerRef = useRef(0);
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);

  /*
   * 导航条高亮必须 rAF 合帧后再落状态：Virtuoso 的 rangeChanged 在测量/布局的
   * 同步阶段触发，大会话恢复（初始定位 LAST + 动态测高 + 回放追加）时 startIndex
   * 会在相邻值间震荡，同步 setState 使每次都触发嵌套重渲染→再测量→再回调，
   * 嵌套更新超过 React 上限直接 #185 崩整棵树（启动黑屏）。rAF 回调不在
   * React 更新流程内，天然斩断嵌套链；一帧内多次 rangeChanged 也只落一次。
   */
  const navFrameRef = useRef(0);
  const scheduleActiveNavKey = useCallback((compute: () => string | null) => {
    cancelAnimationFrame(navFrameRef.current);
    navFrameRef.current = requestAnimationFrame(() => setActiveNavKey(compute()));
  }, []);
  useEffect(() => () => cancelAnimationFrame(navFrameRef.current), []);

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
  // 轮次折叠态：用户显式展开/收起过的轮次（会话内记忆），未记录的轮次按 autoCollapseTurns 默认值
  const [turnOverrides, setTurnOverrides] = useState<ReadonlyMap<string, boolean>>(new Map());
  const autoCollapseTurns = useSettingsStore((s) => s.autoCollapseTurns);
  const collapseCompletedActivity = useSettingsStore((s) => s.collapseCompletedActivity);
  const collapseLiveActivity = useSettingsStore((s) => s.collapseLiveActivity);
  const compact = useSettingsStore((s) => s.compactReadOnlyTools);
  const folded = useFoldedTimeline(items, running, expandedGroups, {
    compact,
    autoCollapseCompletedTurns: autoCollapseTurns,
    collapseCompletedActivity,
    collapseLiveActivity,
    turnOverrides,
  });
  // 探后折叠组动效：渲染期读上一帧 DOM 量折前跨度（提交后旧行已卸载）
  const foldMotionRef = useRef({
    state: EMPTY_FOLD_MOTION,
    collapse: new Map<string, { at: number; height: number; pair: boolean }>(),
    reveal: new Map<string, number>(),
  });
  const foldChildren = useMemo(() => {
    const motion = foldMotionRef.current;
    const row = (key: string) =>
      scrollerRef.current?.querySelector(`[data-nav-key="${CSS.escape(key)}"]`);
    const diff = diffFoldMotion(motion.state, folded, (from, to) => {
      const top = row(from)?.getBoundingClientRect().top;
      const bottom = row(to)?.getBoundingClientRect().bottom;
      return top === undefined || bottom === undefined ? 0 : bottom - top;
    });
    const now = Date.now();
    motion.state = diff.next;
    for (const { key, ...rest } of diff.collapses) motion.collapse.set(key, { at: now, ...rest });
    for (const key of diff.expands) motion.reveal.set(key, now);
    return diff.children;
  }, [folded]);
  // 原点必须用折叠后的行。未折叠的 key 还在，但 Virtuoso 的 data 已经把它们收进组里。
  const rowAnchor = useRef<TimelineRowAnchor | null>(null);
  const rowEpoch = useRef(0);
  /** Virtuoso 最近一次渲染范围的起点（绝对下标）；重挂后作废 */
  const renderedStartRef = useRef<number | null>(null);
  const rowOrigin = nextTimelineRowOrigin(
    rowAnchor.current,
    folded.map((item) => item.key)
  );
  rowAnchor.current = rowOrigin.anchor;
  if (rowOrigin.remount) {
    rowEpoch.current += 1;
    renderedStartRef.current = null;
  }
  const firstItemIndex = rowOrigin.firstItemIndex;
  // 引用必须稳定：TimelineRow 的 memo 比较不含回调
  const setTurnCollapsed = useCallback((key: string, collapsed: boolean) => {
    setTurnOverrides((prev) =>
      prev.get(key) === collapsed ? prev : new Map(prev).set(key, collapsed)
    );
  }, []);

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

  /** 单次贴底：只在确实没贴底时写，贴住后不再碰 scrollTop（反复写会与 Virtuoso 自身的滚动纠正打架） */
  const pinToBottom = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 2) {
      pinningRef.current = true;
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, []);

  /*
   * 滚到底：Virtuoso 动态测高会在滚动后继续修正总高（窄屏换行远多于估算、iOS 测量更慢），
   * 一次写不到位，得持续纠正到高度稳定。三个约束缺一不可，否则表现为屏幕闪烁：
   * 单飞——不取消旧循环的话，流式输出期间每次更新都起一个，叠在一起抢同一个 scrollTop；
   * 只在没贴底时写——贴住后循环空转也不会再动画面；
   * 不混用 scrollToIndex——它算出的落点与直接写 scrollTop 不一致，同帧调用会来回拉扯。
   */
  const scrollToBottom = useCallback(() => {
    cancelAnimationFrame(settleRef.current);
    const deadline = Date.now() + 1200;
    // 用户一碰屏幕就交还控制权：真机上 iOS 的惯性滚动与我们的纠正会互相打架，
    // 表现为持续闪烁；有这道闸，最坏情况下一次触摸即可终止。
    // scroller 惰性读取：换会话重挂时子节点 ref 先于父级赋值，首帧可能还是 null。
    let bound: HTMLElement | null = null;
    const abort = () => {
      cancelAnimationFrame(settleRef.current);
      pinningRef.current = false;
      bound?.removeEventListener('touchstart', abort);
      bound?.removeEventListener('wheel', abort);
    };

    const settle = () => {
      if (userScrollingRef.current) {
        abort();
        return;
      }
      if (!bound && scrollerRef.current) {
        bound = scrollerRef.current;
        bound.addEventListener('touchstart', abort, { passive: true, once: true });
        bound.addEventListener('wheel', abort, { passive: true, once: true });
      }
      pinToBottom();
      // 纠正期间保持贴底判定：iOS 首帧写 scrollTop 会被布局钳位，
      // 钳位触发的 scroll 事件会把 atBottom 误判成 false、中断跟随。
      // ref 与状态必须一起归位：只改 ref 会留下幽灵「回到底部」按钮
      // （状态驱动按钮，同值 setState 被 React 跳过，无额外重渲染）。
      atBottomRef.current = true;
      setAtBottom(true);
      if (Date.now() < deadline) settleRef.current = requestAnimationFrame(settle);
      else abort();
    };
    settle();

    setAtBottom(true);
    atBottomRef.current = true;
  }, [pinToBottom]);
  useEffect(
    () => () => {
      cancelAnimationFrame(settleRef.current);
      cancelAnimationFrame(followSettleRef.current);
      window.clearTimeout(userScrollTimerRef.current);
    },
    []
  );

  /** 用户滚动意图（滚轮/触摸/键盘/拖滚动条）：只有这期间的离底才算用户上滚，两条渲染路径共用 */
  const holdUserScroll = () => {
    userScrollingRef.current = true;
    window.clearTimeout(userScrollTimerRef.current);
  };
  const releaseUserScroll = () => {
    window.clearTimeout(userScrollTimerRef.current);
    userScrollTimerRef.current = window.setTimeout(() => {
      userScrollingRef.current = false;
    }, 400);
  };
  const markUserScroll = () => {
    holdUserScroll();
    releaseUserScroll();
  };
  /** 程序跳转（导航/搜索）主动离底：先解除跟随，否则离底会被当成内容收缩拉回底部 */
  const releaseFollow = () => {
    cancelAnimationFrame(settleRef.current);
    cancelAnimationFrame(followSettleRef.current);
    pinningRef.current = false;
    atBottomRef.current = false;
    setAtBottom(false);
  };

  /*
   * 全量渲染下的跟随：内容常在提交之后才继续长高（markdown 渲染、代码高亮、图片），
   * 只在数据变化时贴一次会漏掉这部分，一旦漏出超过贴底阈值就判定为“用户已上滚”，
   * 跟随就此中断。盯住内容高度，长高即补贴底。
   * 用回调 ref 而非 effect：挂载时快照往往还没到（列表是加载态、节点不存在），
   * effect 只跑一次会永远绑不上。
   */
  const attachContent = useCallback(
    (el: HTMLDivElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      if (!el) return;
      const observer = new ResizeObserver(() => {
        if (!atBottomRef.current && !pinningRef.current) return;
        /*
         * 末条 edit/write 默认展开时高度一次涨几百 px。overflow-anchor 会钉住工具头，
         * 单次写 scrollTop 又可能被 iOS 钳在半截；钳位 scroll 再把 atBottom 打成 false，
         * 跟随停在工具开头、底下还露一截。短帧跟贴，避免每次流式增高都重启 1.2s 循环。
         */
        cancelAnimationFrame(followSettleRef.current);
        let frames = 8;
        const tick = () => {
          pinToBottom();
          const scroller = scrollerRef.current;
          const leftover = scroller
            ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
            : 0;
          if (leftover <= 2) return;
          if (--frames > 0) followSettleRef.current = requestAnimationFrame(tick);
          else scrollToBottom();
        };
        tick();
      });
      observer.observe(el);
      observerRef.current = observer;
      /*
       * 内容挂载 = 换会话重挂或快照首次到达。此时必须用纠正循环而不是单次贴底：
       * iOS 上大会话首帧写 scrollTop 时布局未完成会被钳位停在半截，钳位滚动
       * 事件再把 atBottom 判成 false，跟随从此中断（表现为切会话跳到中间）。
       */
      scrollToBottom();
    },
    [pinToBottom, scrollToBottom]
  );
  useEffect(() => () => observerRef.current?.disconnect(), []);
  const foldedIndexOf = (key: string): number =>
    folded.findIndex(
      (item) => item.key === key || (item.kind === 'tool-group' && groupContainsKey(item, key))
    );
  const scrollToFoldedKey = (key: string): void => {
    if (!virtualize) {
      scrollerRef.current
        ?.querySelector(`[data-nav-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: 'center' });
      return;
    }
    const index = foldedIndexOf(key);
    if (index >= 0) {
      // scrollToIndex 吃 data 相对下标（详见 virtuosoScrollIndex）；叠 firstItemIndex 会被钳到末行
      virtuosoRef.current?.scrollToIndex({
        index: virtuosoScrollIndex(firstItemIndex, index),
        align: 'center',
      });
    }
  };
  /** 目标藏在折叠轮次里：先展开，等 folded 重算后再滚动（同步滚动拿到的是旧 folded / 旧 DOM） */
  const pendingJumpRef = useRef<string | null>(null);
  const jumpTo = (key: string) => {
    releaseFollow();
    if (foldedIndexOf(key) >= 0) {
      pendingJumpRef.current = null;
      scrollToFoldedKey(key);
      return;
    }
    let ownerTurnKey: string | null = null;
    let found = false;
    for (const item of items) {
      if (item.kind === 'user') ownerTurnKey = item.key;
      if (item.key === key) {
        found = true;
        break;
      }
    }
    if (!found || !ownerTurnKey) return;
    pendingJumpRef.current = key;
    setTurnCollapsed(ownerTurnKey, false);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在 folded 重算后消费待跳转 key
  useLayoutEffect(() => {
    const key = pendingJumpRef.current;
    if (!key || foldedIndexOf(key) < 0) return;
    pendingJumpRef.current = null;
    scrollToFoldedKey(key);
  }, [folded]);

  useImperativeHandle(ref, () => ({
    scrollToBottom,
    pinToBottom,
    isAtBottom: () => atBottomRef.current,
    getScroller: () => (virtualize ? null : scrollerRef.current),
    scrollToKey: jumpTo,
  }));

  // 顶部触发锁存：进入顶部区域只触发一次，滚离后解锁（避免加载期间连环触发）。
  // 游标或 firstItemIndex 变了 = 新页已落地，必须立刻解锁，否则停在第一页。
  const startReachedLatch = useRef(false);
  const pageKey = `${olderCursor}:${firstItemIndex}`;
  const latchedPageKey = useRef(pageKey);
  if (latchedPageKey.current !== pageKey) {
    latchedPageKey.current = pageKey;
    startReachedLatch.current = false;
  }
  const requestOlder = () => {
    if (!onStartReached || startReachedLatch.current) return;
    startReachedLatch.current = true;
    onStartReached();
  };
  /*
   * Virtuoso 的 startReached 按首行绝对下标去重：新页整段并进首行过程组、或整页只有孤立
   * toolResult 时 firstItemIndex 不动，它不会再报，停在半截。落页后首行仍在渲染范围就接着翻。
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在新页落地 / 加载结束时判定
  useEffect(() => {
    if (virtualize && !historyLoading && renderedStartRef.current === firstItemIndex) {
      requestOlder();
    }
  }, [olderCursor, historyLoading]);

  // 两条渲染路径（虚拟化 / 全量）共用，保证外观完全一致
  const searchHighlight = useMemo(
    () => ({
      query: searchQuery,
      activeKey: activeHit?.key ?? '',
      activeNth: activeHit?.nth ?? -1,
    }),
    [searchQuery, activeHit?.key, activeHit?.nth]
  );

  // 精简模式：探索类行（组头/只读/思考）之间贴紧排；正文→探索 也收紧（正文自带 hover 操作条占位），
  // 探索→正文留一点距离
  const rowGap = (item: TimelineItem, index: number): string => {
    const next = folded[index + 1];
    // 相邻的工具行贴紧，连成一段日志
    if (next !== undefined && isToolStepRow(item) && isToolStepRow(next)) return 'pb-0';
    if (!compact) return 'pb-4';
    const nextCompact = next !== undefined && isCompactRow(next);
    if (isCompactRow(item)) return nextCompact ? 'pb-1' : 'pb-2';
    return item.kind === 'text' && nextCompact ? 'pb-1' : 'pb-4';
  };
  const renderRow = (item: TimelineItem, index: number) => {
    const prev = folded[index - 1];
    const replyHead =
      prev?.kind === 'user' && !prev.collapsed && REPLY_ROW_KINDS.has(item.kind) ? prev : undefined;
    const now = Date.now();
    const collapse = foldMotionRef.current.collapse.get(item.key);
    const folding = collapse && now - collapse.at < FOLD_MOTION_MS ? collapse : undefined;
    const child = foldChildren.get(item.key);
    const revealAt = child && foldMotionRef.current.reveal.get(child.group);
    const revealing = child && revealAt !== undefined && now - revealAt < FOLD_MOTION_MS;
    return (
      <div
        key={item.key}
        data-nav-key={item.key}
        data-fold-collapse={folding ? (folding.pair ? 'pair' : 'toggle') : undefined}
        style={
          folding
            ? ({ '--fold-from': `${folding.height}px` } as CSSProperties)
            : revealing
              ? ({ '--fold-i': child.index } as CSSProperties)
              : undefined
        }
        className={cn(
          CHAT_COL,
          rowGap(item, index),
          revealing && 't-fold-reveal',
          '[overflow-wrap:anywhere]'
        )}
      >
        {replyHead && (
          <ReplyHeader
            model={replyHead.replyModel}
            at={replyHead.replyAt}
            privacyMask={replyHead.replyPrivacyMask}
          />
        )}
        <RowErrorBoundary itemKey={item.key}>
          <TimelineRow item={item} onToggleGroup={toggleGroup} onToggleTurn={setTurnCollapsed} />
        </RowErrorBoundary>
      </div>
    );
  };
  const everHadOlderRef = useRef(false);
  if (hasOlder === true) everHadOlderRef.current = true;
  const pageChrome = historyPageChrome(
    items.length > 0,
    historyLoading,
    hasOlder,
    everHadOlderRef.current,
    !virtualize && fitsViewport
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: firstItemIndex / 行数只作「内容变了」信号，effect 内重测 scroller
  useLayoutEffect(() => {
    if (virtualize) {
      setFitsViewport(false);
      return;
    }
    const el = scrollerRef.current;
    setFitsViewport(
      !!el &&
        shouldPrefetchOlderHistory(
          hasOlder === true,
          historyLoading,
          el.scrollHeight,
          el.clientHeight
        )
    );
  }, [virtualize, hasOlder, historyLoading, firstItemIndex, folded.length, items.length]);
  const chrome: TimelineChrome = {
    pageChrome,
    onLoadMore: pageChrome === 'more' ? requestOlder : undefined,
    busy,
    loading: !!loading,
    since: loading ? undefined : (lastOutputAt ?? runStartedAt),
    error,
    onRetryResume,
  };

  return (
    <ChatSearchHighlightContext.Provider value={searchHighlight}>
      <div
        data-enso="timeline"
        className="@container relative min-h-0 flex-1"
        onWheel={markUserScroll}
        onKeyDown={markUserScroll}
        onTouchStart={holdUserScroll}
        onTouchEnd={releaseUserScroll}
        onPointerDown={(e) => {
          // 只认滚动条拖拽（落点即滚动容器本身）；点行内按钮不算滚动意图
          if (e.target !== scrollerRef.current) return;
          holdUserScroll();
          window.addEventListener('pointerup', releaseUserScroll, { once: true });
        }}
      >
        <NavRail items={navItems} activeKey={activeNavKey} onJump={jumpTo} />
        {items.length === 0 && !busy ? (
          <EmptyReveal className="flex h-full flex-col items-center justify-center gap-2 overflow-y-auto px-4 text-center">
            <span className="t-stagger-line t-stagger-line--1 mb-3">
              <span className="flex size-11 items-center justify-center rounded-[13px] border border-brand/20 bg-brand/8 text-brand dark:bg-brand/14">
                <EnsoMark className="size-6" />
              </span>
            </span>
            <p className="t-stagger-line t-stagger-line--1 text-[22px] font-semibold tracking-tight">
              {emptyTitle}
            </p>
            {error ? (
              <>
                <p className="t-stagger-line t-stagger-line--2 max-w-md text-sm text-destructive whitespace-pre-wrap">
                  {t(error)}
                </p>
                {onRetryResume && (
                  <Button size="sm" variant="outline" onClick={onRetryResume}>
                    {t('Retry resume')}
                  </Button>
                )}
              </>
            ) : (
              <>
                {emptyDescription !== '' && (
                  <p className="t-stagger-line t-stagger-line--2 text-sm text-muted-foreground">
                    {emptyDescription ?? t('Ask the agent…')}
                  </p>
                )}
                {onSuggestion && (
                  <div className="t-stagger-line t-stagger-line--3 mt-5 w-full">
                    <WelcomeSuggestions onPick={onSuggestion} />
                  </div>
                )}
              </>
            )}
          </EmptyReveal>
        ) : items.length === 0 && error ? (
          <EmptyReveal className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <p className="t-stagger-line t-stagger-line--1 max-w-md text-sm text-destructive whitespace-pre-wrap">
              {t(error)}
            </p>
            {onRetryResume && (
              <Button size="sm" variant="outline" onClick={onRetryResume}>
                {t('Retry resume')}
              </Button>
            )}
          </EmptyReveal>
        ) : items.length === 0 ? (
          // spawn/resume 期间（历史消息尚未回放）：明确的加载态，不留空白页
          <div
            data-timeline-loading=""
            className="flex h-full flex-col items-center justify-center gap-2.5 text-center"
          >
            <LoaderCircle className="h-5 w-5 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t('Preparing session…')}</p>
          </div>
        ) : !virtualize ? (
          <div
            ref={(el) => {
              scrollerRef.current = el;
            }}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (pinningRef.current) {
                pinningRef.current = false;
                atBottomRef.current = true;
                setAtBottom(true);
                return;
              }
              /*
               * 进行中的 write/edit 会先以标题贴底、再突然插入 max-h-96 正文。
               * 浏览器会为这次长高发一次非用户 scroll（钉住工具头），若据此解除跟随，
               * 画面就停在工具开头。完成态不再默认展开，所以只有 loading 才复现。
               */
              if (!userScrollingRef.current) {
                if (atBottomRef.current) pinToBottom();
                return;
              }
              const value = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
              if (value !== atBottomRef.current) {
                atBottomRef.current = value;
                setAtBottom(value);
              }
              if (onStartReached) {
                if (el.scrollTop < 80 && !startReachedLatch.current) {
                  startReachedLatch.current = true;
                  onStartReached();
                } else if (el.scrollTop > 240) {
                  startReachedLatch.current = false;
                }
              }
            }}
            className="h-full select-text overflow-y-auto [overflow-anchor:none]"
          >
            <div ref={attachContent}>
              <TimelineHeader context={chrome} />
              {folded.map((item, index) => renderRow(item, index))}
              <TimelineFooter context={chrome} />
            </div>
          </div>
        ) : (
          <Virtuoso
            key={rowEpoch.current}
            ref={virtuosoRef}
            data={folded}
            // 不用首条长消息探测整段高度，否则初始定位反复校正，正文隐藏只剩脚点。
            defaultItemHeight={80}
            computeItemKey={(_, item) => item.key}
            firstItemIndex={firstItemIndex}
            startReached={requestOlder}
            // 贴底时新内容自动跟随（含流式增高）；非贴底不抢滚
            followOutput={followChatOutput}
            atBottomThreshold={AT_BOTTOM_THRESHOLD}
            atBottomStateChange={(value) => {
              /*
               * 非用户滚动导致的离底 = 内容高度变化：流式思考单次增高超过阈值，或思考收起后
               * 浏览器钳位 scrollTop、Virtuoso 再按「上滚」补偿一整段，视口落到本轮开头。
               * 此前贴底就重新贴回去，不解除跟随。
               */
              if (!value && atBottomRef.current && !userScrollingRef.current) {
                scrollToBottom();
                return;
              }
              setAtBottom(value);
              atBottomRef.current = value;
            }}
            increaseViewportBy={VIEWPORT_OVERSCAN}
            initialTopMostItemIndex={INITIAL_TOP_MOST_ITEM_INDEX}
            // 可视范围起点附近的 user 轮次作为导航条高亮
            rangeChanged={({ startIndex }) => {
              renderedStartRef.current = startIndex;
              if (startIndex > firstItemIndex + 4) startReachedLatch.current = false;
              scheduleActiveNavKey(() => {
                const dataIndex = Math.max(0, startIndex - firstItemIndex);
                let current: string | null = null;
                for (let i = 0; i <= Math.min(dataIndex + 1, folded.length - 1); i++) {
                  if (folded[i]?.kind === 'user') current = folded[i].key;
                }
                return current;
              });
            }}
            scrollerRef={(el) => {
              scrollerRef.current = el instanceof HTMLElement ? el : null;
            }}
            className="h-full select-text"
            context={chrome}
            components={TIMELINE_COMPONENTS}
            // Virtuoso 传入的是含 firstItemIndex 的绝对下标，换算回 folded 下标
            itemContent={(index, item) => renderRow(item, index - firstItemIndex)}
          />
        )}
        {!atBottom && items.length > 0 && (
          <button
            type="button"
            onClick={scrollToBottom}
            className="absolute bottom-4 left-1/2 z-10 inline-flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-card px-3 text-xs text-muted-foreground shadow-float transition-colors hover:text-foreground"
          >
            <ArrowDown className="h-3 w-3" />
            {t('Scroll to bottom')}
          </button>
        )}
      </div>
    </ChatSearchHighlightContext.Provider>
  );
}

function groupContainsKey(
  group: Extract<TimelineItem, { kind: 'tool-group' }>,
  key: string
): boolean {
  return group.children.some(
    (child) => child.key === key || (child.kind === 'tool-group' && groupContainsKey(child, key))
  );
}

function HistoryPageHeader({
  chrome,
  onLoadMore,
}: {
  chrome: HistoryPageChrome;
  onLoadMore?: () => void;
}) {
  const { t } = useI18n();
  if (chrome === 'none') return <div className="h-6" />;
  return (
    <div className={cn(CHAT_COL, 'flex items-center justify-center gap-2 py-3')}>
      {chrome === 'loading' ? (
        <>
          <LoaderCircle className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          <p className="text-xs text-muted-foreground">{t('Loading earlier messages…')}</p>
        </>
      ) : chrome === 'more' ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={onLoadMore}
        >
          {t('Load earlier messages')}
        </button>
      ) : (
        <p className="text-xs text-muted-foreground">{t('Beginning of conversation')}</p>
      )}
    </div>
  );
}

type TimelineChrome = {
  pageChrome: HistoryPageChrome;
  onLoadMore?: () => void;
  busy: boolean;
  loading: boolean;
  since?: number;
  error?: string;
  onRetryResume?: () => void;
};

function TimelineHeader({ context }: { context: TimelineChrome }) {
  return <HistoryPageHeader chrome={context.pageChrome} onLoadMore={context.onLoadMore} />;
}

function TimelineFooter({ context }: { context: TimelineChrome }) {
  const { t } = useI18n();
  const { busy, loading, since, error, onRetryResume } = context;
  return (
    <div className={cn(CHAT_COL, 'pb-6 [overflow-wrap:anywhere]')}>
      {busy && (
        <div className="flex min-h-[26px] items-center gap-2 text-[13px]">
          <LoadingDots />
          <span className="t-shimmer" data-text={loading ? t('Loading…') : t('Working…')}>
            {loading ? t('Loading…') : t('Working…')}
          </span>
          {since !== undefined && <ElapsedTimer since={since} />}
        </div>
      )}
      {error && (
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-sm text-destructive whitespace-pre-wrap">{t(error)}</p>
          <RetryTurnButton />
          {onRetryResume && (
            <Button size="sm" variant="outline" onClick={onRetryResume}>
              {t('Retry resume')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Virtuoso 把 components 当组件类型，每次渲染换新函数会整段重挂，运行中的动画随之重头开始
const TIMELINE_COMPONENTS = { List: TimelineList, Header: TimelineHeader, Footer: TimelineFooter };

function LoadingDots() {
  return (
    <span className="relative flex size-[22px] shrink-0 items-center justify-center">
      <span className="absolute size-2 animate-ping rounded-full bg-brand/50" />
      <span className="relative size-2 rounded-full bg-brand" />
    </span>
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
