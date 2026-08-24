import { Brain, Check, ChevronRight, CircleAlert, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import type { TimelineItem } from '@/stores/sessions/timeline';
import { Markdown } from './Markdown';
import { ZoomableImage } from './ZoomableImage';

export function TimelineRow({ item }: { item: TimelineItem }) {
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

/** 单行工具摘要：状态点/图标 + 工具名 + 参数摘要；整行点击展开输出 */
function ToolRow({ item }: { item: Extract<TimelineItem, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const expandable = Boolean(item.output);
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
      {expanded && item.output && (
        <pre className="max-h-64 overflow-auto border-t border-border/60 px-3 py-2 font-mono text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap">
          {item.output}
        </pre>
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
