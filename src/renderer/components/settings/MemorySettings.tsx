import type {
  ChatModelDto,
  DistillableSessionDto,
  EmbeddingDownloadProgressDto,
  EmbeddingModelDto,
  MemoryJobsSnapshot,
  MemoryStats,
} from '@shared/memory/dto';
import * as React from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import {
  usableProvidersForOauthSnapshot,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { type JobKind, toJobRows } from './memoryJobRows';
import { embeddingModelLabel } from './memoryModelItems';

/**
 * 记忆设置分页。开关写 settings.json（Main 侧 notifyMemoryEmbeddingSettings 会同步到 memoryHost），
 * 统计与后台任务走 memory:* IPC；库未启用时这些接口返回空值而不是报错。
 */

const JOBS_POLL_MS = 4000;
// 补齐进行中时轮询快一些，否则点完最长要等一整个 JOBS_POLL_MS 才有动静
const BACKFILL_POLL_MS = 800;
const VISIBLE_JOBS = 6;
// 用带前缀的 key：Distill / Entities 在别处已有不同语义的译文
const JOB_KIND_LABELS: Record<JobKind, string> = {
  distill: 'job:distill',
  kg: 'job:entities',
  reembed: 'job:vectors',
};

const EMPTY_JOBS: MemoryJobsSnapshot = { distill: [], kg: [], reembed: null };

// 模型清单来自 Main 的注册表（registry.ts），不在渲染层重写一份：
// 手写副本一旦 id 对不上，选中后会静默回落默认模型，用户完全看不出来
const REMOTE_MODEL_ID = 'remote:openai-compatible';

/**
 * 批量提炼前的分支：范围内全部未提炼 → 直接跑；有已提炼的 → 先问。
 * 抽成纯函数以便直接断言（SSR 渲染下拿不到弹窗交互）。
 */
export function needsBulkPrompt(scope: readonly { distilled: boolean }[]): boolean {
  return scope.some((session) => session.distilled);
}

interface BulkPrompt {
  token: string;
  label: string;
  scope: DistillableSessionDto[];
  pending: DistillableSessionDto[];
}

/**
 * 什么时候该把 embedding 失败原因摆出来：有记忆、有缺口、且拿到了原因。
 * 抽成纯函数以便直接断言（SSR 渲染下 useEffect 不执行，stats 恒为 null）。
 */
export function embeddingErrorNotice(stats: MemoryStats | null): string | null {
  if (!stats || stats.total === 0 || stats.embedded >= stats.total) return null;
  return stats.embeddingError ?? null;
}

/**
 * 选了本地 GGUF 但权重不在盘上时，提炼会静默 pending。
 * 不自动下载：E2B 就 3GB+，没点过下载不能当同意。
 */
export function localChatBlocksDistill(
  model: Pick<ChatModelDto, 'downloadable' | 'state'> | null
): 'missing' | 'downloading' | null {
  if (!model?.downloadable) return null;
  if (model.state === 'missing' || model.state === 'downloading') return model.state;
  return null;
}

export interface BatchProgress {
  done: number;
  total: number;
  startedAt: number;
}

/** 已完成的平均耗时 × 剩余个数；还没跑完一个时无法估算，返回 null 而不是编一个数 */
export function estimateRemainingMs(progress: BatchProgress, now: number): number | null {
  if (progress.done === 0 || progress.done >= progress.total) return null;
  const perItem = (now - progress.startedAt) / progress.done;
  return Math.round(perItem * (progress.total - progress.done));
}

export function formatDuration(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

export interface SessionGroup {
  key: string;
  name: string;
  sessions: DistillableSessionDto[];
}

/** 按项目分组；无项目的沉底。组内保持传入顺序（Main 已按 mtime 倒序） */
export function groupSessionsByProject(sessions: DistillableSessionDto[]): SessionGroup[] {
  const byProject = new Map<string, SessionGroup>();
  for (const session of sessions) {
    const key = session.projectId ?? '';
    const existing = byProject.get(key);
    if (existing) {
      existing.sessions.push(session);
      continue;
    }
    byProject.set(key, {
      key,
      name: session.projectName ?? 'No project',
      sessions: [session],
    });
  }
  const groups = [...byProject.values()];
  return [...groups.filter((g) => g.key), ...groups.filter((g) => !g.key)];
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

function SwitchRow({
  title,
  description,
  checked,
  onChange,
  rowId,
  disabled,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  rowId?: string;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
      data-settings-row={rowId}
    >
      <div className="min-w-0">
        <p className="text-sm">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
      />
    </div>
  );
}

export function MemorySettings({ onLibraryChanged }: { onLibraryChanged?: () => void } = {}) {
  const { t } = useI18n();
  const disabledBuiltinTools = useSettingsStore((state) => state.disabledBuiltinTools);
  const toggleBuiltinTool = useSettingsStore((state) => state.toggleBuiltinTool);
  const providers = useSettingsStore((state) => state.providers);
  const embeddingModel = useSettingsStore((state) => state.memoryEmbeddingModel);
  const setEmbeddingModel = useSettingsStore((state) => state.setMemoryEmbeddingModel);
  const autoDownload = useSettingsStore((state) => state.memoryEmbeddingAutoDownload);
  const setAutoDownload = useSettingsStore((state) => state.setMemoryEmbeddingAutoDownload);
  const remoteProviderId = useSettingsStore((state) => state.memoryEmbeddingRemoteProviderId);
  const setRemoteProviderId = useSettingsStore((state) => state.setMemoryEmbeddingRemoteProviderId);
  const distillEnabled = useSettingsStore((state) => state.memoryDistillEnabled);
  const setDistillEnabled = useSettingsStore((state) => state.setMemoryDistillEnabled);
  const kgEnabled = useSettingsStore((state) => state.memoryKgEnabled);
  const setKgEnabled = useSettingsStore((state) => state.setMemoryKgEnabled);
  const distillModel = useSettingsStore((state) => state.memoryDistillModel);
  const setDistillModel = useSettingsStore((state) => state.setMemoryDistillModel);
  const chatModel = useSettingsStore((state) => state.memoryChatModel) || 'remote';
  const setChatModel = useSettingsStore((state) => state.setMemoryChatModel);
  const memoryLanguage = useSettingsStore((state) => state.memoryLanguage);
  const setMemoryLanguage = useSettingsStore((state) => state.setMemoryLanguage);
  const oauthSnapshot = useOauthCredentialStore((state) => state.snapshot);
  const modelCandidates = React.useMemo(
    () => usableProvidersForOauthSnapshot(providers, oauthSnapshot),
    [providers, oauthSnapshot]
  );
  const distillProvider = distillModel
    ? modelCandidates.find((entry) => entry.id === distillModel.providerId)
    : undefined;
  const distillModelEntry = distillProvider?.models.find(
    (entry) => entry.id === distillModel?.modelId
  );

  const memoryEnabled = !disabledBuiltinTools.includes('memory');
  const [stats, setStats] = React.useState<MemoryStats | null>(null);
  const [jobs, setJobs] = React.useState<MemoryJobsSnapshot>(EMPTY_JOBS);
  const [models, setModels] = React.useState<EmbeddingModelDto[]>([]);
  const [progress, setProgress] = React.useState<EmbeddingDownloadProgressDto | null>(null);
  const [chatModels, setChatModels] = React.useState<ChatModelDto[]>([]);
  const [chatProgress, setChatProgress] = React.useState<EmbeddingDownloadProgressDto | null>(null);
  const [sessions, setSessions] = React.useState<DistillableSessionDto[]>([]);
  const [distilling, setDistilling] = React.useState<string | null>(null);
  const [sessionsOf, setSessionsOf] = React.useState<SessionGroup | null>(null);
  const [batch, setBatch] = React.useState<BatchProgress | null>(null);
  const [bulkPrompt, setBulkPrompt] = React.useState<BulkPrompt | null>(null);
  const [backfilling, setBackfilling] = React.useState(false);
  const [allJobs, setAllJobs] = React.useState(false);
  // 轮询回调里要读最新值，state 会被闭包定住
  const backfillingRef = React.useRef(false);
  backfillingRef.current = backfilling;
  // 点补齐后立刻拉一次，不等下一个轮询周期
  const loadRef = React.useRef<(() => void) | null>(null);

  const refreshSessions = React.useCallback(() => {
    void window.electronAPI.memory.distillableSessions().then(setSessions);
  }, []);

  React.useEffect(() => {
    if (memoryEnabled) refreshSessions();
  }, [memoryEnabled, refreshSessions]);

  const refreshModels = React.useCallback(() => {
    void window.electronAPI.memory.models().then(setModels);
  }, []);

  React.useEffect(() => {
    refreshModels();
    return window.electronAPI.memory.onModelProgress((next) => {
      setProgress(next.done ? null : next);
      if (next.done) refreshModels();
    });
  }, [refreshModels]);

  const refreshChatModels = React.useCallback(() => {
    void window.electronAPI.memory.chatModels().then(setChatModels);
  }, []);

  React.useEffect(() => {
    refreshChatModels();
    return window.electronAPI.memory.onChatModelProgress((next) => {
      setChatProgress(next.done ? null : next);
      if (next.done) refreshChatModels();
    });
  }, [refreshChatModels]);

  React.useEffect(() => {
    if (!memoryEnabled) {
      setStats(null);
      setJobs(EMPTY_JOBS);
      return;
    }
    let cancelled = false;
    const load = () => {
      void window.electronAPI.memory.stats().then((next) => {
        if (!cancelled) setStats(next);
      });
      void window.electronAPI.memory.jobs().then((next) => {
        if (cancelled) return;
        setJobs(next);
        // 重嵌收尾（或压根没建任务：模型未就绪 / 没有待补的行）就退出补齐态，
        // 否则按钮会一直显示「补齐中」
        if (backfillingRef.current && next.reembed?.status !== 'running') setBackfilling(false);
      });
    };
    loadRef.current = load;
    load();
    // 记忆库变化时统计要立刻跟上，不等下一个轮询周期
    const offChanged = window.electronAPI.memory.onChanged(load);
    const timer = window.setInterval(load, backfilling ? BACKFILL_POLL_MS : JOBS_POLL_MS);
    return () => {
      cancelled = true;
      loadRef.current = null;
      offChanged();
      window.clearInterval(timer);
    };
  }, [memoryEnabled, backfilling]);

  const groups = groupSessionsByProject(sessions);
  const pendingSessions = sessions.filter((session) => !session.distilled);

  // 串行跑：后台 LLM 本就是一条 FIFO 链，并发发起只会让进度不可读。
  // 耗时完全取决于模型，不预设常量，只用已完成的真实耗时推剩余
  /**
   * 批量入口：范围内有已提炼的就先问一声。
   * 默不作声地跳过已提炼的，会让「改完语言/换了模型想重跑」这个真实诉求无路可走。
   */
  const requestBulkDistill = (scope: DistillableSessionDto[], token: string, label: string) => {
    const pending = scope.filter((session) => !session.distilled);
    if (!needsBulkPrompt(scope)) {
      void runDistill(scope, token);
      return;
    }
    setBulkPrompt({ token, label, scope, pending });
  };

  const runDistill = async (targets: DistillableSessionDto[], token: string, force = false) => {
    const selected = chatModels.find((model) => model.id === chatModel) ?? null;
    if (localChatBlocksDistill(selected)) return;
    setDistilling(token);
    const startedAt = Date.now();
    setBatch({ done: 0, total: targets.length, startedAt });
    try {
      for (let i = 0; i < targets.length; i++) {
        await window.electronAPI.memory.distillSession(targets[i].sessionId, force);
        setBatch({ done: i + 1, total: targets.length, startedAt });
      }
    } finally {
      setDistilling(null);
      setBatch(null);
      refreshSessions();
      // 记忆库是另一个组件在拉数据，提炼写入后它不会自己知道
      onLibraryChanged?.();
    }
  };

  const selectedModel = models.find((model) => model.id === embeddingModel) ?? null;
  const selectedChatModel = chatModels.find((model) => model.id === chatModel) ?? null;
  const chatBlocked = localChatBlocksDistill(selectedChatModel);
  const chatModelItems = chatModels.map((model) => ({
    value: model.id,
    label: model.id === 'remote' ? t('Remote (API model)') : model.label,
  }));
  const modelItems = [
    ...models.map((model) => ({ value: model.id, label: embeddingModelLabel(model) })),
    { value: REMOTE_MODEL_ID, label: t('Remote (OpenAI-compatible)') },
  ];
  const providerItems = providers.map((provider) => ({
    value: provider.id,
    label: provider.name,
  }));
  const languageItems = [
    { value: 'en', label: t('English') },
    { value: 'zh', label: t('Simplified Chinese') },
    { value: 'auto', label: t('Follow conversation') },
  ];
  const showRemotePicker =
    embeddingModel.startsWith('remote:') || selectedModel?.runtime === 'openai-compatible';
  const jobRows = React.useMemo(() => toJobRows(jobs), [jobs]);

  return (
    <div className="space-y-6" data-settings-row="memory.root">
      <section className="space-y-2">
        <h2 className="text-base font-medium">{t('Memory')}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            'Durable knowledge the agent can search and write across sessions. Stored locally in a SQLite database.'
          )}
        </p>
        {/* 开关只在「内置工具」页：这一页本身就是 memory 工具启用后才出现的，
            在这里再放一个「关闭我自己」的开关，点下去整页消失，说明文字也永远看不到 */}
        <p className="text-muted-foreground text-xs">{t('Turn memory off in Built-in tools.')}</p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('Embedding model')}</h3>
        <p className="text-xs text-muted-foreground">
          {t(
            'Used for semantic search and near-duplicate detection. Without it search still works using full-text only.'
          )}
        </p>
        <div
          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
          data-settings-row="memory.embeddingModel"
        >
          <div className="min-w-0">
            <p className="text-sm">
              {selectedModel ? embeddingModelLabel(selectedModel) : embeddingModel}
            </p>
            <p className="text-xs text-muted-foreground">
              {selectedModel
                ? [
                    selectedModel.dim ? `${selectedModel.dim}d` : null,
                    selectedModel.downloadable ? formatBytes(selectedModel.approxBytes) : null,
                    selectedModel.runtime,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : t('Unknown model; the default is used instead.')}
            </p>
          </div>
          {/* items 必传：base-ui 靠它把 value 映射成 label，否则触发器显示原始 id */}
          <Select
            value={embeddingModel}
            items={modelItems}
            onValueChange={(value) => setEmbeddingModel(String(value))}
            disabled={!memoryEnabled}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {modelItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>

        {selectedModel?.downloadable && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
            data-settings-row="memory.download"
          >
            <div className="min-w-0">
              <p className="text-sm">
                {selectedModel.state === 'ready'
                  ? t('Model downloaded')
                  : selectedModel.state === 'downloading'
                    ? t('Downloading…')
                    : t('Model not downloaded')}
              </p>
              <p className="text-xs text-muted-foreground">
                {progress && progress.modelId === selectedModel.id
                  ? `${progress.file} · ${formatBytes(progress.received)}${
                      progress.total ? ` / ${formatBytes(progress.total)}` : ''
                    } (${progress.fileIndex + 1}/${progress.fileCount})`
                  : selectedModel.state === 'ready'
                    ? formatBytes(selectedModel.downloadedBytes)
                    : t('Semantic search stays off until the model is on disk.')}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {selectedModel.state === 'downloading' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void window.electronAPI.memory
                      .cancelModelDownload(selectedModel.id)
                      .then(refreshModels);
                  }}
                >
                  {t('Cancel')}
                </Button>
              ) : selectedModel.state === 'ready' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void window.electronAPI.memory
                      .deleteModel(selectedModel.id)
                      .then(refreshModels);
                  }}
                >
                  {t('Remove')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={!memoryEnabled}
                  onClick={() => {
                    void window.electronAPI.memory
                      .downloadModel(selectedModel.id)
                      .then(refreshModels);
                  }}
                >
                  {t('Download')}
                </Button>
              )}
            </div>
          </div>
        )}

        {showRemotePicker && (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
            data-settings-row="memory.remoteProvider"
          >
            <div className="min-w-0">
              <p className="text-sm">{t('Embedding provider')}</p>
              <p className="text-xs text-muted-foreground">
                {t('Credentials stay in the main process and are never sent to the renderer.')}
              </p>
            </div>
            <Select
              value={remoteProviderId ?? ''}
              items={providerItems}
              onValueChange={(value) => setRemoteProviderId(value ? String(value) : null)}
              disabled={!memoryEnabled}
            >
              <SelectTrigger className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {providerItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        )}

        <SwitchRow
          rowId="memory.autoDownload"
          title={t('Download models automatically')}
          description={t(
            'Off by default, so a model is only fetched when you press Download. While a model is missing, search degrades to full-text; existing memories are re-embedded once it arrives.'
          )}
          checked={autoDownload}
          onChange={setAutoDownload}
          disabled={!memoryEnabled}
        />
      </section>

      <section className="space-y-2" data-settings-row="memory.distillModel">
        <h3 className="text-sm font-medium">{t('Distillation')}</h3>
        <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-sm">{t('Completion backend')}</p>
            <p className="text-xs text-muted-foreground">
              {t('Local GGUF runs on this machine. Remote uses the model below.')}
            </p>
          </div>
          <Select
            value={chatModel}
            items={chatModelItems}
            onValueChange={(value) => setChatModel(String(value))}
            disabled={!memoryEnabled}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {chatModelItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {selectedChatModel?.downloadable && (
          <div
            className={cn(
              'flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5',
              chatBlocked === 'missing' && 'border-destructive/50'
            )}
          >
            <div className="min-w-0">
              <p className="text-sm">
                {selectedChatModel.state === 'ready'
                  ? t('Model downloaded')
                  : selectedChatModel.state === 'downloading'
                    ? t('Downloading…')
                    : t('Model not downloaded')}
              </p>
              <p className="text-xs text-muted-foreground">
                {chatProgress && chatProgress.modelId === selectedChatModel.id
                  ? `${chatProgress.file} · ${formatBytes(chatProgress.received)}${
                      chatProgress.total ? ` / ${formatBytes(chatProgress.total)}` : ''
                    }`
                  : selectedChatModel.state === 'ready'
                    ? formatBytes(selectedChatModel.downloadedBytes)
                    : formatBytes(selectedChatModel.approxBytes)}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {selectedChatModel.state === 'downloading' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void window.electronAPI.memory
                      .cancelChatModelDownload(selectedChatModel.id)
                      .then(refreshChatModels);
                  }}
                >
                  {t('Cancel')}
                </Button>
              ) : selectedChatModel.state === 'ready' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void window.electronAPI.memory
                      .deleteChatModel(selectedChatModel.id)
                      .then(refreshChatModels);
                  }}
                >
                  {t('Remove')}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={!memoryEnabled}
                  onClick={() => {
                    void window.electronAPI.memory
                      .downloadChatModel(selectedChatModel.id)
                      .then(refreshChatModels);
                  }}
                >
                  {t('Download')}
                </Button>
              )}
            </div>
          </div>
        )}
        {chatBlocked === 'missing' && (
          <p className="text-xs text-destructive">
            {t(
              'Local model selected but the weights are not on disk. Distillation and interpretation will wait until you click Download.'
            )}
          </p>
        )}
        {chatBlocked === 'downloading' && (
          <p className="text-xs text-muted-foreground">
            {t('Download in progress. Distillation waits until the model is ready.')}
          </p>
        )}
        {chatModel === 'remote' && (
          <>
            <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm">{t('Distillation model')}</p>
                <p className="text-xs text-muted-foreground">
                  {t('Reads finished sessions and writes the memories.')}
                </p>
              </div>
              {modelCandidates.length > 0 && (
                <div className="w-56 shrink-0">
                  <ModelPicker
                    providers={modelCandidates}
                    providerId={distillProvider?.id ?? ''}
                    modelId={distillModelEntry?.id ?? ''}
                    reasoningEnabled={false}
                    thinkingLevel="medium"
                    showReasoningControls={false}
                    emptyLabel={t('Follows the title-summary model')}
                    side="bottom"
                    triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                    onSelect={(providerId, modelId) => setDistillModel({ providerId, modelId })}
                    onReasoningChange={() => {}}
                    onThinkingChange={() => {}}
                  />
                </div>
              )}
            </div>
            {distillModel && (
              <Button variant="ghost" size="sm" onClick={() => setDistillModel(null)}>
                {t('Follows the title-summary model')}
              </Button>
            )}
          </>
        )}
        <div
          className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2.5"
          data-settings-row="memory.language"
        >
          <div className="min-w-0">
            <p className="text-sm">{t('Memory language')}</p>
            <p className="text-xs text-muted-foreground">
              {t(
                'English keeps retrieval and near-duplicate detection stable across languages. Choose Follow conversation if your team only works in one language.'
              )}
            </p>
          </div>
          <Select
            value={memoryLanguage}
            items={languageItems}
            onValueChange={(value) => setMemoryLanguage(String(value))}
            disabled={!memoryEnabled}
          >
            <SelectTrigger className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {languageItems.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-medium">{t('Background processing')}</h3>
        <SwitchRow
          rowId="memory.distill"
          title={t('Distill sessions automatically')}
          description={t(
            'When a session ends, or goes idle for 30 minutes and is reclaimed, extract 1-3 durable memories from it in the background.'
          )}
          checked={distillEnabled}
          onChange={setDistillEnabled}
          disabled={!memoryEnabled}
        />
        {distillEnabled && chatBlocked && (
          <p className="text-xs text-destructive">
            {t(
              'Automatic distillation is on, but the local model is not ready. Sessions will queue until you download it.'
            )}
          </p>
        )}
        <SwitchRow
          rowId="memory.kg"
          title={t('Extract entities')}
          description={t(
            'Build an entity graph so a memory can be recalled by a name it does not literally contain.'
          )}
          checked={kgEnabled}
          onChange={setKgEnabled}
          disabled={!memoryEnabled}
        />
      </section>

      <section className="space-y-2" data-settings-row="memory.stats">
        <h3 className="text-sm font-medium">{t('Library')}</h3>
        {stats === null || stats.total === 0 ? (
          <p className="text-xs text-muted-foreground">{t('No memories stored yet.')}</p>
        ) : (
          <>
            {embeddingErrorNotice(stats) && (
              <p className="text-xs text-destructive">
                {t('Vectors unavailable: {{reason}}', {
                  reason: embeddingErrorNotice(stats) ?? '',
                })}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label={t('Memories')} value={String(stats.total)} />
              <Stat label={t('Crystals')} value={String(stats.crystals)} />
              <Stat label={t('Entities')} value={String(stats.entities)} />
              <Stat
                label={t('With vectors')}
                value={`${stats.embedded}/${stats.total}`}
                action={
                  stats.embedded < stats.total ? (
                    <button
                      type="button"
                      disabled={backfilling}
                      className="text-xs text-muted-foreground underline-offset-2 hover:underline disabled:opacity-60"
                      onClick={() => {
                        setBackfilling(true);
                        void window.electronAPI.memory.reembed().then(() => loadRef.current?.());
                      }}
                    >
                      {backfilling ? t('Backfilling…') : t('Backfill')}
                    </button>
                  ) : null
                }
              />
              <Stat label={t('Database size')} value={formatBytes(stats.databaseBytes)} />
              <Stat label={t('Spaces')} value={String(Object.keys(stats.bySpace).length)} />
            </div>
          </>
        )}
      </section>

      <section className="space-y-2" data-settings-row="memory.distillSessions">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium">{t('Distill past sessions')}</h3>
          {pendingSessions.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={!memoryEnabled || distilling !== null || chatBlocked !== null}
              onClick={() => requestBulkDistill(sessions, 'all', t('All sessions'))}
            >
              {distilling === 'all'
                ? t('Distilling…')
                : t('Distill all ({{count}})', { count: String(pendingSessions.length) })}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {t(
            'The automatic switch only covers sessions that end from now on. Distill earlier sessions here to fill the library.'
          )}
        </p>
        {batch && (
          <p className="text-xs text-muted-foreground">
            {t('{{done}}/{{total}} done', {
              done: String(batch.done),
              total: String(batch.total),
            })}
            {(() => {
              const remaining = estimateRemainingMs(batch, Date.now());
              return remaining === null
                ? ''
                : ` · ${t('about {{time}} left', { time: formatDuration(remaining) })}`;
            })()}
          </p>
        )}
        {groups.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('No recorded sessions found.')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {groups.map((group) => {
              const groupPending = group.sessions.filter((s) => !s.distilled);
              return (
                <li key={group.key} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{group.name}</p>
                    <p className="text-muted-foreground text-xs">
                      {t('{{total}} sessions · {{pending}} not distilled', {
                        total: String(group.sessions.length),
                        pending: String(groupPending.length),
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" variant="ghost" onClick={() => setSessionsOf(group)}>
                      {t('View sessions')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        !memoryEnabled ||
                        distilling !== null ||
                        group.sessions.length === 0 ||
                        chatBlocked !== null
                      }
                      onClick={() => requestBulkDistill(group.sessions, group.key, group.name)}
                    >
                      {distilling === group.key ? t('Distilling…') : t('Distill project')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <Dialog open={sessionsOf !== null} onOpenChange={(open) => !open && setSessionsOf(null)}>
        <DialogContent>
          {sessionsOf && (
            <>
              <DialogHeader>
                <DialogTitle>{sessionsOf.name}</DialogTitle>
                <DialogDescription>
                  {t('{{total}} sessions · {{pending}} not distilled', {
                    total: String(sessionsOf.sessions.length),
                    pending: String(sessionsOf.sessions.filter((s) => !s.distilled).length),
                  })}
                </DialogDescription>
              </DialogHeader>
              <DialogPanel>
                <ul className="divide-y rounded-lg border">
                  {sessionsOf.sessions.map((session) => (
                    <li
                      key={session.sessionId}
                      className="flex items-center justify-between gap-3 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{session.title}</p>
                        <p className="text-muted-foreground text-xs">
                          {session.updatedAt ? session.updatedAt.slice(0, 10) : ''}
                          {session.distilled ? ` · ${t('Already distilled')}` : ''}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="shrink-0"
                        disabled={!memoryEnabled || distilling !== null || chatBlocked !== null}
                        onClick={() =>
                          void runDistill([session], session.sessionId, session.distilled)
                        }
                      >
                        {distilling === session.sessionId
                          ? t('Distilling…')
                          : session.distilled
                            ? t('Distill again')
                            : t('Distill')}
                      </Button>
                    </li>
                  ))}
                </ul>
              </DialogPanel>
              <DialogFooter>
                <DialogClose render={<Button variant="outline" size="sm" />}>
                  {t('Close')}
                </DialogClose>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={bulkPrompt !== null} onOpenChange={(open) => !open && setBulkPrompt(null)}>
        <DialogContent>
          {bulkPrompt && (
            <>
              {/* 说明文字必须放进 DialogHeader：DialogDescription 自身不带 padding，
                  裸放在 DialogContent 下会顶到弹窗边缘、与标题不对齐 */}
              <DialogHeader>
                <DialogTitle>{t('Some sessions were already distilled')}</DialogTitle>
                <DialogDescription>
                  {t(
                    '{{label}}: {{total}} sessions, {{done}} already distilled. Re-distilling runs the model again and may add new memories alongside the existing ones.',
                    {
                      label: bulkPrompt.label,
                      total: String(bulkPrompt.scope.length),
                      done: String(bulkPrompt.scope.length - bulkPrompt.pending.length),
                    }
                  )}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose render={<Button variant="ghost" size="sm" />}>
                  {t('Cancel')}
                </DialogClose>
                {/* 主次按代价定：重跑全部会把已提炼的会话再过一遍模型（多数是白跑），
                    不该做成最醒目的默认按钮。只在没有剩余可提炼时它才是唯一有意义的操作。 */}
                <Button
                  variant={bulkPrompt.pending.length > 0 ? 'default' : 'outline'}
                  size="sm"
                  disabled={bulkPrompt.pending.length === 0}
                  onClick={() => {
                    const target = bulkPrompt;
                    setBulkPrompt(null);
                    void runDistill(target.pending, target.token);
                  }}
                >
                  {t('Only the {{count}} remaining', {
                    count: String(bulkPrompt.pending.length),
                  })}
                </Button>
                <Button
                  variant={bulkPrompt.pending.length > 0 ? 'outline' : 'default'}
                  size="sm"
                  onClick={() => {
                    const target = bulkPrompt;
                    setBulkPrompt(null);
                    void runDistill(target.scope, target.token, true);
                  }}
                >
                  {t('Re-distill all {{count}}', { count: String(bulkPrompt.scope.length) })}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <section className="space-y-2" data-settings-row="memory.jobs">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-sm">{t('Background tasks')}</h3>
          <div className="flex shrink-0 items-center gap-1">
            {jobRows.some((row) => row.state !== 'running') && (
              <Button
                size="sm"
                variant="ghost"
                title={t(
                  'Removes completed and cancelled jobs. Running tasks are kept. Sessions will show as not distilled again, since that flag is derived from job history — re-distilling is deduplicated, so it will not create duplicate memories.'
                )}
                onClick={() => {
                  void window.electronAPI.memory.clearJobs();
                }}
              >
                {t('Clear finished tasks')}
              </Button>
            )}
            {jobRows.length > VISIBLE_JOBS && (
              <Button size="sm" variant="ghost" onClick={() => setAllJobs(!allJobs)}>
                {allJobs
                  ? t('Show less')
                  : t('Show all {{count}}', { count: String(jobRows.length) })}
              </Button>
            )}
          </div>
        </div>
        {jobRows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('Nothing running.')}</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {(allJobs ? jobRows : jobRows.slice(0, VISIBLE_JOBS)).map((row) => (
              <li key={row.key} className="space-y-1 px-3 py-2">
                <div className="flex items-center gap-2">
                  <Badge variant={row.state === 'failed' ? 'destructive' : 'secondary'}>
                    {t(JOB_KIND_LABELS[row.kind])}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">{row.target}</span>
                  <span
                    className={cn(
                      'shrink-0 text-xs',
                      row.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {row.state === 'running' ? `⋯ ${row.detail}` : row.detail}
                  </span>
                </div>
                {row.notes.map((note) => (
                  <p key={note} className="pl-1 text-muted-foreground text-xs">
                    · {note}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border px-3 py-2">
      <p className="text-muted-foreground text-xs">{label}</p>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm">{value}</p>
        {action}
      </div>
    </div>
  );
}
