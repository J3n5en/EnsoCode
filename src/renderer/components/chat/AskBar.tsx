import type { AskRequestInfo } from '@shared/types/agent';
import { MessageCircleQuestion, Send } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';

interface AskBarProps {
  asks: AskRequestInfo[];
  onAnswer: (requestId: string, answer: string) => void;
}

/** composer 上方的提问条(与审批条同构):agent 经 ask_user 提问,选项一键答或自由输入 */
export function AskBar({ asks, onAnswer }: AskBarProps) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [responding, setResponding] = useState<string | null>(null);
  const active = asks[0];
  if (!active) return null;
  const disabled = responding === active.requestId;
  const answer = (value: string) => {
    if (!value.trim()) return;
    setResponding(active.requestId);
    setText('');
    onAnswer(active.requestId, value.trim());
  };

  return (
    <div className="mb-1 rounded-lg border border-blue-500/50 bg-blue-500/5 px-3 py-2">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
        <span className="min-w-0 flex-1 text-sm whitespace-pre-wrap">{active.question}</span>
        {asks.length > 1 && (
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
            1/{asks.length}
          </span>
        )}
      </div>
      {active.options && active.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {active.options.map((option) => (
            <button
              key={option}
              type="button"
              disabled={disabled}
              onClick={() => answer(option)}
              className="rounded-md border border-blue-500/40 px-2.5 py-1 text-xs transition-colors hover:bg-blue-500/10 disabled:opacity-50"
            >
              {option}
            </button>
          ))}
        </div>
      )}
      <div className="mt-2 flex items-center gap-1.5">
        <input
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
