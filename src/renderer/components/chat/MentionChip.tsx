import type { AgentTypeMentionCandidate } from '@shared/types/mentions';
import { Bot, X } from 'lucide-react';
import { useI18n } from '@/i18n';

interface MentionChipProps {
  recipient: AgentTypeMentionCandidate;
  onRemove: () => void;
}

export function MentionChip({ recipient, onRemove }: MentionChipProps) {
  const { t } = useI18n();
  return (
    <span className="mt-0.5 inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-primary/30 bg-primary/8 px-1.5 text-[11px] font-medium text-primary">
      <Bot className="h-3 w-3" />
      {t('Recipient')}: {recipient.label}
      <span className="text-[9px] font-normal text-primary/70">
        {t(
          recipient.source === 'system'
            ? 'System'
            : recipient.source === 'builtin'
              ? 'Built-in'
              : 'Custom'
        )}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
        aria-label={t('Remove Agent recipient')}
      >
        <X className="h-3 w-3" />
      </button>
      <span className="sr-only">{recipient.typeKey}</span>
    </span>
  );
}
