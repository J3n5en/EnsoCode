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
  checked,
  disabled,
  label,
  onClick,
  enso,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  enso: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      data-enso={enso}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1.5 text-left text-[12px] disabled:opacity-50"
    >
      <span
        className={cn(
          'flex size-3.5 shrink-0 items-center justify-center rounded border border-border',
          checked && 'border-foreground bg-foreground text-background'
        )}
      >
        {checked && <Check className="size-2.5" />}
      </span>
      {label}
    </button>
  );
}

function Segment({
  checked,
  disabled,
  label,
  onClick,
  enso,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  enso: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      data-enso={enso}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'rounded-md px-2 py-0.5 text-[11.5px] transition-colors disabled:opacity-50',
        checked ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-muted'
      )}
    >
      {label}
    </button>
  );
}

/**
 * 允许的群里的一行：「整群 / 选话题」直接切换，选话题时展开勾选，也可解绑。
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

  const openPicker = () => {
    setPicked(group.topics.map((topic) => topic.id));
    setSaveError(null);
    setOpen(true);
    fetchTopics();
  };

  const save = (scope: 'all' | string[]) => {
    setSaving(true);
    setSaveError(null);
    void window.electronAPI.secretary
      .contactSettings({ telegramGroupScope: { chatId: group.id, scope } }, secretaryId)
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

  const chooseAll = () => {
    if (open) setOpen(false);
    if (!group.all) save('all');
  };

  const name = group.title ?? group.id;
  // 已绑但这次没拉到的话题也列出来，免得保存时被悄悄去掉
  const listed =
    load.state === 'ready'
      ? [
          ...load.topics,
          ...group.topics.filter((topic) => !load.topics.some((item) => item.id === topic.id)),
        ]
      : [];
  const disabled = busy || saving;
  const topicsMode = open || !group.all;

  return (
    <li data-enso="secretary-contact-group" className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span
          data-enso="secretary-contact-group-name"
          className="min-w-0 flex-1 truncate text-[12px]"
        >
          {group.title ? (
            <>
              {group.title}{' '}
              <span className="font-mono text-[11px] text-muted-foreground">{group.id}</span>
            </>
          ) : (
            <span className="font-mono text-[11.5px]">{group.id}</span>
          )}
        </span>
        <div
          role="radiogroup"
          aria-label={t('What {{name}} hands to this secretary', { name })}
          className="inline-flex shrink-0 rounded-lg border border-border p-0.5"
        >
          <Segment
            enso="secretary-contact-scope-all"
            checked={!topicsMode}
            disabled={disabled}
            label={t('Whole group')}
            onClick={chooseAll}
          />
          <Segment
            enso="secretary-contact-scope-topics"
            checked={topicsMode}
            disabled={disabled}
            label={t('Pick topics')}
            onClick={() => {
              if (!open) openPicker();
            }}
          />
        </div>
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
      {!group.all && !open && (
        <div className="flex items-center gap-1.5">
          <span
            data-enso="secretary-contact-group-scope"
            className="min-w-0 flex-1 truncate text-[11.5px] text-muted-foreground"
          >
            {t('Topics: {{names}}', { names: group.topics.map(topicLabel).join(', ') })}
          </span>
          <button
            type="button"
            data-enso="secretary-contact-group-topics"
            disabled={busy}
            className={BUTTON_CLASS}
            onClick={openPicker}
          >
            <ListChecks className="size-3.5" />
            {t('Change topics')}
          </button>
        </div>
      )}
      {saveError && !open && (
        <p className="text-[11.5px] text-destructive">{errorText(saveError)}</p>
      )}
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
          {load.state === 'ready' &&
            (load.forum ? (
              <>
                {listed.map((topic) => (
                  <Choice
                    key={topic.id}
                    enso="secretary-contact-topic"
                    checked={picked.includes(topic.id)}
                    // 已经单独归了同一个 bot 上的别的秘书：勾了也会整次保存被拒
                    disabled={disabled || (Boolean(topic.owner) && !picked.includes(topic.id))}
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
              </>
            ) : (
              <p className="text-[11.5px] text-muted-foreground">
                {t('This group has no topics, so it can only be bound as a whole.')}
              </p>
            ))}
          {saveError && <p className="text-[11.5px] text-destructive">{errorText(saveError)}</p>}
          <div className="flex gap-1.5">
            {load.state === 'ready' && load.forum && (
              <>
                <button
                  type="button"
                  data-enso="secretary-contact-scope-save"
                  disabled={disabled || picked.length === 0}
                  className={BUTTON_CLASS}
                  onClick={() => save(picked)}
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
              </>
            )}
            <button
              type="button"
              data-enso="secretary-contact-topics-cancel"
              disabled={saving}
              className={BUTTON_CLASS}
              onClick={() => setOpen(false)}
            >
              {t('Cancel')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
