import {
  DEFAULT_GIT_COMMIT_PROMPT,
  GIT_COMMIT_PROMPT_MAX_CHARS,
  GIT_COMMIT_SETTINGS_ROW,
} from '@shared/gitCommitMessage';
import { useEffect, useState } from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Textarea } from '@/components/ui/textarea';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { useAppViewStore } from '@/stores/appView';
import { useOneShotProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import { SettingsButton, SettingsExpandableRow, SettingsRow, SettingsSection } from './kit';

const GIT_COMMIT_MODEL_ROW = 'providers.gitCommitModel';
const GIT_COMMIT_PROMPT_ROW = 'providers.gitCommitPrompt';
const DEEP_LINK_ROWS: readonly string[] = [
  GIT_COMMIT_SETTINGS_ROW,
  GIT_COMMIT_MODEL_ROW,
  GIT_COMMIT_PROMPT_ROW,
];

/** 模型中心「Git Commit 生成」：默认折叠，深链或设置搜索命中时展开；提示词正文经 IPC 存独立文件，settings 只存标记 */
export function GitCommitSettings({ revealRowId }: { revealRowId?: string | null } = {}) {
  const { t } = useI18n();
  const model = useSettingsStore((state) => state.gitCommitModel);
  const setModel = useSettingsStore((state) => state.setGitCommitModel);
  const customized = useSettingsStore((state) => state.gitCommitPromptCustomized);
  const setCustomized = useSettingsStore((state) => state.setGitCommitPromptCustomized);
  const providers = useOneShotProviders();
  const provider = model ? providers.find((entry) => entry.id === model.providerId) : undefined;
  const selectedModel = provider?.models.find(
    (entry) => entry.id === model?.modelId && entry.enabled !== false
  );
  const unavailable = Boolean(model && !selectedModel);
  // 深链每来一条 linkSeq 加一：手动收起后再点同一链接也要重新展开
  const deepLinkSeq = useAppViewStore((state) =>
    state.settings?.link && DEEP_LINK_ROWS.includes(state.settings.link.rowId)
      ? state.settings.linkSeq
      : null
  );
  // 设置搜索命中只改 SettingsContent 的 flashRowId，不经 appView 深链
  const revealed = revealRowId != null && DEEP_LINK_ROWS.includes(revealRowId);
  const [open, setOpen] = useState(deepLinkSeq !== null || revealed);
  useEffect(() => {
    if (deepLinkSeq !== null || revealed) setOpen(true);
  }, [deepLinkSeq, revealed]);
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

  const summary = unavailable ? (
    <span className="text-destructive text-xs">{t('Selected model is unavailable')}</span>
  ) : (
    <span className="max-w-[280px] truncate text-muted-foreground text-xs">
      {provider && selectedModel
        ? `${provider.name} / ${selectedModel.label ?? selectedModel.id}`
        : t('Not configured')}
    </span>
  );

  return (
    <SettingsSection>
      <SettingsExpandableRow
        // 锚点放在折叠行本身：设置搜索目录靠它收录「Git Commit 生成」，深链也落在这一行
        rowId={GIT_COMMIT_SETTINGS_ROW}
        label={t('Git commit generation')}
        description={t('Model and prompt used by the AI button in the Git commit panel.')}
        control={summary}
        open={open}
        onOpenChange={setOpen}
      >
        <SettingsRow
          indent
          rowId={GIT_COMMIT_MODEL_ROW}
          label={t('Model')}
          status={
            unavailable ? (
              <span className="text-destructive text-xs">
                {t('The selected model is unavailable. Choose another one.')}
              </span>
            ) : undefined
          }
        >
          {model && (
            <SettingsButton variant="ghost" onClick={() => setModel(null)}>
              {t('Clear')}
            </SettingsButton>
          )}
          {providers.length > 0 && (
            <div className="w-[280px] max-w-full">
              <ModelPicker
                providers={providers}
                providerId={selectedModel ? (provider?.id ?? '') : ''}
                modelId={selectedModel?.id ?? ''}
                reasoningEnabled={false}
                thinkingLevel="medium"
                showReasoningControls={false}
                emptyLabel={t('Select model')}
                side="bottom"
                triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                onSelect={(providerId, modelId) => setModel({ providerId, modelId })}
                onReasoningChange={() => {}}
                onThinkingChange={() => {}}
              />
            </div>
          )}
        </SettingsRow>
        <SettingsRow indent layout="stack" rowId={GIT_COMMIT_PROMPT_ROW} label={t('Prompt')}>
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
          <div className="mt-2 flex justify-end gap-2">
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
        </SettingsRow>
      </SettingsExpandableRow>
    </SettingsSection>
  );
}
