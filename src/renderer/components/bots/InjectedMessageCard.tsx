import type { BotInjectedMessage } from '@shared/bots/injectedMessage';
import { ClipboardList, Clock, CornerDownRight, MessagesSquare } from 'lucide-react';
import { useI18n } from '@/i18n';

export function InjectedMessageCard({ message }: { message: BotInjectedMessage }) {
  const { t } = useI18n();
  const statuses: Record<string, string> = {
    queued: t('Queued'),
    running: t('In progress'),
    completed: t('Completed'),
    failed: t('Failed'),
    canceled: t('Canceled'),
  };
  const Icon =
    message.kind === 'routine'
      ? Clock
      : message.kind === 'group'
        ? MessagesSquare
        : message.kind === 'delegation-task'
          ? ClipboardList
          : CornerDownRight;
  const title =
    message.kind === 'routine'
      ? `${message.dryRun ? t('Routine dry run') : t('Routine task')} · ${message.title}`
      : message.kind === 'group'
        ? t('Group messages')
        : message.kind === 'delegation-task'
          ? t('Task from {{name}}', { name: message.from })
          : message.kind === 'delegation-results'
            ? t('Delegation results')
            : t('Result from {{name}}', { name: message.from });
  return (
    <div
      data-bot-injection={message.kind}
      className="w-full rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-sm"
    >
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <span>{title}</span>
        {message.kind === 'delegation-result' && message.status && (
          <span>· {statuses[message.status] ?? message.status}</span>
        )}
      </div>
      <div className="whitespace-pre-wrap break-words">
        {message.kind === 'routine'
          ? message.prompt
          : message.kind === 'delegation-task'
            ? message.task
            : message.kind === 'delegation-result'
              ? message.text
              : message.kind === 'delegation-results'
                ? message.results.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 注入批次不可变，同一成员可被委派多次。
                    <p key={`${index}:${item.from}`}>
                      <span className="font-medium">
                        {item.from}
                        {item.status && ` · ${statuses[item.status] ?? item.status}`}：
                      </span>
                      {item.text}
                    </p>
                  ))
                : message.messages.map((item, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 注入批次不可变，同一成员可重复发相同内容。
                    <p key={`${index}:${item.from}`}>
                      <span className="font-medium">{item.from}：</span>
                      {item.text}
                    </p>
                  ))}
      </div>
      {message.kind === 'delegation-task' && message.context && (
        <details className="mt-1.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('Context')}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{message.context}</p>
        </details>
      )}
      {message.kind === 'group' && message.instruction && (
        <details className="mt-1.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('Instructions')}</summary>
          <p className="mt-1 whitespace-pre-wrap break-words">{message.instruction}</p>
        </details>
      )}
      {message.kind === 'group' && !!message.refs?.length && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {message.refs.map((ref) => (
            <span
              key={ref.id}
              title={t('Referenced chat')}
              className="inline-flex h-6 max-w-56 items-center gap-1 rounded-md bg-muted px-1.5 text-xs"
            >
              <MessagesSquare className="h-3 w-3 shrink-0" />
              <span className="min-w-0 truncate">{ref.title}</span>
            </span>
          ))}
        </div>
      )}
      {message.kind === 'group' && message.note && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t('Dispatch hint: {{note}}', { note: message.note })}
        </p>
      )}
      {message.kind !== 'group' && !!message.group?.length && (
        <details className="mt-1.5 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {t('Group messages')} · {message.group.length}
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words">
            {message.group.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 注入批次不可变，同一成员可重复发相同内容。
              <p key={`${index}:${item.from}`}>
                <span className="font-medium">{item.from}：</span>
                {item.text}
              </p>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
