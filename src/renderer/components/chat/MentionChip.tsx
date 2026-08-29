import type { AgentTypeMentionCandidate, ChatMentionCandidate } from '@shared/types/mentions';
import { Bot, History, X } from 'lucide-react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

export type MentionKind = 'agent-type' | 'file' | 'chat';

/**
 * 提及 chip 与 SlashChip 同底座（色块 tag），按类型区分颜色：
 * agent=primary、file=success、chat=warning；/skill 是 info，互不撞色。
 * 浅底用实色字，避免 *-foreground 近白叠在 /15 底上看不清（同 SlashChip）。
 */
const COLORS: Record<MentionKind, string> = {
  // primary 是近黑灰，做色块 tag 会变灰块；agent 用 purple（Markdown.tsx 已有直接用调色板的先例）
  'agent-type': 'bg-purple-500/15 text-purple-600 dark:text-purple-400',
  file: 'bg-success/15 text-success',
  chat: 'bg-warning/25 text-warning-foreground dark:bg-warning/15 dark:text-warning',
};

export function mentionChipClass(kind: MentionKind): string {
  return cn(
    'inline-flex max-w-52 items-center gap-1 rounded-md px-1.5 py-0.5 align-middle text-xs font-medium',
    COLORS[kind]
  );
}

function RemoveButton({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <button
      type="button"
      onClick={onRemove}
      className="rounded-sm opacity-70 transition-opacity hover:opacity-100"
      aria-label={label}
    >
      <X className="h-3 w-3" />
    </button>
  );
}

interface MentionChipProps {
  recipient: AgentTypeMentionCandidate;
  onRemove: () => void;
}

export function MentionChip({ recipient, onRemove }: MentionChipProps) {
  const { t } = useI18n();
  return (
    <span className={cn(mentionChipClass('agent-type'), 'mt-0.5 shrink-0')}>
      <Bot className="h-3 w-3 shrink-0" />
      <span className="truncate">{recipient.label}</span>
      <RemoveButton label={t('Remove Agent recipient')} onRemove={onRemove} />
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
    <span className={cn(mentionChipClass('chat'), 'mt-0.5 shrink-0')}>
      <History className="h-3 w-3 shrink-0" />
      <span className="truncate">{chat.label}</span>
      <RemoveButton label={t('Remove chat reference')} onRemove={onRemove} />
    </span>
  );
}
