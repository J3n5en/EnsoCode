import {
  DEFAULT_STATUS_LINE_SEGMENTS,
  STATUS_LINE_SEGMENT_IDS,
  type StatusLineSegmentId,
} from '@shared/statusLine';
import type { ModelProvider, OauthAccountUsage, Project } from '@shared/types';
import type { ApprovalMode, ProjectedMessage, ThinkingLevel } from '@shared/types/agent';
import {
  Clock,
  Coins,
  Cpu,
  Database,
  FolderOpen,
  Gauge,
  Hourglass,
  type LucideIcon,
  Repeat,
  Settings2,
  Shield,
  ShieldCheck,
  ShieldOff,
  Tag,
  Users,
  Wallet,
  Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Popover, PopoverPopup, PopoverTrigger } from '@/components/ui/popover';
import { Separator } from '@/components/ui/separator';
import { fetchAccountUsage, USAGE_CACHE_TTL_MS, usageCache } from '@/hooks/useAccountUsage';
import { type TFunction, useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/lib/z-index';
import type { Conversation } from '@/stores/sessions';
import { computeStats, formatDuration, formatTokens } from '@/stores/sessions/stats';
import { useSettingsStore } from '@/stores/settings';
import { StatusLineSettings } from './StatusLineSettings';

interface StatsLineProps {
  messages: ProjectedMessage[];
  conversation: Conversation;
}

/** 段位当前值：`compact` 是状态栏内联展示（紧凑，可为空串走纯 icon），
 *  `full` 是设置弹层预览用的完整句子（不含段名前缀，行内已单独显示段名）。
 *  `percent`：仅 `context` 段在窗口已知时设置，驱动图形环；`critical`：该段是否需要警示色。 */
export interface SegmentValue {
  compact: string;
  full: string;
  percent?: number;
  critical?: boolean;
}

/**
 * 渲染层第二道防线：`statusLineSegments` 持久化后可能被手改/损坏（非数组、混入非法 id、
 * 重复项）。主归一化在 settings 的 rehydrate 边界，这里独立兜底——任何非法输入都收敛成
 * 一个只含权威 id、按首次出现去重、保序的安全数组，防止 `icons[id]` 取到 `undefined`
 * 再渲染 `<Icon/>` 而白屏。
 */
export function sanitizeStatusLineSegments(segments: unknown): StatusLineSegmentId[] {
  const source = Array.isArray(segments) ? segments : DEFAULT_STATUS_LINE_SEGMENTS;
  const validIds = new Set<string>(STATUS_LINE_SEGMENT_IDS);
  const seen = new Set<StatusLineSegmentId>();
  const result: StatusLineSegmentId[] = [];
  for (const id of source) {
    if (typeof id === 'string' && validIds.has(id) && !seen.has(id as StatusLineSegmentId)) {
      seen.add(id as StatusLineSegmentId);
      result.push(id as StatusLineSegmentId);
    }
  }
  return result;
}

/** 段名文案，状态栏 hover title 与设置弹层的行标签共用同一份，⛔ 不要抄第二份 */
export const SEGMENT_LABEL_KEYS: Record<StatusLineSegmentId, string> = {
  model: 'Model',
  approval: 'Approval mode',
  cwd: 'Working directory',
  sessionName: 'Session name',
  coworkers: 'Coworkers',
  tokens: 'Tokens',
  cache: 'Cache hit rate',
  context: 'Context window',
  turns: 'Turns',
  speed: 'Speed',
  duration: 'Duration',
  sessionTime: 'Session time',
  usage: 'Subscription usage',
};

const THINKING_LEVEL_SHORT_KEYS: Record<ThinkingLevel, string> = {
  minimal: 'Min',
  low: 'Low',
  medium: 'Med',
  high: 'High',
  xhigh: 'Extra',
  max: 'Max',
};

const THINKING_LEVEL_FULL_KEYS: Record<ThinkingLevel, string> = {
  minimal: 'Min',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

// 与 ApprovalModePicker.tsx 的 MODE_META 用同一份英文原文 + 同一套 icon 语义，翻译词条已存在
const APPROVAL_LABEL_KEYS: Record<ApprovalMode, string> = {
  supervised: 'Supervised',
  'auto-edits': 'Auto-accept edits',
  full: 'Full access',
};

const APPROVAL_ICONS: Record<ApprovalMode, LucideIcon> = {
  supervised: ShieldCheck,
  'auto-edits': Shield,
  full: ShieldOff,
};

/** 设置弹层里代表每段的 icon（全部 13 段恒有值）；状态栏本体的 `context` 段用图形环
 *  代替这里的图标（见 `ContextRing`），`approval` 的 icon 随档位变化。 */
const SEGMENT_ICONS: Record<Exclude<StatusLineSegmentId, 'approval'>, LucideIcon> = {
  model: Cpu,
  context: Gauge,
  turns: Repeat,
  duration: Clock,
  sessionTime: Hourglass,
  speed: Zap,
  tokens: Coins,
  cache: Database,
  cwd: FolderOpen,
  sessionName: Tag,
  coworkers: Users,
  usage: Wallet,
};

/** 状态栏对「资源即将耗尽」统一用的警戒阈值：占用/额度达到或超过此百分比即判定紧张，标红提示 */
const CRITICAL_PERCENT = 90;

// 订阅额度的缓存/去重已提取到 hooks/useAccountUsage，与 ModelPicker/ProvidersSettings 共享同一份缓存

/** 最近一条带非零 usage 的 assistant 消息的整段 prompt+输出 ≈ 当前上下文水位。
 *  流式中的消息 usage 是空对象（投影成全 0），须跳过，否则会话进行中会显示假的 0% 占用。 */
function latestContextTokens(messages: ProjectedMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const usage = messages[i].role === 'assistant' ? messages[i].usage : undefined;
    if (!usage) continue;
    const total = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
    if (total > 0) return total;
  }
  return null;
}

/** agent 当前正在跑的那一段（还没落进 computeStats 的已完成消息里）的实时时长归属：
 *  最后一条 assistant 消息还没 completedMs → 正在等 LLM；已经 completedMs → 正在等工具/下一步。
 *  非 running 状态不计（空闲时间不算），停跑后这段立即归零、改由 computeStats 的已完成数据接管。 */
function liveRunningDelta(
  conversation: Conversation,
  messages: ProjectedMessage[],
  now: number
): { llm: number; tool: number } {
  if (conversation.status !== 'running') return { llm: 0, tool: 0 };
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== 'assistant' || !message.timing) continue;
    if (message.timing.completedMs === undefined) {
      return { llm: Math.max(0, now - message.timing.stepStartMs), tool: 0 };
    }
    return { llm: 0, tool: Math.max(0, now - message.timing.completedMs) };
  }
  return { llm: 0, tool: 0 };
}

function projectBasename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function truncateTitle(title: string, max: number): string {
  return title.length > max ? `${title.slice(0, max - 1)}…` : title;
}

/** 紧凑倒计时：42m / 3h12m / 4d5h（分钟级精度，够用于「距重置还剩多久」） */
function formatRemaining(ms: number): string {
  if (ms <= 0) return '0m';
  const totalMinutes = Math.round(ms / 60_000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  return `${minutes}m`;
}

/** 紧凑墙钟计时：45s / 2m30s / 3h12m / 4d5h（秒级精度，用于「这件事做了多久」，含空闲） */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${totalSeconds % 60}s`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `${totalHours}h${totalMinutes % 60}m`;
  const days = Math.floor(totalHours / 24);
  return `${days}d${totalHours % 24}h`;
}

/** 每段的 icon（全部 13 段恒有值，供设置弹层无数据时也能画图标）。 */
export function resolveSegmentIcons(
  conversation: Conversation
): Record<StatusLineSegmentId, LucideIcon> {
  return {
    ...SEGMENT_ICONS,
    approval: APPROVAL_ICONS[conversation.approvalMode ?? 'full'],
  };
}

/** 图形化上下文占用环，手写 SVG：一个底环 + 一个按百分比裁切的进度环（circle + strokeDasharray/
 *  strokeDashoffset），比纯数字更直观地传达「还剩多少」。 */
function ContextRing({ percent, critical }: { percent: number; critical: boolean }) {
  const radius = 4.5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="-rotate-90 shrink-0" aria-hidden>
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        strokeWidth="2"
        className="stroke-muted-foreground/25"
      />
      <circle
        cx="6"
        cy="6"
        r={radius}
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - percent / 100)}
        className={critical ? 'stroke-destructive' : 'stroke-muted-foreground'}
      />
    </svg>
  );
}

/** 订阅额度：按 auth accountKey 拉取，模块级缓存 + in-flight 去重节流，⛔ 不每次 render 都发 IPC。
 *  拉取失败或没有账号时返回 undefined，段位在上层整段隐藏。
 *
 * ⚠️ 两条正确性要求（评审 P0/P1）：
 * 1. 返回值与请求它的 accountKey 绑定存储（`{ key, data }`），只在 `state.key === accountKey`
 *    时才对外暴露——账号从 A 切到未命中缓存的 B 时不会继续显示 A 的旧数据，对乱序到达的
 *    历史请求结果同样成立（`cancelled` 只保证不写入，key 校验保证读取侧也不会读错账号）。
 * 2. `now`（调用方共享的 1s tick）进依赖数组，让 TTL 到期后真的会重新检查并刷新，而不是
 *    只在 accountKey 变化那一刻生效一次；每次检查是否过期很便宜，真正的网络请求由
 *    `fetchAccountUsage` 的 in-flight 表去重，不会因为高频检查就并发多次打端点。 */
function useOauthAccountUsage(
  accountKey: string | undefined,
  now: number
): OauthAccountUsage | undefined {
  const [state, setState] = useState<{ key: string; data: OauthAccountUsage } | undefined>(() => {
    if (!accountKey) return undefined;
    const cached = usageCache.get(accountKey);
    return cached ? { key: accountKey, data: cached.data } : undefined;
  });

  // now 只当触发器用（1s tick 到就重新检查 TTL 是否过期），effect 内部不读它的值——
  // biome-ignore lint/correctness/useExhaustiveDependencies: now 是有意的触发依赖，见上
  useEffect(() => {
    if (!accountKey) return;
    let cancelled = false;
    const cached = usageCache.get(accountKey);
    if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
      setState({ key: accountKey, data: cached.data });
      return;
    }
    fetchAccountUsage(accountKey)
      .then((result) => {
        if (!cancelled) setState({ key: accountKey, data: result });
      })
      .catch(() => {
        if (!cancelled) {
          setState((current) => (current?.key === accountKey ? undefined : current));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [accountKey, now]);

  return accountKey && state?.key === accountKey ? state.data : undefined;
}

/**
 * 每段当前值。用完整 `Record`（值允许 `undefined`）而不是 `Partial`——新增段位时如果这里
 * 漏了对应初始化，TS 会因为缺属性报错，而不是像 `Partial` 那样悄悄放过、运行时才发现该段
 * 静默不显示。`undefined` = 该段暂无数据（渲染时整段消失）。
 * Popover 预览展示全部 13 段（用 `icons` 兜底），不看开关状态；
 * 主状态栏按 `statusLineSegments` 数组自身顺序渲染（用户可拖拽排序）。
 */
function buildSegmentValues(
  t: TFunction,
  conversation: Conversation,
  messages: ProjectedMessage[],
  providers: readonly ModelProvider[],
  projects: readonly Project[],
  now: number,
  usageData: OauthAccountUsage | undefined
): Record<StatusLineSegmentId, SegmentValue | undefined> {
  const stats = computeStats(messages);
  const values: Record<StatusLineSegmentId, SegmentValue | undefined> = {
    model: undefined,
    context: undefined,
    turns: undefined,
    duration: undefined,
    sessionTime: undefined,
    speed: undefined,
    tokens: undefined,
    cache: undefined,
    cwd: undefined,
    sessionName: undefined,
    approval: undefined,
    coworkers: undefined,
    usage: undefined,
  };

  if (conversation.lastModelId) {
    const provider = providers.find((p) => p.id === conversation.lastProviderId);
    const label =
      provider?.models.find((m) => m.id === conversation.lastModelId)?.label ??
      conversation.lastModelId;
    const level = conversation.reasoningEnabled ? conversation.thinkingLevel : undefined;
    values.model = {
      compact: level ? `${label}·${t(THINKING_LEVEL_SHORT_KEYS[level])}` : label,
      full: level ? `${label} · ${t(THINKING_LEVEL_FULL_KEYS[level])}` : label,
    };
  }

  const used = latestContextTokens(messages);
  if (used !== null) {
    const window =
      conversation.contextWindow && conversation.contextWindow > 0 ? conversation.contextWindow : 0;
    // 窗口未知时不编造百分比：显示已用 tokens，用 `?` 表示窗口未知，而不是拿一个假窗口凑百分比
    if (window > 0) {
      const percent = Math.min(100, Math.round((used / window) * 100));
      values.context = {
        compact: `${percent}%`,
        full: `${formatTokens(window)} · ${percent}%`,
        percent,
        critical: percent >= CRITICAL_PERCENT,
      };
    } else {
      values.context = {
        compact: `${formatTokens(used)}·?`,
        full: `${formatTokens(used)} · ?`,
      };
    }
  }

  if (stats.steps > 0) {
    values.turns = {
      compact: `${stats.turns}·${stats.steps}`,
      full: t('{{turns}} turns · {{steps}} steps', { turns: stats.turns, steps: stats.steps }),
    };
  }

  const live = liveRunningDelta(conversation, messages, now);
  const totalLlmMs = stats.llmMs + live.llm;
  const totalToolMs = stats.toolMs + live.tool;
  const durationCompact: string[] = [];
  const durationFull: string[] = [];
  if (totalLlmMs >= 1000) {
    durationCompact.push(formatDuration(totalLlmMs));
    durationFull.push(t('LLM {{duration}}', { duration: formatDuration(totalLlmMs) }));
  }
  if (totalToolMs >= 1000) {
    durationCompact.push(formatDuration(totalToolMs));
    durationFull.push(t('Tool calls {{duration}}', { duration: formatDuration(totalToolMs) }));
  }
  if (durationCompact.length > 0) {
    values.duration = { compact: durationCompact.join('·'), full: durationFull.join(' · ') };
  }

  // 会话墙钟：createdAt 只在创建/导入时写一次、resume 不重写，是稳定的「会话开始」时刻；
  // 与 duration（只算 LLM+工具的活跃时长）是两个独立指标，空闲也计入，恒有值
  const sessionElapsed = Math.max(0, now - conversation.createdAt);
  values.sessionTime = {
    compact: formatElapsed(sessionElapsed),
    full: formatElapsed(sessionElapsed),
  };

  const speedCompact: string[] = [];
  const speedFull: string[] = [];
  if (stats.ttftAvgMs !== null) {
    speedCompact.push(formatDuration(stats.ttftAvgMs));
    speedFull.push(
      t('First token avg {{duration}}', { duration: formatDuration(stats.ttftAvgMs) })
    );
  }
  if (stats.tokensPerSecond !== null) {
    speedCompact.push(`${stats.tokensPerSecond}tok/s`);
    speedFull.push(t('{{speed}} tok/s', { speed: stats.tokensPerSecond }));
  }
  if (speedCompact.length > 0) {
    values.speed = { compact: speedCompact.join('·'), full: speedFull.join(' · ') };
  }

  if (stats.inputTokens > 0 || stats.outputTokens > 0) {
    values.tokens = {
      compact: `↑${formatTokens(stats.inputTokens)} ↓${formatTokens(stats.outputTokens)}`,
      full: t('Input {{input}} tok · Output {{output}} tok', {
        input: formatTokens(stats.inputTokens),
        output: formatTokens(stats.outputTokens),
      }),
    };
  }

  if (stats.cacheHitPercent !== null) {
    values.cache = {
      compact: `${stats.cacheHitPercent}%`,
      full: t('Cache hit {{percent}}%', { percent: stats.cacheHitPercent }),
    };
  }

  const project = projects.find((p) => p.id === conversation.projectId);
  if (project) {
    const base = projectBasename(project.path);
    values.cwd = { compact: base, full: project.path };
  }

  if (conversation.title.trim().length > 0) {
    values.sessionName = {
      compact: truncateTitle(conversation.title, 16),
      full: truncateTitle(conversation.title, 60),
    };
  }

  // 恒有值：approvalMode 缺省即 full，纯 icon 展示，无内联文字
  values.approval = {
    compact: '',
    full: t(APPROVAL_LABEL_KEYS[conversation.approvalMode ?? 'full']),
  };

  const coworkerCount = conversation.coworkerIds?.length ?? 0;
  if (coworkerCount > 0) {
    values.coworkers = {
      compact: String(coworkerCount),
      full: t('{{count}} coworkers', { count: coworkerCount }),
    };
  }

  // API-key 条目没有额度概念、拉取失败也不报错在状态栏上，两种情况都整段不产值
  if (usageData && !usageData.error && usageData.windows.length > 0) {
    const windows = usageData.windows;
    const maxPercent = Math.max(...windows.map((w) => w.usedPercent));
    const primary = windows[0];
    // label 来自厂商探测器（外部数据），长度不受我们控制——渲染前先截断，
    // 避免一段没有空格的超长字符串撑破状态栏/浮层的布局
    const primaryLabel = truncateTitle(primary.label, 24);
    const remaining =
      primary.resetsAt !== undefined ? formatRemaining(primary.resetsAt - now) : undefined;
    const extra = windows.length > 1 ? ` +${windows.length - 1}` : '';
    values.usage = {
      compact: `${primaryLabel} ${Math.round(primary.usedPercent)}%${remaining ? `·${remaining}` : ''}${extra}`,
      full: windows
        .map((w) => {
          const rem =
            w.resetsAt !== undefined
              ? ` · ${t('resets in {{remaining}}', { remaining: formatRemaining(w.resetsAt - now) })}`
              : '';
          return `${truncateTitle(w.label, 24)} ${Math.round(w.usedPercent)}%${rem}`;
        })
        .join(' · '),
      critical: maxPercent >= CRITICAL_PERCENT,
    };
  }

  return values;
}

/** composer 下方的会话统计条：段位驱动、以 icon 为主的紧凑呈现，文字标签只在设置弹层里。
 *  段位顺序 = `statusLineSegments` 数组自身顺序（用户可在设置弹层拖拽），预设不进存储，
 *  见 `statusLinePresetOf`。外层恒占一行高度（h-7）：避免统计从无到有时输入框跳动；
 *  全部段位关掉时仍渲染空容器 + hover 齿轮，否则用户关完就再也打不开设置。 */
export function StatsLine({ messages, conversation }: StatsLineProps) {
  const { t } = useI18n();
  const providers = useSettingsStore((state) => state.providers);
  const projects = useSettingsStore((state) => state.projects);
  const rawSegments = useSettingsStore((state) => state.statusLineSegments);
  // 渲染层第二道防线：见 sanitizeStatusLineSegments 注释；useMemo 保持引用稳定，
  // 只在 store 里的原始值真的变化时才重新计算，不会每次 render 都产生新数组打断记忆化。
  const enabledSegments = useMemo(() => sanitizeStatusLineSegments(rawSegments), [rawSegments]);
  const [hoveredId, setHoveredId] = useState<StatusLineSegmentId | null>(null);

  const accountKey = useMemo(() => {
    if (!enabledSegments.includes('usage')) return undefined;
    return providers.find((p) => p.id === conversation.lastProviderId)?.oauthAccountKey;
  }, [enabledSegments, providers, conversation.lastProviderId]);

  // 只在真的需要走时钟的时候起 interval：duration 要 running 中才跳，sessionTime 只要启用就跳
  // （含空闲），usage 只要启用且能解析出账号就跳（驱动 TTL 到期重新拉取，不依赖"已经有数据"，
  // 否则第一次拉取失败/无数据后就再也没有机会重试）；三者共用同一个 1s tick，全不满足时不起
  // 定时器，避免每个会话常驻空转的计时器。
  const [now, setNow] = useState(() => Date.now());
  const needsDurationTick =
    conversation.status === 'running' && enabledSegments.includes('duration');
  const needsSessionTimeTick = enabledSegments.includes('sessionTime');
  const needsUsageTick = enabledSegments.includes('usage') && accountKey !== undefined;
  useEffect(() => {
    if (!needsDurationTick && !needsSessionTimeTick && !needsUsageTick) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [needsDurationTick, needsSessionTimeTick, needsUsageTick]);

  const usageData = useOauthAccountUsage(accountKey, now);

  const icons = useMemo(() => resolveSegmentIcons(conversation), [conversation]);
  const values = useMemo(
    () => buildSegmentValues(t, conversation, messages, providers, projects, now, usageData),
    [t, conversation, messages, providers, projects, now, usageData]
  );

  // 渲染顺序恒按 statusLineSegments 数组自身顺序（用户拖拽排序的落点），⛔ 不要改回按
  // STATUS_LINE_SEGMENT_IDS 声明序 filter —— 那是旧契约，已被拖拽排序需求反转。
  const visibleSegments = enabledSegments.filter((id) => values[id]);

  return (
    <div
      data-slot="stats-line"
      className="group relative flex h-7 items-center justify-center px-1"
    >
      {visibleSegments.length > 0 && (
        <div className="flex min-w-0 flex-nowrap items-center gap-1.5 overflow-hidden">
          {visibleSegments.map((id, index) => {
            const value = values[id];
            if (!value) return null;
            const Icon = icons[id];
            const showRing = id === 'context' && value.percent !== undefined;
            return (
              <span key={id} className="flex shrink-0 items-center gap-1.5">
                {index > 0 && <Separator orientation="vertical" className="h-3" />}
                {/* relative：给下面的浮层提供定位锚点；onMouseEnter/Leave 挂在这一整段
                 * （图标+文字）上，热区覆盖整段——子元素即便有 pointer-events-none 也不影响，
                 * React 的 enter/leave 语义按这个元素的包围盒判定，不依赖具体命中的子节点。 */}
                <span
                  title={`${t(SEGMENT_LABEL_KEYS[id])} · ${value.full}`}
                  onMouseEnter={() => setHoveredId(id)}
                  onMouseLeave={() => setHoveredId((current) => (current === id ? null : current))}
                  className={cn(
                    'relative flex items-center gap-1 text-[11px] tabular-nums',
                    value.critical ? 'text-destructive' : 'text-muted-foreground/70'
                  )}
                >
                  {showRing ? (
                    <ContextRing percent={value.percent ?? 0} critical={Boolean(value.critical)} />
                  ) : (
                    <Icon className="h-3 w-3 shrink-0" />
                  )}
                  {value.compact && <span className="truncate">{value.compact}</span>}
                  {hoveredId === id && (
                    <div
                      style={{ zIndex: Z_INDEX.TOOLTIP }}
                      className="-translate-x-1/2 pointer-events-none absolute bottom-full left-1/2 mb-1.5 w-max max-w-56 overflow-hidden rounded-md border bg-popover px-2 py-1 text-popover-foreground shadow-md"
                    >
                      <span className="break-words font-medium">{t(SEGMENT_LABEL_KEYS[id])}</span>
                      <span className="ml-1 break-words text-muted-foreground">{value.full}</span>
                    </div>
                  )}
                </span>
              </span>
            );
          })}
        </div>
      )}
      <Popover>
        <PopoverTrigger
          aria-label={t('Status line settings')}
          className="-translate-y-1/2 absolute top-1/2 right-1 flex h-5.5 w-5.5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
        >
          <Settings2 className="h-3.5 w-3.5" />
        </PopoverTrigger>
        <PopoverPopup side="top" align="end" className="w-72 [&_[data-slot=popover-viewport]]:p-0">
          <StatusLineSettings icons={icons} values={values} />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
