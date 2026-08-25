import type { TodoItem, TurnPerf } from '@shared/types/agent';
import {
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleDot,
  Copy,
  ListTodo,
  LoaderCircle,
} from 'lucide-react';
import { memo, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
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
          (b.kind === 'text' && perfEqual(a.perf, b.perf) && a.timestamp === b.timestamp))
      );
    case 'tool':
      return (
        b.kind === 'tool' &&
        a.state === b.state &&
        a.name === b.name &&
        a.summary === b.summary &&
        a.output === b.output &&
        a.edits === b.edits &&
        a.todos === b.todos
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
  }
}

export const TimelineRow = memo(function TimelineRow({ item, onToggleGroup }: TimelineRowProps) {
  switch (item.kind) {
    case 'user':
      return (
        <div className="flex flex-col items-end gap-1.5">
          {item.images.map((image, index) => (
            <ZoomableImage
              // biome-ignore lint/suspicious/noArrayIndexKey: 图片无稳定 id，消息整体快照替换
              key={index}
              src={`data:${image.mimeType};base64,${image.data}`}
              className="max-h-48 max-w-full rounded-lg border object-contain"
            />
          ))}
          {item.text && (
            <div className="max-w-[80%] rounded-2xl rounded-br-md bg-muted px-4 py-2.5 text-sm whitespace-pre-wrap">
              {item.text}
            </div>
          )}
        </div>
      );
    case 'text':
      return <TextRow item={item} />;
    case 'thinking':
      return <ThinkingRow text={item.text} streaming={item.streaming} />;
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
  }
}, itemEqual);

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

/** deepseek-harness 的 Think 行：单行摘要，点击展开为灰色缩进文本 */
function ThinkingRow({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Brain className={cn('h-3.5 w-3.5', streaming && 'animate-pulse')} />
        <span>{streaming ? t('Thinking…') : t('Thought process')}</span>
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
