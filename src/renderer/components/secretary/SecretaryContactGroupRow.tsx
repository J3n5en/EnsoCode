import type {
  SecretaryContactGroupBinding,
  SecretaryContactTopic,
  SecretaryContactTopicsResult,
} from '@shared/types/secretary';
import { Check, ListChecks, Loader2, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

const GENERAL_TOPIC_ID = '1';

const BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12.5px] transition-colors hover:bg-muted disabled:opacity-50';

const TOPICS_ERROR: Record<string, string> = {
  network: 'Cannot reach api.telegram.org. Check the proxy.',
  unauthorized: 'Telegram rejected this token',
  api: 'Telegram returned an error',
  'token-required': 'Paste a bot token first',
  'not-group': 'This chat is not a group',
  'invalid-chat-id': 'Group chat IDs are numbers, e.g. -1001234567890',
  'invalid-topic': 'Pick at least one topic',
  'route-conflict': 'Another secretary already has this group or one of these topics',
};

type TopicsLoad =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error'; error: string; detail?: string }
  | { state: 'ready'; forum: boolean; topics: SecretaryContactTopic[] };

function Choice({
  role,
  checked,
  disabled,
  label,
  onClick,
  enso,
}: {
  role: 'radio' | 'checkbox';
  checked: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  enso: string;
}) {
  const props = {
    type: 'button' as const,
    'data-enso': enso,
    disabled,
    onClick,
    className: 'flex items-center gap-1.5 text-left text-[12px] disabled:opacity-50',
  };
  const body = (
    <>
      <span
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center border border-border',
          role === 'radio' ? 'rounded-full' : 'rounded',
          checked && 'border-foreground bg-foreground text-background'
        )}
      >
        {checked && <Check className="size-2.5" />}
      </span>
      {label}
    </>
  );
  return role === 'radio' ? (
    <button role="radio" aria-checked={checked} {...props}>
      {body}
    </button>
  ) : (
    <button role="checkbox" aria-checked={checked} {...props}>
      {body}
    </button>
  );
}

/**
 * 允许的群里的一行：显示交给秘书的是整群还是某几个论坛话题，可展开勾选话题或解绑。
 * 话题列表来自 Main（bot 见过的话题），拉取失败给出原因与重试。
 */
export function SecretaryContactGroupRow({
  group,
  secretaryId,
  busy,
  onRemove,
  onSaved,
}: {
  group: SecretaryContactGroupBinding;
  secretaryId?: string;
  busy: boolean;
  onRemove: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<TopicsLoad>({ state: 'idle' });
  const [all, setAll] = useState(group.all);
  const [picked, setPicked] = useState<string[]>(group.topics.map((topic) => topic.id));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const topicLabel = (topic: SecretaryContactTopic) =>
    topic.id === GENERAL_TOPIC_ID
      ? t('General (default topic)')
      : (topic.title ?? t('Topic #{{id}}', { id: topic.id }));
  const errorText = (error: string, detail?: string) => {
    const base = t(TOPICS_ERROR[error] ?? TOPICS_ERROR.api);
    const hint = error === 'api' ? ` ${t('Make sure the bot is in this group.')}` : '';
    return `${base}${detail ? `: ${detail}` : ''}${hint}`;
  };

  const fetchTopics = () => {
    setLoad({ state: 'loading' });
    void window.electronAPI.secretary.contactTelegramTopics(group.id, secretaryId).then(
      (result: SecretaryContactTopicsResult) =>
        setLoad(
          result.ok
            ? { state: 'ready', forum: result.forum, topics: result.topics }
            : {
                state: 'error',
                error: result.error,
                ...(result.detail ? { detail: result.detail } : {}),
              }
        ),
      () => setLoad({ state: 'error', error: 'api' })
    );
  };

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setAll(group.all);
    setPicked(group.topics.map((topic) => topic.id));
    setSaveError(null);
    setOpen(true);
    fetchTopics();
  };

  const save = () => {
    setSaving(true);
    setSaveError(null);
    void window.electronAPI.secretary
      .contactSettings(
        { telegramGroupScope: { chatId: group.id, scope: all ? 'all' : picked } },
        secretaryId
      )
      .then(
        (result) => {
          if (result.ok) {
            setOpen(false);
            onSaved();
          } else setSaveError(result.error);
        },
        () => setSaveError('api')
      )
      .finally(() => setSaving(false));
  };

  const name = group.title ?? group.id;
  const scope = group.all
    ? t('Whole group')
    : t('Topics: {{names}}', { names: group.topics.map(topicLabel).join(', ') });
  // 已绑但这次没拉到的话题也列出来，免得保存时被悄悄去掉
  const listed =
    load.state === 'ready'
      ? [
          ...load.topics,
          ...group.topics.filter((topic) => !load.topics.some((item) => item.id === topic.id)),
        ]
      : [];
  const disabled = busy || saving;

  return (
    <li data-enso="secretary-contact-group" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px]">
          {group.title ? (
            <>
              {group.title}{' '}
              <span className="font-mono text-[11px] text-muted-foreground">{group.id}</span>
            </>
          ) : (
            <span className="font-mono text-[11.5px]">{group.id}</span>
          )}
          <span
            data-enso="secretary-contact-group-scope"
            className="ml-1.5 text-[11px] text-muted-foreground"
          >
            · {scope}
          </span>
        </span>
        <button
          type="button"
          data-enso="secretary-contact-group-topics"
          disabled={busy}
          aria-expanded={open}
          aria-label={t('Choose topics for {{name}}', { name })}
          className={BUTTON_CLASS}
          onClick={toggleOpen}
        >
          <ListChecks className="size-3.5" />
        </button>
        <button
          type="button"
          data-enso="secretary-contact-group-remove"
          disabled={busy}
          aria-label={t('Remove {{name}}', { name })}
          className={BUTTON_CLASS}
          onClick={onRemove}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {open && (
        <div
          data-enso="secretary-contact-group-picker"
          className="flex flex-col gap-1.5 rounded-lg bg-muted/40 px-2.5 py-2"
        >
          {load.state === 'loading' && (
            <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t('Loading topics…')}
            </p>
          )}
          {load.state === 'error' && (
            <div className="flex flex-wrap items-center gap-1.5">
              <p
                data-enso="secretary-contact-topics-error"
                className="min-w-0 flex-1 text-[11.5px] text-destructive"
              >
                {t('Could not load topics: {{reason}}', {
                  reason: errorText(load.error, load.detail),
                })}
              </p>
              <button
                type="button"
                data-enso="secretary-contact-topics-retry"
                className={BUTTON_CLASS}
                onClick={fetchTopics}
              >
                <RefreshCw className="size-3.5" />
                {t('Retry')}
              </button>
            </div>
          )}
          {load.state === 'ready' && (
            <>
              <Choice
                role="radio"
                enso="secretary-contact-scope-all"
                checked={all}
                disabled={disabled}
                label={t('Whole group (General and every topic)')}
                onClick={() => setAll(true)}
              />
              {load.forum ? (
                <>
                  <Choice
                    role="radio"
                    enso="secretary-contact-scope-topics"
                    checked={!all}
                    disabled={disabled}
                    label={t('Only the topics I pick')}
                    onClick={() => setAll(false)}
                  />
                  {!all && (
                    <div className="ml-5 flex flex-col gap-1">
                      {listed.map((topic) => (
                        <Choice
                          key={topic.id}
                          role="checkbox"
                          enso="secretary-contact-topic"
                          checked={picked.includes(topic.id)}
                          // 已经单独归了同一个 bot 上的别的秘书：勾了也会整次保存被拒
                          disabled={
                            disabled || (Boolean(topic.owner) && !picked.includes(topic.id))
                          }
                          label={
                            topic.owner
                              ? `${topicLabel(topic)} · ${t('taken by {{owner}}', { owner: topic.owner })}`
                              : topicLabel(topic)
                          }
                          onClick={() =>
                            setPicked((prev) =>
                              prev.includes(topic.id)
                                ? prev.filter((id) => id !== topic.id)
                                : [...prev, topic.id]
                            )
                          }
                        />
                      ))}
                      <p className="text-[11px] text-subtle-foreground">
                        {t(
                          'Only topics the bot has seen are listed. If one is missing, send a message in that topic, then refresh. Topics you leave unchecked are ignored.'
                        )}
                      </p>
                    </div>
                  )}
                </>
              ) : (
                <p className="text-[11.5px] text-muted-foreground">
                  {t('This group has no topics, so it can only be bound as a whole.')}
                </p>
              )}
              {saveError && (
                <p className="text-[11.5px] text-destructive">{errorText(saveError)}</p>
              )}
              <div className="flex gap-1.5">
                <button
                  type="button"
                  data-enso="secretary-contact-scope-save"
                  disabled={disabled || (!all && picked.length === 0)}
                  className={BUTTON_CLASS}
                  onClick={save}
                >
                  <Check className="size-3.5" />
                  {t('Save')}
                </button>
                <button
                  type="button"
                  data-enso="secretary-contact-topics-refresh"
                  disabled={disabled}
                  className={BUTTON_CLASS}
                  onClick={fetchTopics}
                >
                  <RefreshCw className="size-3.5" />
                  {t('Refresh')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  );
}
