import type { TodoItem, TurnPerf } from '@shared/types/agent';
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDot,
  Copy,
  ListTodo,
  LoaderCircle,
  Target,
  TerminalSquare,
  Undo2,
} from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useSessionsStore } from '@/stores/sessions';
import { formatDuration } from '@/stores/sessions/stats';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { EditDiff } from './EditDiff';
import { Markdown } from './Markdown';
import { ReadFileView } from './ReadFileView';
import { TerminalOutput } from './TerminalOutput';
import { ZoomableImage } from './ZoomableImage';

const perfEqual = (a?: TurnPerf, b?: TurnPerf): boolean =>
  a === b || (!!a && !!b && a.runMs === b.runMs && a.ttftMs === b.ttftMs && a.tps === b.tps);

interface TimelineRowProps {
  item: TimelineItem;
  /** tool-group 组头点击展开/收拢 */
  onToggleGroup?: (key: string) => void;
}

/**
 * 按内容字段比较：buildTimeline 每次产出新 item 对象，直接 memo 无效。
 * 长对话下这层比较挡住了未变行的 markdown 重解析与 DOM 重建。
 * onToggleGroup 引用不参与比较（父级保证语义稳定）。
 */
function itemEqual(prev: TimelineRowProps, next: TimelineRowProps): boolean {
  const a = prev.item;
  const b = next.item;
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  switch (a.kind) {
    case 'user': {
      if (b.kind !== 'user') return false;
      if (a.text !== b.text || a.images.length !== b.images.length) return false;
      return a.images.every((image, i) => image === b.images[i]);
    }
    case 'text':
    case 'thinking':
      return (
        b.kind === a.kind &&
        a.text === b.text &&
        a.streaming === b.streaming &&
        (a.kind !== 'text' ||
          (b.kind === 'text' && perfEqual(a.perf, b.perf) && a.timestamp === b.timestamp)) &&
        (a.kind !== 'thinking' || (b.kind === 'thinking' && a.durationMs === b.durationMs))
      );
    case 'tool':
      return (
        b.kind === 'tool' &&
        a.state === b.state &&
        a.name === b.name &&
        a.summary === b.summary &&
        a.output === b.output &&
        a.edits === b.edits &&
        a.todos === b.todos &&
        a.durationMs === b.durationMs &&
        a.agentMeta === b.agentMeta
      );
    case 'tool-group':
      return (
        b.kind === 'tool-group' &&
        a.expanded === b.expanded &&
        a.count === b.count &&
        a.stats.commands === b.stats.commands &&
        a.stats.reads === b.stats.reads &&
        a.stats.searches === b.stats.searches &&
        a.stats.others === b.stats.others
      );
    case 'error':
      return b.kind === 'error' && a.text === b.text;
    case 'task-note':
      return b.kind === 'task-note' && a.detail === b.detail;
  }
}

/** 系统合成的整块注入消息（coworker 雇佣通知 / 后台任务提醒） */
const SYNTHETIC_BLOCK =
  /^<(agent-notification|goal-continuation|coworker-hired|coworker-dismissed|background-task-update)>\n?([\s\S]*?)\n?<\/\1>\s*$/;
/** coworker 首条的角色前缀 */
const ROLE_PREFIX = /^<role>\n?([\s\S]*?)\n?<\/role>\s*/;
/** 主 agent 发给 coworker 的消息包裹 */
const MAIN_AGENT_BLOCK =
  /^<message-from-main-agent>\n?([\s\S]*?)\n?<\/message-from-main-agent>\s*$/;

/** 用户气泡：识别合成标记,渲染成系统事件行 / 角色块 / 来源徽章而非原始 XML */
function UserText({ text }: { text: string }) {
  const { t } = useI18n();
  const block = SYNTHETIC_BLOCK.exec(text);
  if (block) {
    return (
      <div className="flex w-full items-start gap-2 rounded-lg border border-dashed border-border/60 px-3 py-2 text-xs text-muted-foreground">
        {block[1].startsWith('coworker-') || block[1] === 'agent-notification' ? (
          <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        ) : (
          <TerminalSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        )}
        <span className="whitespace-pre-wrap">{block[2]}</span>
      </div>
    );
  }
  const role = ROLE_PREFIX.exec(text);
  const rest = role ? text.slice(role[0].length) : text;
  const fromMain = MAIN_AGENT_BLOCK.exec(rest);
  const body = fromMain ? fromMain[1] : rest;
  return (
    <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">
      {fromMain && (
        <p className="mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {t('From main agent')}
        </p>
      )}
      {role && (
        <div className="mb-2 rounded-md bg-background/60 px-2.5 py-1.5 text-xs text-muted-foreground">
          <span className="font-semibold">{t('Role')}</span> · {role[1]}
        </div>
      )}
      {body}
    </div>
  );
}

export const TimelineRow = memo(function TimelineRow({ item, onToggleGroup }: TimelineRowProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="group/user flex flex-col items-end gap-1.5">
          {item.images.map((image, index) => (
            <ZoomableImage
              // biome-ignore lint/suspicious/noArrayIndexKey: 图片无稳定 id，消息整体快照替换
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              className="max-h-48 max-w-full rounded-lg border object-contain"
            />
          ))}
          {item.text && <UserText text={item.text} />}
          <RewindButton messageIndex={Number(item.key)} />
        </div>
      );
    case 'text':
      return <TextRow item={item} />;
    case 'thinking':
      return (
        <ThinkingRow text={item.text} streaming={item.streaming} durationMs={item.durationMs} />
      );
    case 'tool':
      return <ToolRow item={item} />;
    case 'tool-group':
      return <ToolGroupRow item={item} onToggle={onToggleGroup} />;
    case 'error':
      return (
        <p className="flex items-start gap-1.5 text-sm text-destructive whitespace-pre-wrap">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {item.text}
        </p>
      );
    case 'task-note':
      return <TaskNoteRow item={item} />;
  }
}, itemEqual);

/** 当前展示的会话(主会话或激活的 coworker tab),与 ChatView 的选取逻辑一致 */
function displayedConversation(state: ReturnType<typeof useSessionsStore.getState>) {
  const active = state.activeId ? state.conversations[state.activeId] : null;
  if (!active) return null;
  return active.activeTabId ? (state.conversations[active.activeTabId] ?? active) : active;
}

/** 回退入口:仅 idle 且已 spawn 的会话显示;点击后该 user 消息及之后移出分支,文本回填输入框 */
function RewindButton({ messageIndex }: { messageIndex: number }) {
  const { t } = useI18n();
  const canRewind = useSessionsStore((state) => {
    const conversation = displayedConversation(state);
    return Boolean(
      conversation?.started && !conversation.spawning && conversation.status === 'idle'
    );
  });
  if (!canRewind) return null;
  return (
    <button
      type="button"
      onClick={() => {
        const state = useSessionsStore.getState();
        const conversation = displayedConversation(state);
        if (!conversation) return;
        if (conversation.messages[messageIndex]?.role !== 'user') return;
        // 从末尾数的 user 序号:worker 侧与 jsonl 分支按尾部对齐(容忍 compaction)
        const userIndexFromEnd = conversation.messages
          .slice(messageIndex + 1)
          .filter((message) => message.role === 'user').length;
        state.rewind(conversation.id, userIndexFromEnd);
      }}
      className="flex items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover/user:opacity-100 hover:text-foreground"
      title={t('Rewind to this message')}
    >
      <Undo2 className="h-3 w-3" />
      {t('Rewind')}
    </button>
  );
}

/** assistant 正文：markdown + hover 操作条（复制 / 时间 / 该轮耗时·TTFT·tok/s） */
function TextRow({ item }: { item: Extract<TimelineItem, { kind: 'text' }> }) {
  return (
    <div className="group text-sm">
      <Markdown text={item.text} streaming={item.streaming} />
      {!item.streaming && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
          <CopyButton text={item.text} />
          {item.timestamp && <span>{formatClock(item.timestamp)}</span>}
          {item.perf && <span>· {formatPerf(item.perf)}</span>}
        </div>
      )}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1000);
        });
      }}
      className="flex items-center gap-1 transition-colors hover:text-foreground"
      title={t('Copy')}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const formatClock = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
/** 秒：<10s 一位小数，否则整数 */
const secs = (ms: number): string => {
  const s = ms / 1000;
  return s < 10 ? String(Math.round(s * 10) / 10) : String(Math.round(s));
};
function formatPerf(perf: TurnPerf): string {
  const parts = [`${secs(perf.runMs)}s`];
  if (perf.ttftMs !== undefined) parts.push(`TTFT ${secs(perf.ttftMs)}s`);
  if (perf.tps !== undefined) parts.push(`${Math.round(perf.tps)} tok/s`);
  return parts.join(' · ');
}

/** deepseek-harness 的 Think 行：流式中自动展开跟看，结束自动收起；手动点击覆盖默认 */
function ThinkingRow({
  text,
  streaming,
  durationMs,
}: {
  text: string;
  streaming: boolean;
  durationMs: number | null;
}) {
  const { t } = useI18n();
  const [userToggled, setUserToggled] = useState<boolean | null>(null);
  const expanded = userToggled ?? streaming;
  return (
    <div>
      <button
        type="button"
        onClick={() => setUserToggled(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className={cn('h-3.5 w-3.5', streaming && 'animate-pulse')} />
        <span>{streaming ? t('Thinking…') : t('Thought process')}</span>
        {streaming ? (
          <RunningElapsed />
        ) : (
          durationMs !== null && (
            <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums">
              {formatDuration(durationMs)}
            </span>
          )
        )}
        <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
      </button>
      {expanded && (
        <p className="mt-1.5 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {text}
        </p>
      )}
    </div>
  );
}

/** 后台任务完成事件：分隔线嵌字；点击展开详情与完整日志 */
function TaskNoteRow({ item }: { item: Extract<TimelineItem, { kind: 'task-note' }> }) {
  const [expanded, setExpanded] = useState(false);
  const [log, setLog] = useState<string | null>(null);
  const match = /^Background task (\S+) finished \((.+?), ran (.+?)\)/.exec(item.summary);
  const text = match ? `${match[1]} · ${match[2]} · ${match[3]}` : item.summary;
  const logPath = /read (\/.+?\.log) for the complete log/.exec(item.detail)?.[1] ?? null;

  useEffect(() => {
    if (!expanded || !logPath || log !== null) return;
    void window.electronAPI.files.read(logPath).then((content) => {
      setLog(content ?? '(log unavailable)');
    });
  }, [expanded, logPath, log]);

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3"
        title={item.detail}
      >
        <span className="h-px flex-1 bg-border" />
        <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground">
          <Check className="h-3 w-3 text-green-600 dark:text-green-500" />
          {text}
          <ChevronRight className={cn('h-3 w-3 transition-transform', expanded && 'rotate-90')} />
        </span>
        <span className="h-px flex-1 bg-border" />
      </button>
      {expanded && (
        <div className="mt-1.5 rounded-lg border border-border/60 bg-muted/20">
          <pre className="border-b border-border/60 px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {item.detail}
          </pre>
          <pre className="max-h-64 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {logPath ? (log ?? 'Loading…') : '(no log available)'}
          </pre>
        </div>
      )}
    </div>
  );
}

/** 收拢的工具组头：摘要统计 + chevron；点击展开为组内原始行 */
function ToolGroupRow({
  item,
  onToggle,
}: {
  item: Extract<TimelineItem, { kind: 'tool-group' }>;
  onToggle?: (key: string) => void;
}) {
  const { t } = useI18n();
  const parts: string[] = [];
  if (item.stats.commands > 0)
    parts.push(t('ran {{count}} commands', { count: item.stats.commands }));
  if (item.stats.reads > 0) parts.push(t('read {{count}} files', { count: item.stats.reads }));
  if (item.stats.searches > 0)
    parts.push(t('searched {{count}} times', { count: item.stats.searches }));
  if (item.stats.others > 0) parts.push(t('{{count}} other calls', { count: item.stats.others }));
  return (
    <button
      type="button"
      onClick={() => onToggle?.(item.key)}
      className="flex w-full items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
    >
      <ChevronRight
        className={cn('h-3 w-3 shrink-0 transition-transform', item.expanded && 'rotate-90')}
      />
      <span className="font-medium">{t('{{count}} tool calls', { count: item.count })}</span>
      {parts.length > 0 && (
        <>
          <span className="text-muted-foreground/50">·</span>
          <span className="min-w-0 flex-1 truncate">{parts.join(' · ')}</span>
        </>
      )}
    </button>
  );
}

/** 单行工具摘要：状态点/图标 + 工具名 + 参数摘要；edit 展开为 diff，其余展开为输出 */
function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const hasDiff = Boolean(item.edits && item.edits.length > 0);
  const expandable = hasDiff || Boolean(item.output);
  // edit 的 diff 默认展开（「直接看到」），其余保持收起
  const [expanded, setExpanded] = useState(hasDiff);

  if (item.todos) return <TodoRow todos={item.todos} />;
  if (item.name.startsWith('goal_')) return <GoalSignalRow item={item} />;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30">
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs',
          expandable && 'cursor-pointer hover:bg-muted/50'
        )}
      >
        <ToolStateIcon state={item.state} />
        <span className="shrink-0 font-medium">{item.name}</span>
        {item.summary && (
          <>
            <span className="text-muted-foreground/50">·</span>
            <span
              className={cn(
                'min-w-0 flex-1 truncate font-mono',
                item.state === 'error' ? 'text-destructive' : 'text-muted-foreground'
              )}
            >
              {item.state === 'error' && item.output ? firstLine(item.output) : item.summary}
            </span>
          </>
        )}
        {item.state === 'running' ? (
          <RunningElapsed />
        ) : (
          (item.agentMeta || item.durationMs !== null) && (
            <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
              {[
                item.agentMeta?.modelId,
                item.agentMeta?.outputTokens ? `${item.agentMeta.outputTokens} tok` : null,
                item.durationMs !== null ? formatDuration(item.durationMs) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )
        )}
        {expandable && (
          <ChevronRight
            className={cn(
              'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
              expanded && 'rotate-90'
            )}
          />
        )}
      </button>
      {expanded && hasDiff && item.edits && (
        <div className="max-h-96 overflow-auto">
          <EditDiff path={item.summary} blocks={item.edits} />
        </div>
      )}
      {expanded && !hasDiff && item.output && (
        <div className="max-h-96 overflow-auto rounded-b-lg border-t border-border/60">
          {item.name === 'bash' ? (
            <TerminalOutput command={item.summary} output={item.output} />
          ) : item.name === 'read' ? (
            <ReadFileView path={item.summary} contents={item.output} />
          ) : item.name === 'subagent' && item.state !== 'error' ? (
            <div className="px-3 py-2 text-sm">
              <Markdown text={item.output} />
            </div>
          ) : (
            <pre className="px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
              {item.output}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

/** goal 终止信号行:目标完成/受阻/等待的醒目标记(摘要即 agent 给的证据/原因) */
function GoalSignalRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const { t } = useI18n();
  const kind = item.name.replace('goal_', '');
  const label =
    kind === 'complete'
      ? t('Goal completed')
      : kind === 'blocked'
        ? t('Goal blocked')
        : t('Goal waiting');
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-lg border px-3 py-2 text-sm',
        kind === 'complete' && 'border-green-500/50 bg-green-500/5',
        kind === 'blocked' && 'border-destructive/50 bg-destructive/5',
        kind === 'wait' && 'border-amber-500/50 bg-amber-500/5'
      )}
    >
      <Target
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          kind === 'complete' && 'text-green-600 dark:text-green-500',
          kind === 'blocked' && 'text-destructive',
          kind === 'wait' && 'text-amber-500'
        )}
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{label}</p>
        {item.summary && (
          <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground text-xs">{item.summary}</p>
        )}
      </div>
    </div>
  );
}

/** todo 清单行：进度摘要 + ✓/●/○ 列表；清单即产物，恒展开 */
function TodoRow({ todos }: { todos: TodoItem[] }) {
  const { t } = useI18n();
  const done = todos.filter((todo) => todo.status === 'completed').length;
  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <ListTodo className="h-3.5 w-3.5 shrink-0" />
        <span className="font-medium">{t('Todos')}</span>
        <span>
          {done}/{todos.length}
        </span>
      </div>
      <ul className="space-y-0.5 text-xs">
        {todos.map((todo) => (
          <li key={todo.content} className="flex items-start gap-1.5">
            {todo.status === 'completed' ? (
              <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-600 dark:text-green-500" />
            ) : todo.status === 'in_progress' ? (
              <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-blue-500" />
            ) : (
              <Circle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50" />
            )}
            <span
              className={cn(
                todo.status === 'completed'
                  ? 'text-muted-foreground line-through'
                  : todo.status === 'in_progress'
                    ? 'font-medium'
                    : 'text-muted-foreground'
              )}
            >
              {todo.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** running 工具行的实时计时：以挂载时刻为起点（≈执行起点；串行排队的会含排队时间） */
function RunningElapsed() {
  const startRef = useRef(Date.now());
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70 tabular-nums">
      {formatDuration(Date.now() - startRef.current)}
    </span>
  );
}

function ToolStateIcon({ state }: { state: 'running' | 'ok' | 'error' }) {
  switch (state) {
    case 'running':
      return <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />;
    case 'error':
      return <CircleAlert className="h-3.5 w-3.5 shrink-0 text-destructive" />;
    default:
      return <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }
}

const firstLine = (text: string): string => text.split('\n', 1)[0] ?? '';
