import { secretaryAvatarUrl } from '@shared/localImage';
import type {
  SecretaryProfile,
  SecretaryProfileDraft,
  SecretaryScheduleView,
} from '@shared/types/secretary';
import * as React from 'react';
import { defaultDraft, draftFromProfile } from '@/components/secretary/profileFormState';
import {
  NOTIFY_LABELS,
  REPLY_LANGUAGE_LABELS,
  STYLE_LABELS,
} from '@/components/secretary/profileLabels';
import { SecretaryProfileForm } from '@/components/secretary/SecretaryProfileForm';
import { SecretaryResetDialog } from '@/components/secretary/SecretaryResetDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';

function Chips<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs transition-colors',
            option.value === value
              ? 'border-primary/60 bg-primary/10 text-foreground'
              : 'border-border text-muted-foreground hover:bg-muted'
          )}
        >
          {t(option.label)}
        </button>
      ))}
    </div>
  );
}

function Section({
  title,
  description,
  rowId,
  children,
}: {
  title: string;
  description?: string;
  rowId: string;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="space-y-3" data-settings-row={rowId}>
      <div>
        <h4 className="text-sm font-medium">{t(title)}</h4>
        {description ? <p className="text-xs text-muted-foreground">{t(description)}</p> : null}
      </div>
      {children}
    </section>
  );
}

function formatWhen(at: number | undefined, locale: string): string {
  if (!at) return '';
  return new Date(at).toLocaleString(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 设置 → 秘书：档案、风格与打扰、定时、重来 */
export function SecretarySettings() {
  const { t, locale } = useI18n();
  const [profile, setProfile] = React.useState<SecretaryProfile | null>(null);
  const [persona, setPersona] = React.useState('');
  const [styleDraft, setStyleDraft] = React.useState<SecretaryProfileDraft | null>(null);
  const [schedules, setSchedules] = React.useState<SecretaryScheduleView[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [resetOpen, setResetOpen] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const defaultName = t('Secretary');

  const loadSchedules = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.listSchedules();
    if (result.ok) setSchedules(result.schedules);
  }, []);

  const reload = React.useCallback(async () => {
    const result = await window.electronAPI.secretary.getProfile();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setProfile(result.profile);
    setPersona(result.persona);
    setStyleDraft(result.profile ? draftFromProfile(result.profile, defaultName) : null);
    await loadSchedules();
  }, [defaultName, loadSchedules]);

  React.useEffect(() => {
    void reload();
  }, [reload]);

  const save = async (draft: SecretaryProfileDraft) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.electronAPI.secretary.saveProfile(draft);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setProfile(result.profile);
      setStyleDraft(draftFromProfile(result.profile, defaultName));
      setNotice(t('Saved'));
      await loadSchedules();
    } catch {
      setError(t('Could not save the secretary profile. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const setAvatar = async (image: Uint8Array | null) => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.secretary.setAvatar(image);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setProfile(result.profile);
      setStyleDraft(draftFromProfile(result.profile, defaultName));
    } catch {
      setError(t('Could not save the secretary profile. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const removeSchedule = async (scheduleId: string) => {
    setError(null);
    const result = await window.electronAPI.secretary.removeSchedule(scheduleId);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    await loadSchedules();
  };

  return (
    <div className="space-y-8">
      <div>
        <h3 className="text-lg font-medium">{t('Secretary')}</h3>
        <p className="text-sm text-muted-foreground">
          {t(
            'The secretary is not part of any project. It watches your projects, dispatches sessions and reports results back. It never reads or writes code itself.'
          )}
        </p>
      </div>

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}

      <Section
        title="Secretary profile"
        description="Name, avatar, model and how much the secretary may do on its own."
        rowId="secretary.profile"
      >
        {profile ? (
          <div className="flex items-center gap-2">
            {profile.avatar.imageVersion ? (
              <img
                src={secretaryAvatarUrl(profile.avatar.imageVersion)}
                alt={profile.name}
                className="size-8 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white"
                style={{ backgroundColor: profile.avatar.color }}
              >
                {[...profile.name][0] ?? '·'}
              </span>
            )}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (!file) return;
                void file.arrayBuffer().then((buffer) => setAvatar(new Uint8Array(buffer)));
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              {t('Upload image')}
            </Button>
            {profile.avatar.imageVersion ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => void setAvatar(null)}
              >
                {t('Remove image')}
              </Button>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t('The secretary has not been set up yet.')}
          </p>
        )}
        <SecretaryProfileForm
          key={profile?.updatedAt ?? 'new'}
          initialDraft={
            profile ? draftFromProfile(profile, defaultName) : defaultDraft(defaultName)
          }
          submitLabel={t('Save')}
          busy={busy}
          onSubmit={(draft) => void save(draft)}
        />
      </Section>

      {styleDraft ? (
        <Section
          title="Style and interruptions"
          description="What it calls you, reply language, style and system notifications."
          rowId="secretary.style"
        >
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-sm">{t('What to call you')}</p>
              <Input
                value={styleDraft.addressAs ?? ''}
                placeholder={t('Optional')}
                onChange={(event) =>
                  setStyleDraft({
                    ...styleDraft,
                    addressAs: event.target.value.trim() ? event.target.value : null,
                  })
                }
                className="max-w-xs"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Reply language')}</p>
              <Chips
                value={styleDraft.replyLanguage ?? 'ui'}
                options={(['ui', 'zh', 'en'] as const).map((value) => ({
                  value,
                  label: REPLY_LANGUAGE_LABELS[value],
                }))}
                onChange={(replyLanguage) => setStyleDraft({ ...styleDraft, replyLanguage })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Communication style')}</p>
              <Chips
                value={styleDraft.style ?? 'concise'}
                options={(['concise', 'detailed'] as const).map((value) => ({
                  value,
                  label: STYLE_LABELS[value],
                }))}
                onChange={(style) => setStyleDraft({ ...styleDraft, style })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('System notifications')}</p>
              <Chips
                value={styleDraft.notify ?? 'needs-user'}
                options={(['needs-user', 'with-done', 'off'] as const).map((value) => ({
                  value,
                  label: NOTIFY_LABELS[value],
                }))}
                onChange={(notify) => setStyleDraft({ ...styleDraft, notify })}
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Daily brief time')}</p>
              <Input
                type="time"
                value={styleDraft.dailyBriefAt ?? ''}
                onChange={(event) =>
                  setStyleDraft({ ...styleDraft, dailyBriefAt: event.target.value || null })
                }
                className="max-w-32"
              />
            </div>
            <div className="space-y-1.5">
              <p className="text-sm">{t('Persona')}</p>
              <Textarea
                value={persona}
                onChange={(event) => setPersona(event.target.value)}
                rows={4}
              />
            </div>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void save({
                  addressAs: styleDraft.addressAs ?? null,
                  replyLanguage: styleDraft.replyLanguage,
                  style: styleDraft.style,
                  notify: styleDraft.notify,
                  dailyBriefAt: styleDraft.dailyBriefAt ?? null,
                  persona,
                })
              }
            >
              {t('Save')}
            </Button>
          </div>
        </Section>
      ) : null}

      <Section title="Scheduled tasks" rowId="secretary.schedules">
        {schedules.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('Nothing scheduled')}</p>
        ) : (
          <div className="divide-y rounded-md border">
            {schedules.map((schedule) => (
              <div key={schedule.id} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{schedule.name}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {schedule.cron ?? schedule.at ?? ''}
                    {schedule.nextRunAt ? ` · ${formatWhen(schedule.nextRunAt, locale)}` : ''}
                  </p>
                </div>
                {schedule.system ? (
                  <span className="shrink-0 rounded bg-muted px-1.5 text-[10px] text-muted-foreground">
                    {t('Built-in')}
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void removeSchedule(schedule.id)}
                  >
                    {t('Remove')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="Reset the secretary and start over"
        description="Sessions and dispatch history are kept either way."
        rowId="secretary.reset"
      >
        <Button variant="outline" size="sm" onClick={() => setResetOpen(true)}>
          {t('Re-run setup')}
        </Button>
        <SecretaryResetDialog
          open={resetOpen}
          onOpenChange={setResetOpen}
          onReset={() => {
            setProfile(null);
            setStyleDraft(null);
            setPersona('');
            setNotice(null);
            void loadSchedules();
          }}
        />
      </Section>
    </div>
  );
}
