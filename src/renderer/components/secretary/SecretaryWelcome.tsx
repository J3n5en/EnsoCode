import type { SecretaryProfileDraft } from '@shared/types/secretary';
import * as React from 'react';
import { useI18n } from '@/i18n';
import { useSecretaryStore } from '@/stores/secretary';
import { defaultDraft } from './profileFormState';
import { SecretaryFace } from './SecretaryFace';
import { SecretaryProfileForm } from './SecretaryProfileForm';

/**
 * 初次设置页。挂在主区域而不是弹窗里，远端浏览器（PWA 完整模式）同样能走完；
 * 两条路径写的是同一份档案，之后都能在设置页改。
 */
export function SecretaryWelcome() {
  const { t } = useI18n();
  const [mode, setMode] = React.useState<'choose' | 'form'>('choose');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const initialDraft = React.useMemo(() => defaultDraft(t('Secretary')), [t]);

  const startChat = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await useSecretaryStore.getState().newSecretaryConversation({ greeting: true });
      if (!id) {
        setError(t('Could not start the secretary. Try again.'));
        return;
      }
      useSecretaryStore.getState().closeWelcome();
    } catch {
      setError(t('Could not start the secretary. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  const saveAndStart = async (draft: SecretaryProfileDraft) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await window.electronAPI.secretary.saveProfile(draft);
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      const id = await useSecretaryStore.getState().newSecretaryConversation();
      if (!id) {
        setError(t('Could not start the secretary. Try again.'));
        return;
      }
      useSecretaryStore.getState().closeWelcome();
    } catch {
      setError(t('Could not start the secretary. Try again.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-enso="secretary-welcome"
      className="absolute inset-0 z-10 overflow-y-auto bg-background"
      // 透明背景（html.bg-image-enabled）下 --color-background 的 alpha 是 0，
      // bg-background 等于全透；引导是独占页，这里用原始令牌铺实底，挡住背后的会话
      style={{ backgroundColor: 'var(--background)' }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center gap-6 px-6 py-10">
        <div className="space-y-2">
          <SecretaryFace
            name={t('Secretary')}
            color={initialDraft.avatar?.color}
            className="size-10"
          />
          <h2 className="text-lg font-medium">{t('Set up your secretary')}</h2>
          <p className="max-w-lg text-sm text-muted-foreground">
            {t(
              'The secretary is not part of any project. It watches your projects, dispatches sessions and reports results back. It never reads or writes code itself.'
            )}
          </p>
        </div>

        {mode === 'choose' ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              data-enso="secretary-welcome-form"
              disabled={busy}
              onClick={() => setMode('form')}
              className="rounded-lg border px-4 py-3 text-left transition-colors hover:border-brand/50 hover:bg-muted/40 disabled:opacity-50"
            >
              <span className="text-sm font-medium">{t('Set up with a form')}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t(
                  'One page: name, avatar, visible projects and patrol. Every field has a default.'
                )}
              </span>
            </button>
            <button
              type="button"
              data-enso="secretary-welcome-chat"
              disabled={busy}
              onClick={() => void startChat()}
              className="rounded-lg border px-4 py-3 text-left transition-colors hover:border-brand/50 hover:bg-muted/40 disabled:opacity-50"
            >
              <span className="text-sm font-medium">{t('Set up by chatting')}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {t('The secretary asks a few questions and hands you a profile card to confirm.')}
              </span>
            </button>
          </div>
        ) : (
          <SecretaryProfileForm
            initialDraft={initialDraft}
            submitLabel={t('Start')}
            onSubmit={(draft) => void saveAndStart(draft)}
            busy={busy}
            error={error}
            allowDefaults
            onCancel={() => setMode('choose')}
          />
        )}

        {mode === 'choose' ? (
          <div className="space-y-2">
            <button
              type="button"
              data-enso="secretary-welcome-defaults"
              disabled={busy}
              onClick={() => void saveAndStart(initialDraft)}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {t('Use all defaults and start')} →
            </button>
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
          </div>
        ) : null}

        <button
          type="button"
          data-enso="secretary-welcome-later"
          onClick={() => useSecretaryStore.getState().closeWelcome()}
          className="w-fit text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {t('Later')}
        </button>
      </div>
    </div>
  );
}
