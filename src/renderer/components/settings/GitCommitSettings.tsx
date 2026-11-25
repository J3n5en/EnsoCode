import {
  DEFAULT_GIT_COMMIT_PROMPT,
  GIT_COMMIT_PROMPT_MAX_CHARS,
  GIT_COMMIT_SETTINGS_ROW,
} from '@shared/gitCommitMessage';
import { useEffect, useState } from 'react';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsRow, SettingsSection, SettingsSelect } from './kit';

/** 模型中心「Git Commit 生成」：供应商 → 模型联动；提示词正文经 IPC 存独立文件，settings 只存标记 */
export function GitCommitSettings() {
  const { t } = useI18n();
  const model = useSettingsStore((state) => state.gitCommitModel);
  const setModel = useSettingsStore((state) => state.setGitCommitModel);
  const customized = useSettingsStore((state) => state.gitCommitPromptCustomized);
  const setCustomized = useSettingsStore((state) => state.setGitCommitPromptCustomized);
  const providers = useUsableProviders();
  const provider = model ? providers.find((entry) => entry.id === model.providerId) : undefined;
  const models = provider?.models.filter((entry) => entry.enabled !== false) ?? [];
  const selectedModel = models.find((entry) => entry.id === model?.modelId);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void window.electronAPI.git
      .readCommitPrompt()
      .then((result) => {
        if (!active) return;
        const text =
          result.ok && result.custom && customized ? result.text : DEFAULT_GIT_COMMIT_PROMPT;
        setSaved(text);
        setDraft(text);
      })
      .catch(() => {
        if (active) {
          setSaved(DEFAULT_GIT_COMMIT_PROMPT);
          setDraft(DEFAULT_GIT_COMMIT_PROMPT);
        }
      });
    return () => {
      active = false;
    };
  }, [customized]);

  const fail = (error?: string) =>
    addToast({ type: 'error', title: t('Could not save the prompt'), description: error });

  const persist = async (
    action: () => Promise<{ ok: boolean; error?: string }>,
    next: string,
    custom: boolean
  ) => {
    setBusy(true);
    try {
      const result = await action();
      if (!result.ok) return fail(result.error);
      setSaved(next);
      setDraft(next);
      setCustomized(custom);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const providerOptions = [
    ...(provider ? [] : [{ value: '', label: t('Select provider') }]),
    ...providers.map((entry) => ({ value: entry.id, label: entry.name })),
  ];
  const modelOptions = [
    ...(selectedModel ? [] : [{ value: '', label: t('Select model') }]),
    ...models.map((entry) => ({ value: entry.id, label: entry.label ?? entry.id })),
  ];

  return (
    <SettingsSection
      rowId={GIT_COMMIT_SETTINGS_ROW}
      title={t('Git commit generation')}
      description={t('Model and prompt used by the AI button in the Git commit panel.')}
    >
      <SettingsRow
        rowId="providers.provider"
        label={t('Provider')}
        status={
          model && (!provider || !selectedModel) ? (
            <span className="text-destructive text-xs">
              {t('The selected model is unavailable. Choose another one.')}
            </span>
          ) : undefined
        }
      >
        <SettingsSelect
          value={provider?.id ?? ''}
          options={providerOptions}
          width="wide"
          onValueChange={(next) => {
            const entry = providers.find((item) => item.id === next);
            const first = entry?.models.find((item) => item.enabled !== false);
            if (entry && first) setModel({ providerId: entry.id, modelId: first.id });
          }}
        />
      </SettingsRow>
      <SettingsRow rowId="providers.gitCommitModel" label={t('Model')}>
        <SettingsSelect
          value={selectedModel?.id ?? ''}
          options={modelOptions}
          width="wide"
          disabled={!provider}
          onValueChange={(next) => {
            if (provider && next) setModel({ providerId: provider.id, modelId: next });
          }}
        />
      </SettingsRow>
      <div className="space-y-2 px-4 py-3 max-sm:px-3">
        <p className="font-medium text-[13px] leading-5">{t('Prompt')}</p>
        <Textarea
          size="sm"
          rows={8}
          value={draft}
          maxLength={GIT_COMMIT_PROMPT_MAX_CHARS}
          aria-label={t('Prompt')}
          disabled={saved === null || busy}
          className="font-mono text-xs"
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex justify-end gap-2">
          <SettingsButton
            variant="ghost"
            disabled={
              busy || saved === null || (!customized && draft === DEFAULT_GIT_COMMIT_PROMPT)
            }
            onClick={() =>
              void persist(
                () => window.electronAPI.git.resetCommitPrompt(),
                DEFAULT_GIT_COMMIT_PROMPT,
                false
              )
            }
          >
            {t('Restore default')}
          </SettingsButton>
          <SettingsButton
            variant="default"
            disabled={busy || saved === null || !draft.trim() || draft === saved}
            onClick={() =>
              void persist(
                () => window.electronAPI.git.writeCommitPrompt({ text: draft }),
                draft,
                true
              )
            }
          >
            {t('Save')}
          </SettingsButton>
        </div>
      </div>
    </SettingsSection>
  );
}
