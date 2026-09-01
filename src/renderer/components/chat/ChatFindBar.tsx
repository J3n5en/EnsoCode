import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';

export const OPEN_CHAT_FIND_EVENT = 'enso:open-chat-find';

export function requestOpenChatFind() {
  window.dispatchEvent(new Event(OPEN_CHAT_FIND_EVENT));
}

export function ChatFindBar({
  query,
  onQueryChange,
  current,
  total,
  onPrev,
  onNext,
  onClose,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    focus();
    window.addEventListener(OPEN_CHAT_FIND_EVENT, focus);
    return () => window.removeEventListener(OPEN_CHAT_FIND_EVENT, focus);
  }, []);

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5">
      <div className="relative min-w-0 flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 z-10 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
              return;
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              if (e.shiftKey) onPrev();
              else onNext();
            }
          }}
          placeholder={t('Search messages...')}
          className="h-8 text-xs [&_input]:pl-8"
        />
      </div>
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {total === 0 ? t('No results') : `${current}/${total}`}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={total === 0}
        onClick={onPrev}
        aria-label={t('Previous match')}
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7"
        disabled={total === 0}
        onClick={onNext}
        aria-label={t('Next match')}
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </Button>
      <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}
