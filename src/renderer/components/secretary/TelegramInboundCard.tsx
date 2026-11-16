import type { InboundMessage } from '@shared/secretary/inbound';
import { Send } from 'lucide-react';
import { Markdown } from '@/components/chat/Markdown';
import { useI18n } from '@/i18n';

function preview(body: string): string {
  const line = body
    .split('\n')
    .map((row) => row.replace(/^[#>\-*\s]+/u, '').trim())
    .find(Boolean);
  const flat = (line ?? '').replace(/\s+/gu, ' ');
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

/** 手机发来的话：默认收成一行，点开按 markdown 看全文 */
export function TelegramInboundCard({ message }: { message: InboundMessage }) {
  const { t } = useI18n();
  const who = message.username ? `@${message.username}` : '';
  return (
    <div
      data-telegram-inbound={message.channel}
      className="w-full rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
    >
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Send className="size-3.5 shrink-0" />
          <span className="shrink-0">
            {message.channel === 'telegram'
              ? t('From Telegram')
              : t('From {{name}}', { name: message.title })}
          </span>
          {who && <span className="shrink-0 text-foreground">{who}</span>}
          {message.time && <span className="shrink-0">· {message.time}</span>}
          <span className="min-w-0 truncate font-normal group-open:hidden">
            {preview(message.body)}
          </span>
        </summary>
        <div className="mt-1.5 break-words">
          <Markdown text={message.body} />
        </div>
      </details>
    </div>
  );
}
