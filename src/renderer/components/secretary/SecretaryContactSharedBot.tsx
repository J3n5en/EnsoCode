import type {
  SecretaryContactBind,
  SecretaryContactBotUser,
  SecretaryContactGroupBinding,
} from '@shared/types/secretary';
import { Copy, ExternalLink, TriangleAlert, Users } from 'lucide-react';
import { type TFunction, useI18n } from '@/i18n';

const STEP_CLASS = 'rounded-xl border border-border px-3 py-2.5';
const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-muted disabled:opacity-50';

/** 同一个 bot 上已经占着私聊的别的秘书：同一个人和同一个 bot 只有一个私聊 */
export function privateChatOwner(shared: SecretaryContactBotUser[] | undefined): string | null {
  return shared?.find((user) => !user.self && user.privateChat)?.name ?? null;
}

const REJECTION_TEXT: Record<NonNullable<SecretaryContactBind['rejected']>['reason'], string> = {
  'private-owned':
    'Your private chat with this bot already belongs to secretary "{{owner}}". One person has only one private chat with a bot, so bind this secretary to a group or forum topic below, or give it a different bot.',
  'route-conflict':
    'That group or topic already belongs to secretary "{{owner}}". Send the code in another group or topic.',
  expired: 'The code expired. Generate a new one.',
  'missing-code':
    'The bot got /start without the code. Open the bot with the button or QR code (the link carries the code), or send /start {{code}} yourself.',
};

/** 绑定码最近一次没绑上的原因，带上下一步 */
export function SecretaryContactBindRejection({ bind }: { bind: SecretaryContactBind }) {
  const { t } = useI18n();
  const rejected = bind.rejected;
  if (!rejected) return null;
  return (
    <p
      data-enso="secretary-contact-bind-rejected"
      data-reason={rejected.reason}
      className="mt-2 flex gap-1.5 rounded-lg bg-warning/10 px-2.5 py-2 text-[11.5px] text-warning"
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span>
        {t(REJECTION_TEXT[rejected.reason], { owner: rejected.owner ?? '', code: bind.code })}
      </span>
    </p>
  );
}

/** 不走私聊时的两种绑法：把 bot 拉进群绑整群，或在论坛话题里发 /bind */
export function SecretaryContactBindPlaces({
  bind,
  onCopied,
}: {
  bind: SecretaryContactBind;
  onCopied: () => void;
}) {
  const { t } = useI18n();
  return (
    <div data-enso="secretary-contact-bind-places" className="mt-2 flex flex-col gap-1.5">
      <p className="text-[12px] font-medium text-muted-foreground">{t('Bind a group or topic')}</p>
      {bind.groupLink && (
        <a
          data-enso="secretary-contact-group-link"
          href={bind.groupLink}
          target="_blank"
          rel="noreferrer"
          className={`${BUTTON_CLASS} self-start`}
        >
          <ExternalLink className="size-3.5" />
          {t('Add the bot to a group')}
        </a>
      )}
      {bind.topicCommand && (
        <div className="flex flex-col gap-1">
          <span className="text-[11.5px] text-muted-foreground">
            {t('In the forum topic, send:')}
          </span>
          <div className="flex items-center gap-1.5">
            <code
              data-enso="secretary-contact-topic-command"
              className="min-w-0 flex-1 truncate rounded bg-muted px-1.5 py-1 font-mono text-[11.5px]"
            >
              {bind.topicCommand}
            </code>
            <button
              type="button"
              data-enso="secretary-contact-copy-topic-command"
              className={BUTTON_CLASS}
              aria-label={t('Copy')}
              onClick={() => {
                void navigator.clipboard.writeText(bind.topicCommand ?? '');
                onCopied();
              }}
            >
              <Copy className="size-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function groupSummary(group: SecretaryContactGroupBinding, t: TFunction): string {
  const name = group.title ?? group.id;
  if (group.all) return `${name} · ${t('Whole group')}`;
  const topics = group.topics
    .map((topic) =>
      topic.id === '1'
        ? t('General (default topic)')
        : (topic.title ?? t('Topic #{{id}}', { id: topic.id }))
    )
    .join(', ');
  return `${name} · ${t('Topics: {{names}}', { names: topics })}`;
}

/** 这个 bot 被哪些秘书共用、各自认领了哪些私聊、群和话题 */
export function SecretaryContactSharedBot({
  shared,
  bot,
}: {
  shared: SecretaryContactBotUser[];
  bot?: string;
}) {
  const { t } = useI18n();
  return (
    <div data-enso="secretary-contact-shared" className={STEP_CLASS}>
      <div className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground">
        <Users className="size-3.5" />
        {t('@{{bot}} is shared by {{count}} secretaries', {
          bot: bot ?? '',
          count: shared.length,
        })}
      </div>
      <p className="mt-1 text-[11.5px] text-muted-foreground">
        {t(
          'Each private chat, group or forum topic belongs to one secretary. A topic bound on its own wins over the whole group. Places nobody bound get no reply.'
        )}
      </p>
      <ul className="mt-1.5 flex flex-col gap-1.5">
        {shared.map((user) => {
          const places = [
            ...(user.privateChat
              ? [
                  t('Private chat with @{{name}}', {
                    name: user.privateChat.username ?? String(user.privateChat.id),
                  }),
                ]
              : []),
            ...user.groups.map((group) => groupSummary(group, t)),
          ];
          return (
            <li
              key={user.secretaryId}
              data-enso="secretary-contact-shared-user"
              data-self={user.self || undefined}
              className="text-[12px]"
            >
              <span className="font-medium">{user.name}</span>
              {user.self && (
                <span className="ml-1 text-[11px] text-muted-foreground">
                  ({t('this secretary')})
                </span>
              )}
              {!user.enabled && (
                <span className="ml-1 text-[11px] text-subtle-foreground">
                  · {t('Telegram off')}
                </span>
              )}
              {places.length === 0 ? (
                <p className="text-[11.5px] text-subtle-foreground">{t('Nothing bound yet')}</p>
              ) : (
                <ul className="text-[11.5px] text-muted-foreground">
                  {places.map((place) => (
                    <li key={place} className="truncate">
                      · {place}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
