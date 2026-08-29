import type { AgentTypeMentionCandidate, ChatMentionCandidate } from '@shared/types/mentions';
import { Bot, History, X } from 'lucide-react';
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

interface ChatMentionChipProps {
  chat: ChatMentionCandidate;
  onRemove: () => void;
}

/** 过去会话引用 chip：标题含空格不能走文本 token，发送时由 createComposerPayload 追加引用块。 */
export function ChatMentionChip({ chat, onRemove }: ChatMentionChipProps) {
  const { t } = useI18n();
  return (
    <span className="mt-0.5 inline-flex h-6 max-w-48 shrink-0 items-center gap-1 rounded-md border bg-muted/50 px-1.5 text-[11px] font-medium text-muted-foreground">
      <History className="h-3 w-3 shrink-0" />
      <span className="truncate">{chat.label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
        aria-label={t('Remove chat reference')}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
