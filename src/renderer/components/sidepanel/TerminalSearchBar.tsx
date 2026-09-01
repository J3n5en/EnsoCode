import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/i18n';
import type { TerminalSearchOptions } from '@/lib/terminalRegistry';
import { cn } from '@/lib/utils';

interface TerminalSearchBarProps {
  open: boolean;
  onClose: () => void;
  onFindNext: (query: string, options?: TerminalSearchOptions) => boolean;
  onFindPrevious: (query: string, options?: TerminalSearchOptions) => boolean;
  onClear: () => void;
  theme?: { background?: string; foreground?: string };
}

export function TerminalSearchBar({
  open,
  onClose,
  onFindNext,
  onFindPrevious,
  onClear,
  theme,
}: TerminalSearchBarProps) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [found, setFound] = useState<boolean | null>(null);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else {
      onClear();
      setFound(null);
    }
  }, [open, onClear]);

  const opts = (): TerminalSearchOptions => ({ caseSensitive, wholeWord, regex });
  const search = (direction: 'next' | 'prev') => {
    if (!query) {
      setFound(null);
      return;
    }
    setFound(direction === 'next' ? onFindNext(query, opts()) : onFindPrevious(query, opts()));
  };

  if (!open) return null;

  const bg = theme?.background ?? '#1e1e1e';
  const fg = theme?.foreground ?? '#d4d4d4';

  return (
    <div
      className="absolute top-2 right-2 z-10 flex items-center gap-1 rounded-md border px-2 py-1 shadow-lg"
      style={{ backgroundColor: bg, borderColor: `${fg}30` }}
    >
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => {
          const value = e.target.value;
          setQuery(value);
          if (value) setFound(onFindNext(value, opts()));
          else {
            onClear();
            setFound(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            search(e.shiftKey ? 'prev' : 'next');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder={t('Search...')}
        className={cn(
          'w-40 bg-transparent text-sm outline-none placeholder:opacity-50',
          found === false && query && 'text-red-400'
        )}
        style={{ color: fg }}
      />
      <button
        type="button"
        onClick={() => setCaseSensitive((v) => !v)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded text-xs font-bold',
          caseSensitive ? 'bg-white/20' : 'opacity-50 hover:opacity-100'
        )}
        style={{ color: fg }}
        title={t('Case sensitive')}
      >
        Aa
      </button>
      <button
        type="button"
        onClick={() => setWholeWord((v) => !v)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded text-xs font-bold',
          wholeWord ? 'bg-white/20' : 'opacity-50 hover:opacity-100'
        )}
        style={{ color: fg }}
        title={t('Whole word')}
      >
        W
      </button>
      <button
        type="button"
        onClick={() => setRegex((v) => !v)}
        className={cn(
          'flex h-6 w-6 items-center justify-center rounded text-xs font-bold',
          regex ? 'bg-white/20' : 'opacity-50 hover:opacity-100'
        )}
        style={{ color: fg }}
        title={t('Regular expression')}
      >
        .*
      </button>
      <div className="mx-1 h-4 w-px" style={{ backgroundColor: `${fg}30` }} />
      <button
        type="button"
        onClick={() => search('prev')}
        className="flex h-6 w-6 items-center justify-center rounded opacity-70 hover:opacity-100"
        style={{ color: fg }}
        title={t('Previous match')}
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => search('next')}
        className="flex h-6 w-6 items-center justify-center rounded opacity-70 hover:opacity-100"
        style={{ color: fg }}
        title={t('Next match')}
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="flex h-6 w-6 items-center justify-center rounded opacity-70 hover:opacity-100"
        style={{ color: fg }}
        title={t('Close')}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
