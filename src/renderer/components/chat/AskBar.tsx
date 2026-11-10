import type { AskRequestInfo } from '@shared/types/agent';
import { ChevronRight, MessageCircleQuestion, Send } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import { askFocusMove, askFocusStart, askOptionShortcut } from './askOptions';
import { RequestCountdown, useRemainingMs } from './RequestCountdown';

interface AskBarProps {
  asks: AskRequestInfo[];
  onAnswer: (requestId: string, answer: string) => void;
  /** 本机时钟 − host 时钟（手机伴侣显示剩余时间用） */
  clockOffset?: number;
  /** 桌面端提问出现时聚焦输入；手机传 false，避免立刻弹键盘挡住消息 */
  autoFocus?: boolean;
}

/** composer 上方的提问条(与审批条同构):agent 经 ask_user 提问,选项一键答或自由输入 */
export function AskBar({ asks, onAnswer, clockOffset, autoFocus = true }: AskBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [text, setText] = useState('');
  const [responding, setResponding] = useState<string | null>(null);
  const [later, setLater] = useState<ReadonlySet<string>>(() => new Set());
  const active = asks[0];
  const requestId = active?.requestId;
  const remainingMs = useRemainingMs(active?.expiresAt, clockOffset);
  const folded = requestId !== undefined && later.has(requestId);
  const options = active?.options;
  const recommended = active?.recommended;
  const focusAt = (index: number) => {
    const option = optionRefs.current[index];
    if (options && index < options.length && option) option.focus();
    else inputRef.current?.focus();
  };
  // 打开时焦点落推荐项（没有推荐落第一项，没有选项落输入框），↑↓ 移动、↵ 选中
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换提问或展开时落焦点
  useEffect(() => {
    if (!autoFocus || !requestId || folded) return;
    const start = askFocusStart(options, recommended);
    const option = optionRefs.current[start];
    if (options && start < options.length && option) option.focus();
    else inputRef.current?.focus();
  }, [autoFocus, requestId, folded]);
  if (!active) return null;
  const disabled =
    responding === active.requestId || (remainingMs !== undefined && remainingMs <= 0);
  const answer = (value: string) => {
    if (!value.trim()) return;
    setResponding(active.requestId);
    setText('');
    onAnswer(active.requestId, value.trim());
  };
  const fold = () =>
    setLater((prev) => (prev.has(active.requestId) ? prev : new Set(prev).add(active.requestId)));

  if (folded) {
    return (
      <button
        type="button"
        data-enso="ask-later"
        onClick={() =>
          setLater((prev) => {
            const next = new Set(prev);
            next.delete(active.requestId);
            return next;
          })
        }
        className="mb-1 flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span className="min-w-0 flex-1 truncate">{active.question}</span>
        {asks.length > 1 && (
          <span className="shrink-0 text-[10px] tabular-nums">1/{asks.length}</span>
        )}
        <ChevronRight className="h-3 w-3 shrink-0" />
      </button>
    );
  }

  return (
    <div
      data-enso="ask"
      className="mb-1 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-2"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || disabled) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          fold();
          return;
        }
        const target = event.target;
        const count = (options?.length ?? 0) + 1;
        const at =
          target === inputRef.current
            ? count - 1
            : optionRefs.current.indexOf(target as HTMLButtonElement);
        const next = at >= 0 ? askFocusMove(at, count, event.key) : null;
        if (next !== null) {
          event.preventDefault();
          focusAt(next);
          return;
        }
        if (
          target instanceof HTMLInputElement &&
          (target.value.length > 0 || event.key === 'Enter')
        ) {
          return;
        }
        const index = Number(event.key) - 1;
        const option = options?.[index];
        if (askOptionShortcut(index) && option) {
          event.preventDefault();
          answer(option);
          return;
        }
        // 焦点在选项上时开始打字：转进输入框（空格留给按钮自身）
        if (target instanceof HTMLButtonElement && at >= 0) {
          if (event.key === 'Process') {
            inputRef.current?.focus();
          } else if (
            event.key.length === 1 &&
            event.key !== ' ' &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            setText((prev) => prev + event.key);
            inputRef.current?.focus();
          }
        }
      }}
    >
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />
        <span className="min-w-0 flex-1 text-xs leading-relaxed whitespace-pre-wrap">
          {active.question}
        </span>
        <button
          type="button"
          onClick={fold}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {t('Later')}
        </button>
        <RequestCountdown remainingMs={remainingMs} expiredLabel="Timed out · no answer" />
        {asks.length > 1 && (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            1/{asks.length}
          </span>
        )}
      </div>
      {options && options.length > 0 && (
        <div className="mt-2 flex flex-col gap-1.5">
          {options.map((option, index) => {
            const shortcut = askOptionShortcut(index);
            return (
              <button
                key={option}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                type="button"
                disabled={disabled}
                onClick={() => answer(option)}
                className="flex items-center gap-2 rounded-md border border-border/60 px-2 py-1 text-left text-xs text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus:border-ring focus:bg-muted focus:text-foreground disabled:opacity-50"
              >
                {shortcut && (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded bg-muted font-mono text-[10px] text-muted-foreground">
                    {shortcut}
                  </span>
                )}
                <span className="min-w-0 flex-1">{option}</span>
                {option === recommended && (
                  <span className="shrink-0 rounded bg-success/15 px-1.5 text-[10px] text-success">
                    {t('Recommended')}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') answer(text);
          }}
          disabled={disabled}
          placeholder={t('Type an answer…')}
          className="h-7 min-w-0 flex-1 rounded-md border bg-transparent px-2 text-xs outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
        />
        <button
          type="button"
          disabled={disabled || !text.trim()}
          onClick={() => answer(text)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
