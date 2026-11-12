import { resolveChatModel, scopedDefaultModels } from '@shared/defaultModel';
import {
  groupWorkflowMembers,
  type WorkflowMemberSnapshot,
  type WorkflowMemberStatus,
  type WorkflowPresetSummary,
  type WorkflowRunSnapshot,
  type WorkflowRunStatus,
} from '@shared/types/workflow';
import { buildWorkflowPresetMessage } from '@shared/workflowPresetMessage';
import { Eraser, Play, RefreshCw, Settings2, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addToast } from '@/components/ui/toast';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { readMaterializedProviders } from '@/stores/modelDirectory/useProviders';
import { oauthCredentialContext, useOauthCredentialStore } from '@/stores/oauthCredentials';
import { useSessionsStore } from '@/stores/sessions';
import { useSettingsStore } from '@/stores/settings';
import { useWorkflowRunsStore } from '@/stores/workflowRuns';

const STATUS_CLASS: Record<WorkflowRunStatus | WorkflowMemberStatus, string> = {
  running: 'bg-amber-500',
  completed: 'bg-emerald-500',
  failed: 'bg-destructive',
  cancelled: 'bg-muted-foreground',
};

const EMPTY_RUNS: WorkflowRunSnapshot[] = [];

const SOURCE_LABEL: Record<WorkflowPresetSummary['source'], string> = {
  project: 'Project',
  custom: 'Custom',
  global: 'Global',
  plugin: 'Plugin',
  builtin: 'Built-in',
};

/** 以一条普通用户消息触发：模型按 id 调 workflow 工具，结果自然回到会话里。 */
function runPreset(
  conversationId: string,
  preset: WorkflowPresetSummary,
  values: Record<string, string>,
  t: ReturnType<typeof useI18n>['t']
): boolean {
  const sessions = useSessionsStore.getState();
  const conversation = sessions.conversations[conversationId];
  const settings = useSettingsStore.getState();
  const project = settings.projects.find((entry) => entry.id === conversation?.projectId);
  if (!conversation || !project) return false;
  const resolution = resolveChatModel({
    defaultModel: settings.defaultModel,
    ...scopedDefaultModels(project, settings.projectGroups),
    lastProviderId: conversation.lastProviderId,
    lastModelId: conversation.lastModelId,
    providers: readMaterializedProviders(),
    credentials: oauthCredentialContext(useOauthCredentialStore.getState().snapshot),
    virtualModels: settings.virtualModels,
  });
  if (resolution.source === 'none') {
    addToast({
      type: 'warning',
      title: t(
        'No usable model is available. Configure provider credentials and enable a model first.'
      ),
    });
    return false;
  }
  const args: Record<string, string> = {};
  for (const arg of preset.args) {
    const value = values[arg.key]?.trim();
    if (value) args[arg.key] = value;
  }
  void sessions.send(
    buildWorkflowPresetMessage({
      id: preset.id,
      name: preset.source === 'builtin' ? t(preset.name) : preset.name,
      args,
    }),
    { providerId: resolution.providerId, modelId: resolution.modelId, cwd: project.path },
    undefined,
    conversationId
  );
  return true;
}

function PresetRow({
  conversationId,
  preset,
  open,
  onToggle,
}: {
  conversationId: string;
  preset: WorkflowPresetSummary;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState<Record<string, string>>({});
  const missing = preset.args.some(
    (arg) => arg.required && !arg.default?.trim() && !values[arg.key]?.trim()
  );
  const name = preset.source === 'builtin' ? t(preset.name) : preset.name;
  const description = preset.source === 'builtin' ? t(preset.description) : preset.description;
  return (
    <li className="rounded-md border">
      <button
        type="button"
        className="w-full px-2 py-1.5 text-left text-xs hover:bg-muted/60"
        onClick={onToggle}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{name}</span>
          <span className="shrink-0 text-muted-foreground">{t(SOURCE_LABEL[preset.source])}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-muted-foreground">{description}</p>
      </button>
      {open ? (
        <form
          className="space-y-2 border-t px-2 py-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (missing || !runPreset(conversationId, preset, values, t)) return;
            setValues({});
            onToggle();
          }}
        >
          {preset.args.map((arg) => (
            <label key={arg.key} className="block text-xs">
              <span className="text-muted-foreground">
                {preset.source === 'builtin' ? t(arg.label) : arg.label}
                {arg.required ? ' *' : ''}
              </span>
              <Input
                size="sm"
                className="mt-1"
                value={values[arg.key] ?? ''}
                placeholder={arg.default}
                onChange={(event) =>
                  setValues((current) => ({ ...current, [arg.key]: event.target.value }))
                }
              />
            </label>
          ))}
          <div className="flex justify-end">
            <Button type="submit" size="xs" disabled={missing}>
              <Play />
              {t('Run')}
            </Button>
          </div>
        </form>
      ) : null}
    </li>
  );
}

function PresetList({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<WorkflowPresetSummary[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const disabled = useSettingsStore((state) => state.disabledWorkflowPresets);
  const presetId = useSessionsStore((state) => state.conversations[conversationId]?.presetId);
  const load = useCallback(() => {
    let cancelled = false;
    window.electronAPI.assets
      .listWorkflowPresets(conversationId, presetId)
      .then((listed) => {
        if (!cancelled) setPresets(listed);
      })
      .catch(() => {
        if (!cancelled) setPresets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, presetId]);
  useEffect(load, [load]);
  // 开关状态在渲染侧设置里，切换即时生效；worker 执行时同样拦截已禁用的内置预设
  const visible = presets.filter(
    (preset) => preset.source !== 'builtin' || !disabled.includes(preset.id)
  );
  return (
    <section>
      <div className="mb-1.5 flex items-center gap-2">
        <h3 className="flex-1 text-xs font-medium text-muted-foreground">{t('Presets')}</h3>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('Manage workflow presets')}
          title={t('Manage workflow presets')}
          onClick={() =>
            void window.electronAPI.window.openSettings({
              category: 'workflows',
              rowId: 'workflows.root',
            })
          }
        >
          <Settings2 />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={t('Refresh')}
          onClick={() => load()}
        >
          <RefreshCw />
        </Button>
      </div>
      <ul className="space-y-1.5">
        {visible.map((preset) => (
          <PresetRow
            key={`${preset.source}:${preset.id}`}
            conversationId={conversationId}
            preset={preset}
            open={openId === preset.id}
            onToggle={() => setOpenId((current) => (current === preset.id ? null : preset.id))}
          />
        ))}
      </ul>
    </section>
  );
}

function openMember(conversationId: string, childId: string): void {
  const sessions = useSessionsStore.getState();
  if (sessions.activeId !== conversationId) sessions.selectConversation(conversationId);
  sessions.selectTab(conversationId, childId);
}

function MemberRow({
  conversationId,
  member,
}: {
  conversationId: string;
  member: WorkflowMemberSnapshot;
}) {
  const { t } = useI18n();
  const body = (
    <>
      <div className="flex items-center gap-2">
        <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_CLASS[member.status])} />
        <span className="min-w-0 flex-1 truncate">{member.label}</span>
        <span className="text-muted-foreground">{t(member.status)}</span>
      </div>
      {member.prompt ? (
        <p className="mt-0.5 truncate pl-3.5 text-muted-foreground">{member.prompt}</p>
      ) : null}
      {member.result ? (
        <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap pl-3.5 text-foreground/80">
          {member.result}
        </p>
      ) : null}
    </>
  );
  const childId = member.childId;
  if (!childId) return <li className="text-xs">{body}</li>;
  return (
    <li>
      <button
        type="button"
        className="w-full rounded px-1 py-0.5 text-left text-xs hover:bg-muted/60"
        onClick={() => openMember(conversationId, childId)}
      >
        {body}
      </button>
    </li>
  );
}

export function WorkflowView({ conversationId }: { conversationId: string }) {
  const { t } = useI18n();
  const runs = useWorkflowRunsStore((state) => state.byConversation[conversationId]) ?? EMPTY_RUNS;
  const clearFinished = useWorkflowRunsStore((state) => state.clearFinished);
  const hasFinished = runs.some((run) => run.status !== 'running');
  return (
    <div className="h-full overflow-auto bg-background p-3">
      <div className="space-y-3">
        <PresetList conversationId={conversationId} />
        {hasFinished ? (
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => clearFinished(conversationId)}
            >
              <Eraser />
              {t('Clear finished runs')}
            </Button>
          </div>
        ) : null}
        {runs.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">{t('No workflow runs')}</p>
        ) : null}
        {runs.map((run) => (
          <section key={run.runId} className="rounded-md border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_CLASS[run.status])} />
              <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{run.name}</h3>
              <span className="text-xs text-muted-foreground">{t(run.status)}</span>
              {run.status === 'running' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground hover:text-destructive"
                  aria-label={t('Stop')}
                  title={t('Stop')}
                  onClick={() =>
                    void window.electronAPI.agent.stopWorkflow(conversationId, run.runId)
                  }
                >
                  <Square />
                </Button>
              ) : null}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{run.description}</p>
            <p className="mt-2 text-xs text-muted-foreground">
              {t('{{count}} agents', { count: run.members.length })}
            </p>
            <div className="mt-2 space-y-2">
              {groupWorkflowMembers(run.members).map((group, index, groups) => {
                const showPhase = Boolean(group.phase) && group.phase !== groups[index - 1]?.phase;
                return (
                  <div key={`${group.batch}:${group.phase ?? ''}`}>
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      {showPhase ? <span className="font-medium">{group.phase}</span> : null}
                      {group.members.length > 1 ? (
                        <span className="text-muted-foreground">{t('Parallel')}</span>
                      ) : null}
                    </div>
                    <ul className="space-y-1">
                      {group.members.map((member) => (
                        <MemberRow
                          key={member.seq}
                          conversationId={conversationId}
                          member={member}
                        />
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
            {run.error ? <p className="mt-2 text-xs text-destructive">{run.error}</p> : null}
            {run.logs.length > 0 ? (
              <p className="mt-2 whitespace-pre-wrap text-xs text-muted-foreground">
                {run.logs.join('\n')}
              </p>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}
