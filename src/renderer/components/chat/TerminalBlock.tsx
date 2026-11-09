import { useMemo, useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';
import { type AnsiSegment, parseAnsi, splitConsole, stripAnsi } from './richFence';

/** 超过这么多行时折叠，只留末尾 TAIL_LINES 行（测试结果、报错通常在最后） */
const FOLD_LINES = 40;
const TAIL_LINES = 20;

/** 深浅主题都可读的 ANSI 调色 */
const PALETTE: Record<string, string> = {
  black: '#6e7781',
  red: '#d1242f',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#8c959f',
  'bright-black': '#8c959f',
  'bright-red': '#e5534b',
  'bright-green': '#3fb950',
  'bright-yellow': '#d4a72c',
  'bright-blue': '#539bf5',
  'bright-magenta': '#b083f0',
  'bright-cyan': '#39c5cf',
  'bright-white': '#adbac7',
};

function Segment({ segment }: { segment: AnsiSegment }) {
  const { text, fg, bg, bold, dim, italic, underline } = segment;
  if (!fg && !bg && !bold && !dim && !italic && !underline) return text;
  return (
    <span
      style={{
        color: fg ? (PALETTE[fg] ?? fg) : undefined,
        backgroundColor: bg ? (PALETTE[bg] ?? bg) : undefined,
      }}
      className={cn(
        bold && 'font-semibold',
        dim && 'opacity-60',
        italic && 'italic',
        underline && 'underline'
      )}
    >
      {text}
    </span>
  );
}

/** 终端会话：`$ 命令` 与输出分开，ANSI 颜色照画，长输出只留末尾 */
export function TerminalBlock({ source }: { source: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const lines = source.split('\n');
  const folded = !expanded && lines.length > FOLD_LINES;
  const shown = folded ? lines.slice(-TAIL_LINES).join('\n') : source;
  const parts = useMemo(() => splitConsole(shown), [shown]);
  return (
    <div data-enso="terminal-block" className="group/code relative my-2">
      <div className="overflow-x-auto rounded-lg border bg-[var(--sunken,var(--muted))] p-3 font-mono text-(length:--chat-code-block-size) leading-relaxed">
        {folded && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mb-1 text-[11px] text-muted-foreground hover:text-foreground"
          >
            {t('Show all {{count}} lines', { count: lines.length })}
          </button>
        )}
        {parts.map((part, index) =>
          part.kind === 'command' ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: 片段由同一份文本派生，顺序即身份
            <div key={index} className="whitespace-pre font-semibold">
              <span className="select-none text-muted-foreground">$ </span>
              {stripAnsi(part.text)}
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: 同上
            <div key={index} className="whitespace-pre">
              {parseAnsi(part.text).map((segment, at) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 同上
                <Segment key={at} segment={segment} />
              ))}
            </div>
          )
        )}
      </div>
      <CopyButton
        text={() => stripAnsi(source)}
        className="absolute top-1.5 right-1.5 rounded-md border bg-background/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition-opacity group-hover/code:opacity-100"
      />
    </div>
  );
}
