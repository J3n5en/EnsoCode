import {
  GIT_COMMIT_SETTINGS_ROW,
  type GitCommitConfigIssue,
  gitCommitConfigIssue,
} from '@shared/gitCommitMessage';
import type { GitRequest } from '@shared/types/git';
import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '@/components/chat/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { openSettings } from '@/stores/appView';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';

/** 提交信息输入框旁的「AI 生成」：校验配置 → 生成 → 回填；进行中再点即取消，取消后结果作废 */
export function GitCommitAiButton({
  request,
  message,
  disabled,
  onGenerated,
  onRunningChange,
}: {
  request: GitRequest;
  message: string;
  disabled: boolean;
  onGenerated: (message: string) => void;
  onRunningChange?: (running: boolean) => void;
}) {
  const { t } = useI18n();
  const model = useSettingsStore((state) => state.gitCommitModel);
  const providers = useUsableProviders();
  const [running, setRunning] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const current = useRef<string | null>(null);
  const runningChange = useRef(onRunningChange);
  runningChange.current = onRunningChange;

  useEffect(() => {
    runningChange.current?.(running);
  }, [running]);

  useEffect(
    () => () => {
      // 切到历史等导致卸载：取消在途请求并解锁父级输入框
      const requestId = current.current;
      current.current = null;
      if (!requestId) return;
      runningChange.current?.(false);
      void window.electronAPI.git.abortCommitMessage({ requestId }).catch(() => {});
    },
    []
  );

  const notConfigured = (issue: GitCommitConfigIssue) =>
    addToast({
      type: 'warning',
      title: t('Git commit generation is not configured'),
      description: t(
        issue === 'provider'
          ? 'Choose a provider and model for Git commit generation in Model Providers.'
          : 'The selected model is unavailable. Choose another one in Model Providers.'
      ),
      actions: [
        {
          label: t('Open settings'),
          onClick: () => openSettings({ category: 'providers', rowId: GIT_COMMIT_SETTINGS_ROW }),
        },
      ],
    });

  const fail = (error: string) =>
    addToast({
      type: 'error',
      title: t('Could not generate a commit message'),
      description: error,
    });

  const generate = async () => {
    const requestId = crypto.randomUUID();
    current.current = requestId;
    setRunning(true);
    try {
      const result = await window.electronAPI.git.generateCommitMessage({ ...request, requestId });
      if (current.current !== requestId) return;
      if (result.ok) onGenerated(result.message);
      else if (result.code === 'not-configured') notConfigured(result.missing);
      else if (result.code === 'no-changes')
        addToast({ type: 'info', title: t('No changes to commit.') });
      else if (result.code !== 'aborted') fail(t(result.error));
    } catch (error) {
      if (current.current === requestId)
        fail(error instanceof Error ? error.message : String(error));
    } finally {
      if (current.current === requestId) {
        current.current = null;
        setRunning(false);
      }
    }
  };

  const cancel = () => {
    const requestId = current.current;
    current.current = null;
    setRunning(false);
    if (requestId) void window.electronAPI.git.abortCommitMessage({ requestId }).catch(() => {});
  };

  const onClick = () => {
    if (running) return cancel();
    const issue = gitCommitConfigIssue(model, providers);
    if (issue) return notConfigured(issue);
    if (message.trim()) setConfirm(true);
    else void generate();
  };

  const label = t(running ? 'Cancel generation' : 'Generate commit message with AI');
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className="mb-0.5 shrink-0"
        data-git-ai-generate=""
        title={label}
        aria-label={label}
        aria-busy={running}
        disabled={!running && disabled}
        onClick={onClick}
      >
        {running ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          <Sparkles className="size-3.5" />
        )}
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('Replace the current commit message?')}
        description={t('The AI-generated message will overwrite what you have typed.')}
        confirmLabel={t('Replace')}
        onConfirm={() => {
          setConfirm(false);
          void generate();
        }}
      />
    </>
  );
}
