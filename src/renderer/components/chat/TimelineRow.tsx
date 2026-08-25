import { Brain, Check, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { memo, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { EditDiff } from './EditDiff';
import { Markdown } from './Markdown';
import { ReadFileView } from './ReadFileView';
import { TerminalOutput } from './TerminalOutput';
import { ZoomableImage } from './ZoomableImage';

/**
 * 按内容字段比较：buildTimeline 每次产出新 item 对象，直接 memo 无效。
 * 长对话下这层比较挡住了未变行的 markdown 重解析与 DOM 重建。
 */
function itemEqual(prev: { item: TimelineItem }, next: { item: TimelineItem }): boolean {
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
      return b.kind === a.kind && a.text === b.text && a.streaming === b.streaming;
    case 'tool':
      return (
        b.kind === 'tool' &&
        a.state === b.state &&
        a.name === b.name &&
        a.summary === b.summary &&
        a.output === b.output &&
        a.edits === b.edits
      );
    case 'error':
      return b.kind === 'error' && a.text === b.text;
  }
}

export const TimelineRow = memo(function TimelineRow({ item }: { item: TimelineItem }) {
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
      return (
        <div className="text-sm">
          <Markdown text={item.text} />
        </div>
      );
    case 'thinking':
      return <ThinkingRow text={item.text} streaming={item.streaming} />;
    case 'tool':
      return <ToolRow item={item} />;
    case 'error':
      return (
        <p className="flex items-start gap-1.5 text-sm text-destructive whitespace-pre-wrap">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {item.text}
        </p>
      );
  }
}, itemEqual);

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

/** 单行工具摘要：状态点/图标 + 工具名 + 参数摘要；edit 展开为 diff，其余展开为输出 */
function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const hasDiff = Boolean(item.edits && item.edits.length > 0);
  const expandable = hasDiff || Boolean(item.output);
  // edit 的 diff 默认展开（「直接看到」），其余保持收起
  const [expanded, setExpanded] = useState(hasDiff);
  const ref = useRef<HTMLDivElement>(null);

  // diff 滚出视口后自动折叠为单行；再次滚回保持折叠，需要时点开
  useEffect(() => {
    if (!hasDiff) return;
    const el = ref.current;
    if (!el) return;
    const root = el.closest('[data-slot="scroll-area-viewport"]');
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) setExpanded(false);
      },
      { root, threshold: 0 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasDiff]);

  return (
    <div ref={ref} className="rounded-lg border border-border/60 bg-muted/30">
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
