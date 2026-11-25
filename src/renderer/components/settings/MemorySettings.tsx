import {
  FORGETTING_INTERVAL_DAYS_OPTIONS,
  FORGETTING_MAX_IMPORTANCE_OPTIONS,
  FORGETTING_STALE_DAYS_OPTIONS,
} from '@shared/memory/constants';
import { MEMORY_DISTILL_WINDOW_MINUTES } from '@shared/memory/distillWindow';
import type {
  ChatModelDto,
  DistillableSessionDto,
  EmbeddingDownloadProgressDto,
  EmbeddingModelDto,
  MemoryArchiveCandidatesResult,
  MemoryJobsSnapshot,
  MemoryReconcileRunDto,
  MemoryStats,
} from '@shared/memory/dto';
import { MEMORY_MODEL_IDLE_MINUTES } from '@shared/memory/modelIdle';
import {
  explainRemoteEmbeddingRejections,
  NO_REMOTE_EMBEDDING_CANDIDATES,
  remoteEmbeddingCandidates,
  remoteEmbeddingIssue,
  remoteEmbeddingIssueMessage,
  remoteEmbeddingRejectionMessage,
} from '@shared/memory/remoteEmbedding';
import * as React from 'react';
import { MODEL_PICKER_FORM_TRIGGER_CLASS, ModelPicker } from '@/components/chat/ModelPicker';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { useI18n } from '@/i18n';
import { cn } from '@/lib/utils';
import { useUsableProviders } from '@/stores/modelDirectory/useProviders';
import { useSettingsStore } from '@/stores/settings';
import {
  SettingsButton,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSubRow,
  SettingsSwitch,
} from './kit';
import { formatDateTime } from './MemoryLibrary';
import { type JobKind, toJobRows } from './memoryJobRows';
import {
  embeddingBackendSelectValue,
  embeddingModelLabel,
  isRemoteEmbeddingId,
  nextEmbeddingBackend,
  REMOTE_EMBEDDING_BACKEND_ID,
  remoteEmbeddingModelId,
  toRemoteEmbeddingId,
} from './memoryModelItems';

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

const EMPTY_JOBS: MemoryJobsSnapshot = { distill: [], kg: [], reembed: null, kgFailed: 0 };

// 模型清单来自 Main 的注册表（registry.ts），不在渲染层重写一份：
// 手写副本一旦 id 对不上，选中后会静默回落默认模型，用户完全看不出来
/**
 * 批量提炼前的分支：范围内全部未提炼 → 直接跑；有已提炼的 → 先问。
 * 抽成纯函数以便直接断言（SSR 渲染下拿不到弹窗交互）。
 */
export function needsBulkPrompt(scope: readonly { distilled: boolean }[]): boolean {
  return scope.some((session) => session.distilled);
}

/**
 * 正在提炼的会话以 Main 的任务快照为准：本地 state 随组件卸载丢失，快照不会。
 * 只认 running：暂时失败的任务以 pending 停到下次重试，算进来按钮会一直卡在「提炼中」。
 */
export function runningDistillSessions(jobs: MemoryJobsSnapshot): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const job of jobs.distill) {
    if (job.status !== 'running') continue;
    ids.add(job.sessionId);
    for (const id of job.sessionIds ?? []) ids.add(id);
  }
  return ids;
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

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

/** 下拉档位；保存值不在档位表里（手改过 settings.json）时补进去，避免 Select 显示空 */
function numberItems(
  options: readonly number[],
  current: number,
  format: (value: number) => string
): { value: string; label: string }[] {
  const values = options.includes(current)
    ? [...options]
    : [...options, current].sort((a, b) => a - b);
  return values.map((value) => ({ value: String(value), label: format(value) }));
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
    <SettingsRow rowId={rowId} label={title} description={description}>
      <SettingsSwitch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </SettingsRow>
  );
}

function SelectRow({
  title,
  description,
  value,
  items,
  onChange,
  rowId,
  disabled,
}: {
  title: string;
  description: string;
  value: string;
  items: { value: string; label: string }[];
  onChange: (value: string) => void;
  rowId?: string;
  disabled?: boolean;
}) {
  return (
    <SettingsRow rowId={rowId} label={title} description={description}>
      <SettingsSelect value={value} options={items} onValueChange={onChange} disabled={disabled} />
    </SettingsRow>
  );
}

/** 分组里夹在行之间的一行说明（状态、报错），沿用行的分隔线 */
function Note({
  tone,
  rowId,
  children,
}: {
  tone?: 'danger';
  rowId?: string;
  children: React.ReactNode;
}) {
  return (
    <p
      data-settings-row={rowId}
      className={cn(
        'px-4 py-2.5 text-[12px] leading-[18px] max-sm:px-3',
        tone === 'danger' ? 'text-destructive-text' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  );
}

/** children：同页下方的知识与记忆库分区，放进同一个 SettingsPage */
export function MemorySettings({
  onLibraryChanged,
  children,
}: {
  onLibraryChanged?: () => void;
  children?: React.ReactNode;
} = {}) {
  const { t } = useI18n();
  const disabledBuiltinTools = useSettingsStore((state) => state.disabledBuiltinTools);
  const embeddingModel = useSettingsStore((state) => state.memoryEmbeddingModel);
  const setEmbeddingModel = useSettingsStore((state) => state.setMemoryEmbeddingModel);
  const autoDownload = useSettingsStore((state) => state.memoryEmbeddingAutoDownload);
  const setAutoDownload = useSettingsStore((state) => state.setMemoryEmbeddingAutoDownload);
  const modelIdleMinutes = useSettingsStore((state) => state.memoryModelIdleMinutes);
  const setModelIdleMinutes = useSettingsStore((state) => state.setMemoryModelIdleMinutes);
  const remoteProviderId = useSettingsStore((state) => state.memoryEmbeddingRemoteProviderId);
  const setRemoteProviderId = useSettingsStore((state) => state.setMemoryEmbeddingRemoteProviderId);
  const settingsProviders = useSettingsStore((state) => state.providers);
  const distillEnabled = useSettingsStore((state) => state.memoryDistillEnabled);
  const setDistillEnabled = useSettingsStore((state) => state.setMemoryDistillEnabled);
  const distillWindowMinutes = useSettingsStore((state) => state.memoryDistillWindowMinutes);
  const setDistillWindowMinutes = useSettingsStore((state) => state.setMemoryDistillWindowMinutes);
  const kgEnabled = useSettingsStore((state) => state.memoryKgEnabled);
  const setKgEnabled = useSettingsStore((state) => state.setMemoryKgEnabled);
  const reconcileEnabled = useSettingsStore((state) => state.memoryReconcileEnabled);
  const setReconcileEnabled = useSettingsStore((state) => state.setMemoryReconcileEnabled);
  const decayEnabled = useSettingsStore((state) => state.memoryDecayEnabled);
  const setDecayEnabled = useSettingsStore((state) => state.setMemoryDecayEnabled);
  const decayCandidates = useSettingsStore((state) => state.memoryDecayArchiveCandidates);
  const setDecayCandidates = useSettingsStore((state) => state.setMemoryDecayArchiveCandidates);
  const decayAutoArchive = useSettingsStore((state) => state.memoryDecayAutoArchive);
  const setDecayAutoArchive = useSettingsStore((state) => state.setMemoryDecayAutoArchive);
  const decayStaleDays = useSettingsStore((state) => state.memoryDecayStaleDays);
  const setDecayStaleDays = useSettingsStore((state) => state.setMemoryDecayStaleDays);
  const decayMaxImportance = useSettingsStore((state) => state.memoryDecayMaxImportance);
  const setDecayMaxImportance = useSettingsStore((state) => state.setMemoryDecayMaxImportance);
  const decayIntervalDays = useSettingsStore((state) => state.memoryDecayIntervalDays);
  const setDecayIntervalDays = useSettingsStore((state) => state.setMemoryDecayIntervalDays);
  const distillModel = useSettingsStore((state) => state.memoryDistillModel);
  const setDistillModel = useSettingsStore((state) => state.setMemoryDistillModel);
  const chatModel = useSettingsStore((state) => state.memoryChatModel) || 'remote';
  const setChatModel = useSettingsStore((state) => state.setMemoryChatModel);
  const memoryLanguage = useSettingsStore((state) => state.memoryLanguage);
  const setMemoryLanguage = useSettingsStore((state) => state.setMemoryLanguage);
  const modelCandidates = useUsableProviders();
  const distillProvider = distillModel
    ? modelCandidates.find((entry) => entry.id === distillModel.providerId)
    : undefined;
  const distillModelEntry = distillProvider?.models.find(
    (entry) => entry.id === distillModel?.modelId
  );
  const remoteEmbeddingModel = remoteEmbeddingModelId(embeddingModel);
  const embeddingCandidates = React.useMemo(
    () => remoteEmbeddingCandidates(modelCandidates),
    [modelCandidates]
  );
  const embeddingRejections = React.useMemo(
    () => explainRemoteEmbeddingRejections(modelCandidates),
    [modelCandidates]
  );
  const embeddingProvider = remoteProviderId
    ? embeddingCandidates.find((entry) => entry.id === remoteProviderId)
    : undefined;
  const embeddingRemoteEntry = embeddingProvider?.models.find(
    (entry) => entry.id === remoteEmbeddingModel
  );
  // 与 Main 校验同口径：已保存的选择若注定失败，就地说明原因；未选时由 picker 的空态引导
  const savedRemoteProvider = remoteProviderId
    ? settingsProviders.find((entry) => entry.id === remoteProviderId)
    : undefined;
  const savedRemoteIssue = remoteEmbeddingIssue({
    providerId: remoteProviderId,
    provider: savedRemoteProvider,
    modelId: remoteEmbeddingModel,
  });
  const remoteIssueText =
    savedRemoteIssue && savedRemoteIssue !== 'no-provider' && savedRemoteIssue !== 'no-model'
      ? remoteEmbeddingIssueMessage(
          savedRemoteIssue,
          {
            provider: savedRemoteProvider?.name || remoteProviderId || '',
            model: remoteEmbeddingModel ?? '',
          },
          t
        )
      : null;

  const memoryEnabled = !disabledBuiltinTools.includes('memory');
  const [stats, setStats] = React.useState<MemoryStats | null>(null);
  const [jobs, setJobs] = React.useState<MemoryJobsSnapshot>(EMPTY_JOBS);
  const [jobsLoaded, setJobsLoaded] = React.useState(false);
  const [models, setModels] = React.useState<EmbeddingModelDto[]>([]);
  const [progress, setProgress] = React.useState<EmbeddingDownloadProgressDto | null>(null);
  const [chatModels, setChatModels] = React.useState<ChatModelDto[]>([]);
  const [chatProgress, setChatProgress] = React.useState<EmbeddingDownloadProgressDto | null>(null);
  const [sessions, setSessions] = React.useState<DistillableSessionDto[]>([]);
  // 本页发起的批次标记（哪个按钮 + 快照跟上前的空窗），卸载即丢；是否在提炼以任务快照为准
  const [distilling, setDistilling] = React.useState<string | null>(null);
  const [sessionsOf, setSessionsOf] = React.useState<SessionGroup | null>(null);
  const [batch, setBatch] = React.useState<BatchProgress | null>(null);
  const [bulkPrompt, setBulkPrompt] = React.useState<BulkPrompt | null>(null);
  const [backfilling, setBackfilling] = React.useState(false);
  const [allJobs, setAllJobs] = React.useState(false);
  const [candidates, setCandidates] = React.useState<MemoryArchiveCandidatesResult | null>(null);
  const [candidateSelection, setCandidateSelection] = React.useState<ReadonlySet<string>>(
    new Set()
  );
  const [forgettingBusy, setForgettingBusy] = React.useState<'run' | 'archive' | null>(null);
  const [reconcileBusy, setReconcileBusy] = React.useState(false);
  // undefined = 本次打开还没手动跑过；null = 跑了但没有可用模型
  const [reconcileRun, setReconcileRun] = React.useState<MemoryReconcileRunDto | null | undefined>(
    undefined
  );
  const forgetting = stats?.forgetting ?? null;
  const lastRun = forgetting?.lastRun ?? null;
  const lastRunText = lastRun
    ? t('Last run {{date}}: {{scored}} scored, {{candidates}} candidates, {{archived}} archived', {
        date: formatDateTime(lastRun.ranAt),
        scored: String(lastRun.scored),
        candidates: String(lastRun.candidates),
        archived: String(lastRun.archived),
      })
    : t('Never run yet');
  // 轮询回调里要读最新值，state 会被闭包定住
  const backfillingRef = React.useRef(false);
  backfillingRef.current = backfilling;
  const distillingRef = React.useRef(false);
  const runningSessionsRef = React.useRef<ReadonlySet<string>>(new Set());
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
      setJobsLoaded(false);
      return;
    }
    let cancelled = false;
    const load = () => {
      void window.electronAPI.memory.stats().then((next) => {
        if (!cancelled) setStats(next);
      });
      void window.electronAPI.memory
        .jobs()
        .then((next) => {
          if (cancelled) return;
          setJobs(next);
          setJobsLoaded(true);
          // 重嵌收尾（或压根没建任务：模型未就绪 / 没有待补的行）就退出补齐态，
          // 否则按钮会一直显示「补齐中」
          if (backfillingRef.current && next.reembed?.status !== 'running') setBackfilling(false);
        })
        .catch(() => {
          if (!cancelled) setJobsLoaded(true);
        });
    };
    loadRef.current = load;
    load();
    // 记忆库变化时统计要立刻跟上，不等下一个轮询周期
    const offChanged = window.electronAPI.memory.onChanged(() => {
      load();
      refreshSessions();
    });
    const timer = window.setInterval(load, backfilling ? BACKFILL_POLL_MS : JOBS_POLL_MS);
    return () => {
      cancelled = true;
      loadRef.current = null;
      offChanged();
      window.clearInterval(timer);
    };
  }, [memoryEnabled, backfilling, refreshSessions]);

  const groups = groupSessionsByProject(sessions);
  const pendingSessions = sessions.filter((session) => !session.distilled);

  // 遗忘：跑一轮巡检 / 看候选 / 批量确认归档。归档只改 lifecycle_state，随时能在库里还原。
  const runForgetting = () => {
    setForgettingBusy('run');
    void window.electronAPI.memory.runForgetting().then(() => {
      setForgettingBusy(null);
      loadRef.current?.();
    });
  };

  const runReconcile = () => {
    setReconcileBusy(true);
    void window.electronAPI.memory.runReconcile().then((result) => {
      setReconcileBusy(false);
      setReconcileRun(result);
      loadRef.current?.();
    });
  };

  const openCandidates = () => {
    void window.electronAPI.memory.archiveCandidates({ limit: 200, offset: 0 }).then((result) => {
      setCandidates(result);
      // 默认不勾选：一次误点不该把整批归档掉，全选留给用户显式点
      setCandidateSelection(new Set());
    });
  };

  const archiveSelected = () => {
    const ids = [...candidateSelection];
    if (ids.length === 0) return;
    setForgettingBusy('archive');
    void window.electronAPI.memory.confirmArchiveCandidates(ids).then(() => {
      setForgettingBusy(null);
      openCandidates();
      loadRef.current?.();
      onLibraryChanged?.();
    });
  };

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
    if (distillingRef.current || runningSessionsRef.current.size > 0) return;
    const selected = chatModels.find((model) => model.id === chatModel) ?? null;
    if (localChatBlocksDistill(selected)) return;
    distillingRef.current = true;
    setDistilling(token);
    const startedAt = Date.now();
    setBatch({ done: 0, total: targets.length, startedAt });
    try {
      for (let i = 0; i < targets.length; i++) {
        await window.electronAPI.memory.distillSession(targets[i].sessionId, force);
        setBatch({ done: i + 1, total: targets.length, startedAt });
      }
    } catch {
      // 失败原因由任务快照 / 主进程日志呈现，避免未处理 rejection 卡住交互
    } finally {
      distillingRef.current = false;
      setDistilling(null);
      setBatch(null);
      loadRef.current?.();
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
    { value: REMOTE_EMBEDDING_BACKEND_ID, label: t('Remote (OpenAI-compatible)') },
  ];
  const modelIdleItems = MEMORY_MODEL_IDLE_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: minutes === 0 ? t('Never') : t('{{count}} min', { count: minutes }),
  }));
  const distillWindowItems = MEMORY_DISTILL_WINDOW_MINUTES.map((minutes) => ({
    value: String(minutes),
    label: minutes === 0 ? t('Immediately') : t('{{count}} min', { count: minutes }),
  }));
  const languageItems = [
    { value: 'en', label: t('English') },
    { value: 'zh', label: t('Simplified Chinese') },
    { value: 'auto', label: t('Follow conversation') },
  ];
  const showRemotePicker =
    isRemoteEmbeddingId(embeddingModel) || selectedModel?.runtime === 'openai-compatible';
  const jobRows = React.useMemo(() => toJobRows(jobs, t), [jobs, t]);
  const runningSessions = React.useMemo(() => runningDistillSessions(jobs), [jobs]);
  runningSessionsRef.current = runningSessions;
  const distillBusy = distilling !== null || runningSessions.size > 0;

  const downloadButtons = (
    model: { id: string; state: string },
    actions: { cancel: () => void; remove: () => void; download: () => void }
  ) =>
    model.state === 'downloading' ? (
      <SettingsButton onClick={actions.cancel}>{t('Cancel')}</SettingsButton>
    ) : model.state === 'ready' ? (
      <SettingsButton onClick={actions.remove}>{t('Remove')}</SettingsButton>
    ) : (
      <SettingsButton variant="default" disabled={!memoryEnabled} onClick={actions.download}>
        {t('Download')}
      </SettingsButton>
    );
  const modelStateLabel = (state: string) =>
    state === 'ready'
      ? t('Model downloaded')
      : state === 'downloading'
        ? t('Downloading…')
        : t('Model not downloaded');

  return (
    <SettingsPage
      rowId="memory.root"
      title={t('Memory')}
      description={t(
        'Durable knowledge the agent can search and write across sessions. Stored locally in a SQLite database.'
      )}
    >
      {/* 开关只在「内置工具」页：这一页本身就是 memory 工具启用后才出现的，
          在这里再放一个「关闭我自己」的开关，点下去整页消失，说明文字也永远看不到 */}
      <p className="mt-1 text-[12px] text-muted-foreground">
        {t('Turn memory off in Built-in tools.')}
      </p>

      <SettingsSection>
        <SettingsRow
          rowId="memory.modelIdleMinutes"
          label={t('Unload automatically when idle')}
          description={t(
            'Release local model memory after this idle period. Models load automatically the next time they are needed.'
          )}
        >
          <SettingsSelect
            value={String(modelIdleMinutes)}
            options={modelIdleItems}
            onValueChange={(value) => setModelIdleMinutes(Number(value))}
            disabled={!memoryEnabled}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        rowId="memory.embedding-model"
        title={t('Embedding model')}
        description={t(
          'Used for semantic search and near-duplicate detection. Without it search still works using full-text only.'
        )}
      >
        <SettingsRow
          rowId="memory.embeddingModel"
          label={
            selectedModel
              ? embeddingModelLabel(selectedModel)
              : (remoteEmbeddingModel ??
                (showRemotePicker ? t('Remote (OpenAI-compatible)') : embeddingModel))
          }
          description={
            selectedModel
              ? [
                  selectedModel.dim ? `${selectedModel.dim}d` : null,
                  selectedModel.downloadable ? formatBytes(selectedModel.approxBytes) : null,
                  selectedModel.runtime,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : showRemotePicker
                ? 'openai-compatible'
                : t('Unknown model; the default is used instead.')
          }
        >
          <SettingsSelect
            value={embeddingBackendSelectValue(embeddingModel)}
            options={modelItems}
            onValueChange={(value) =>
              setEmbeddingModel(nextEmbeddingBackend(embeddingModel, value))
            }
            disabled={!memoryEnabled}
          />
        </SettingsRow>

        {selectedModel?.downloadable && (
          <SettingsSubRow
            rowId="memory.download"
            label={modelStateLabel(selectedModel.state)}
            description={
              progress && progress.modelId === selectedModel.id
                ? `${progress.file} · ${formatBytes(progress.received)}${
                    progress.total ? ` / ${formatBytes(progress.total)}` : ''
                  } (${progress.fileIndex + 1}/${progress.fileCount})`
                : selectedModel.state === 'ready'
                  ? formatBytes(selectedModel.downloadedBytes)
                  : t('Semantic search stays off until the model is on disk.')
            }
          >
            {downloadButtons(selectedModel, {
              cancel: () =>
                void window.electronAPI.memory
                  .cancelModelDownload(selectedModel.id)
                  .then(refreshModels),
              remove: () =>
                void window.electronAPI.memory.deleteModel(selectedModel.id).then(refreshModels),
              download: () =>
                void window.electronAPI.memory.downloadModel(selectedModel.id).then(refreshModels),
            })}
          </SettingsSubRow>
        )}

        {showRemotePicker && (
          <SettingsSubRow
            rowId="memory.remoteModel"
            label={t('Remote model')}
            description={t(
              'Credentials stay in the main process and are never sent to the renderer.'
            )}
          >
            {embeddingCandidates.length > 0 ? (
              <div className="w-[220px] max-w-full">
                <ModelPicker
                  providers={embeddingCandidates}
                  providerId={embeddingProvider?.id ?? remoteProviderId ?? ''}
                  modelId={embeddingRemoteEntry?.id ?? remoteEmbeddingModel ?? ''}
                  reasoningEnabled={false}
                  thinkingLevel="medium"
                  showReasoningControls={false}
                  emptyLabel={t('Select model')}
                  side="bottom"
                  triggerClassName={MODEL_PICKER_FORM_TRIGGER_CLASS}
                  onSelect={(providerId, modelId) => {
                    setRemoteProviderId(providerId);
                    setEmbeddingModel(toRemoteEmbeddingId(modelId));
                  }}
                  onReasoningChange={() => {}}
                  onThinkingChange={() => {}}
                />
              </div>
            ) : (
              <div className="w-[220px] max-w-full space-y-1">
                <p className="text-[12px] text-destructive-text">
                  {t(NO_REMOTE_EMBEDDING_CANDIDATES)}
                </p>
                {embeddingRejections.map((item) => (
                  <p key={item.providerId} className="text-[12px] text-muted-foreground">
                    {remoteEmbeddingRejectionMessage(item.reason, item.name, t)}
                  </p>
                ))}
              </div>
            )}
          </SettingsSubRow>
        )}
        {showRemotePicker && remoteIssueText && (
          <Note tone="danger" rowId="memory.remoteModelIssue">
            {remoteIssueText}
          </Note>
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
      </SettingsSection>

      <SettingsSection rowId="memory.distillModel" title={t('Distillation')}>
        <SettingsRow
          rowId="memory.completion-backend"
          label={t('Completion backend')}
          description={t('Local GGUF runs on this machine. Remote uses the model below.')}
        >
          <SettingsSelect
            value={chatModel}
            options={chatModelItems}
            onValueChange={setChatModel}
            disabled={!memoryEnabled}
          />
        </SettingsRow>
        {selectedChatModel?.downloadable && (
          <SettingsSubRow
            label={modelStateLabel(selectedChatModel.state)}
            description={
              chatProgress && chatProgress.modelId === selectedChatModel.id
                ? `${chatProgress.file} · ${formatBytes(chatProgress.received)}${
                    chatProgress.total ? ` / ${formatBytes(chatProgress.total)}` : ''
                  }`
                : selectedChatModel.state === 'ready'
                  ? formatBytes(selectedChatModel.downloadedBytes)
                  : formatBytes(selectedChatModel.approxBytes)
            }
          >
            {downloadButtons(selectedChatModel, {
              cancel: () =>
                void window.electronAPI.memory
                  .cancelChatModelDownload(selectedChatModel.id)
                  .then(refreshChatModels),
              remove: () =>
                void window.electronAPI.memory
                  .deleteChatModel(selectedChatModel.id)
                  .then(refreshChatModels),
              download: () =>
                void window.electronAPI.memory
                  .downloadChatModel(selectedChatModel.id)
                  .then(refreshChatModels),
            })}
          </SettingsSubRow>
        )}
        {chatBlocked === 'missing' && (
          <Note tone="danger">
            {t(
              'Local model selected but the weights are not on disk. Distillation and interpretation will wait until you click Download.'
            )}
          </Note>
        )}
        {chatBlocked === 'downloading' && (
          <Note>{t('Download in progress. Distillation waits until the model is ready.')}</Note>
        )}
        {chatModel === 'remote' && (
          <SettingsSubRow
            rowId="memory.distillation-model"
            label={t('Distillation model')}
            description={t('Reads finished sessions and writes the memories.')}
          >
            {distillModel && (
              <SettingsButton variant="ghost" onClick={() => setDistillModel(null)}>
                {t('Follows the title-summary model')}
              </SettingsButton>
            )}
            {modelCandidates.length > 0 && (
              <div className="w-[220px] max-w-full">
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
          </SettingsSubRow>
        )}
        <SettingsRow
          rowId="memory.language"
          label={t('Memory language')}
          description={t(
            'English keeps retrieval and near-duplicate detection stable across languages. Choose Follow conversation if your team only works in one language.'
          )}
        >
          <SettingsSelect
            value={memoryLanguage}
            options={languageItems}
            onValueChange={setMemoryLanguage}
            disabled={!memoryEnabled}
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection rowId="memory.background-processing" title={t('Background processing')}>
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
          <Note tone="danger">
            {t(
              'Automatic distillation is on, but the local model is not ready. Sessions will queue until you download it.'
            )}
          </Note>
        )}
        {distillEnabled && (
          <SettingsSubRow
            rowId="memory.distillWindow"
            label={t('Merge sessions in the same project')}
            description={t(
              'Wait this long after a session ends, then distill every session of the same project that ended meanwhile in one run. Immediately distills each session on its own.'
            )}
          >
            <SettingsSelect
              value={String(distillWindowMinutes)}
              options={distillWindowItems}
              onValueChange={(value) => setDistillWindowMinutes(Number(value))}
              disabled={!memoryEnabled}
            />
          </SettingsSubRow>
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
        <SwitchRow
          rowId="memory.reconcile"
          title={t('Review conflicting memories')}
          description={t(
            'After new memories are written, ask the model whether they contradict older ones. Conflicts are only flagged for your review; nothing is hidden or deleted. Up to 20 model calls per run.'
          )}
          checked={reconcileEnabled}
          onChange={setReconcileEnabled}
          disabled={!memoryEnabled}
        />
        <SettingsSubRow
          label={
            reconcileRun === undefined
              ? t('Review now runs even when the switch above is off.')
              : reconcileRun === null
                ? t('No model is available for memory tasks.')
                : t('Checked {{pairs}} pairs, flagged {{count}} conflicts.', {
                    pairs: String(reconcileRun.judged),
                    count: String(reconcileRun.challenges),
                  })
          }
        >
          <SettingsButton disabled={reconcileBusy || !memoryEnabled} onClick={runReconcile}>
            {reconcileBusy ? t('Running…') : t('Review now')}
          </SettingsButton>
        </SettingsSubRow>
      </SettingsSection>

      <SettingsSection
        rowId="memory.forgetting"
        title={t('Forgetting')}
        description={t(
          'Decay only changes how search ranks a memory. Archiving keeps it and can be undone; nothing on this page ever deletes a memory.'
        )}
      >
        <SwitchRow
          rowId="memory.decay"
          title={t('Rank lower when never retrieved')}
          description={t(
            'Memories that have not been retrieved for a long time rank lower. This changes ranking only — nothing is archived or deleted.'
          )}
          checked={decayEnabled}
          onChange={setDecayEnabled}
          disabled={!memoryEnabled}
        />
        <SwitchRow
          rowId="memory.decayCandidates"
          title={t('Mark archive candidates')}
          description={t(
            'Mark cold, low-importance memories as candidates and show them in the library. Marking alone changes nothing.'
          )}
          checked={decayCandidates}
          onChange={setDecayCandidates}
          disabled={!memoryEnabled || !decayEnabled}
        />
        <SwitchRow
          rowId="memory.decayAutoArchive"
          title={t('Archive candidates automatically')}
          description={t(
            'Archive candidates at the end of each run. Archived memories are hidden from search but kept and can be restored.'
          )}
          checked={decayAutoArchive}
          onChange={setDecayAutoArchive}
          disabled={!memoryEnabled || !decayEnabled || !decayCandidates}
        />
        {decayEnabled && (
          <>
            <SelectRow
              rowId="memory.decayStaleDays"
              title={t('Not retrieved for')}
              description={t(
                'Counted from the last retrieval; a memory that was never retrieved counts from creation.'
              )}
              value={String(decayStaleDays)}
              items={numberItems(FORGETTING_STALE_DAYS_OPTIONS, decayStaleDays, (value) =>
                t('{{count}} days', { count: String(value) })
              )}
              onChange={(value) => setDecayStaleDays(Number(value))}
              disabled={!memoryEnabled}
            />
            <SelectRow
              rowId="memory.decayMaxImportance"
              title={t('Importance at most')}
              description={t(
                'Only memories at or below this importance can become candidates. 0.5 is the lowest tier distillation writes.'
              )}
              value={String(decayMaxImportance)}
              items={numberItems(FORGETTING_MAX_IMPORTANCE_OPTIONS, decayMaxImportance, (value) =>
                value.toFixed(2)
              )}
              onChange={(value) => setDecayMaxImportance(Number(value))}
              disabled={!memoryEnabled}
            />
            <SelectRow
              rowId="memory.decayInterval"
              title={t('Run every')}
              description={t(
                'Checked when the library opens; there is no separate background timer.'
              )}
              value={String(decayIntervalDays)}
              items={numberItems(FORGETTING_INTERVAL_DAYS_OPTIONS, decayIntervalDays, (value) =>
                t('{{count}} days', { count: String(value) })
              )}
              onChange={(value) => setDecayIntervalDays(Number(value))}
              disabled={!memoryEnabled}
            />
            <SettingsRow
              label={
                decayCandidates || decayAutoArchive
                  ? t('Archive candidates: {{count}}', {
                      count: String(forgetting?.candidates ?? 0),
                    })
                  : t('Archive candidates: marking is off')
              }
              description={lastRunText}
            >
              <SettingsButton
                disabled={forgettingBusy !== null || !memoryEnabled}
                onClick={runForgetting}
              >
                {forgettingBusy === 'run' ? t('Running…') : t('Run now')}
              </SettingsButton>
              <SettingsButton
                disabled={!decayCandidates || (forgetting?.candidates ?? 0) === 0}
                onClick={openCandidates}
              >
                {t('Review candidates')}
              </SettingsButton>
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection rowId="memory.stats" title={t('Library')}>
        {stats === null || stats.total === 0 ? (
          <Note>{t('No memories stored yet.')}</Note>
        ) : (
          <>
            {embeddingErrorNotice(stats) && (
              <Note tone="danger">
                {t('Vectors unavailable: {{reason}}', {
                  reason: embeddingErrorNotice(stats) ?? '',
                })}
              </Note>
            )}
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 px-4 py-3 sm:grid-cols-4 max-sm:px-3">
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
              <Stat
                label={t('Never retrieved')}
                value={`${stats.neverHit}/${stats.total}`}
                action={
                  <span className="text-muted-foreground text-xs">
                    {t('{{percent}}% of library', {
                      percent: String(
                        stats.total > 0 ? Math.round((stats.neverHit / stats.total) * 100) : 0
                      ),
                    })}
                  </span>
                }
              />
              <Stat label={t('Added in 7 days')} value={String(stats.addedLast7Days)} />
            </dl>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        rowId="memory.distillSessions"
        title={t('Distill past sessions')}
        description={t(
          'The automatic switch only covers sessions that end from now on. Distill earlier sessions here to fill the library.'
        )}
        actions={
          pendingSessions.length > 0 && (
            <SettingsButton
              data-memory-action="distill-all"
              disabled={!memoryEnabled || !jobsLoaded || distillBusy || chatBlocked !== null}
              onClick={() => requestBulkDistill(sessions, 'all', t('All sessions'))}
            >
              {distillBusy
                ? t('Distilling…')
                : t('Distill all ({{count}})', { count: String(pendingSessions.length) })}
            </SettingsButton>
          )
        }
      >
        {batch && (
          <Note>
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
          </Note>
        )}
        {groups.length === 0 ? (
          <Note>{t('No recorded sessions found.')}</Note>
        ) : (
          groups.map((group) => {
            const groupPending = group.sessions.filter((s) => !s.distilled);
            return (
              <SettingsRow
                key={group.key}
                label={group.name}
                description={t('{{total}} sessions · {{pending}} not distilled', {
                  total: String(group.sessions.length),
                  pending: String(groupPending.length),
                })}
              >
                <SettingsButton variant="ghost" onClick={() => setSessionsOf(group)}>
                  {t('View sessions')}
                </SettingsButton>
                <SettingsButton
                  disabled={
                    !memoryEnabled ||
                    !jobsLoaded ||
                    distillBusy ||
                    group.sessions.length === 0 ||
                    chatBlocked !== null
                  }
                  onClick={() => requestBulkDistill(group.sessions, group.key, group.name)}
                >
                  {distilling === group.key ||
                  group.sessions.some((s) => runningSessions.has(s.sessionId))
                    ? t('Distilling…')
                    : t('Distill project')}
                </SettingsButton>
              </SettingsRow>
            );
          })
        )}
      </SettingsSection>

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
                <ul className="divide-y border-border border-y">
                  {sessionsOf.sessions.map((session) => (
                    <li
                      key={session.sessionId}
                      className="flex items-center justify-between gap-3 py-2"
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
                        disabled={
                          !memoryEnabled || !jobsLoaded || distillBusy || chatBlocked !== null
                        }
                        onClick={() =>
                          void runDistill([session], session.sessionId, session.distilled)
                        }
                      >
                        {distilling === session.sessionId || runningSessions.has(session.sessionId)
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
                  disabled={bulkPrompt.pending.length === 0 || !jobsLoaded || distillBusy}
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
                  disabled={!jobsLoaded || distillBusy}
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

      <SettingsSection
        rowId="memory.jobs"
        title={t('Background tasks')}
        actions={
          <>
            {jobs.kgFailed > 0 && (
              <SettingsButton
                variant="ghost"
                onClick={() => {
                  void window.electronAPI.memory
                    .retryFailedKgJobs()
                    .then(() => loadRef.current?.());
                }}
              >
                {t('Retry failed extractions ({{count}})', { count: String(jobs.kgFailed) })}
              </SettingsButton>
            )}
            {jobRows.some((row) => row.state !== 'running') && (
              <SettingsButton
                variant="ghost"
                title={t(
                  'Removes completed and cancelled jobs. Running tasks are kept. Sessions will show as not distilled again, since that flag is derived from job history — re-distilling is deduplicated, so it will not create duplicate memories.'
                )}
                onClick={() => {
                  void window.electronAPI.memory.clearJobs();
                }}
              >
                {t('Clear finished tasks')}
              </SettingsButton>
            )}
            {jobRows.length > VISIBLE_JOBS && (
              <SettingsButton variant="ghost" onClick={() => setAllJobs(!allJobs)}>
                {allJobs
                  ? t('Show less')
                  : t('Show all {{count}}', { count: String(jobRows.length) })}
              </SettingsButton>
            )}
          </>
        }
      >
        {jobRows.length === 0 ? (
          <Note>{t('Nothing running.')}</Note>
        ) : (
          <ul>
            {(allJobs ? jobRows : jobRows.slice(0, VISIBLE_JOBS)).map((row) => (
              <li key={row.key} className="space-y-1 px-4 py-2.5 max-sm:px-3">
                <div className="flex items-center gap-2">
                  <Badge variant={row.state === 'failed' ? 'destructive' : 'secondary'}>
                    {t(JOB_KIND_LABELS[row.kind])}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{row.target}</span>
                  <span
                    className={cn(
                      'shrink-0 text-xs',
                      row.state === 'failed' ? 'text-destructive-text' : 'text-muted-foreground'
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
      </SettingsSection>

      {children}

      <Dialog open={candidates !== null} onOpenChange={(open) => !open && setCandidates(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Archive candidates')}</DialogTitle>
            <DialogDescription>
              {t(
                'Cold and low-importance memories. Archiving keeps them, hides them from search, and can be undone from the library.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {candidates && candidates.items.length > 0 ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">
                    {t('{{selected}} of {{total}} selected', {
                      selected: String(candidateSelection.size),
                      total: String(candidates.items.length),
                    })}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setCandidateSelection(
                        candidateSelection.size === candidates.items.length
                          ? new Set()
                          : new Set(candidates.items.map((item) => item.id))
                      )
                    }
                  >
                    {candidateSelection.size === candidates.items.length
                      ? t('Clear selection')
                      : t('Select all')}
                  </Button>
                </div>
                <ul className="divide-y border-border border-y">
                  {candidates.items.map((item) => (
                    <li key={item.id} className="flex items-start gap-2 py-2">
                      <Checkbox
                        checked={candidateSelection.has(item.id)}
                        onCheckedChange={() =>
                          setCandidateSelection((current) => {
                            const next = new Set(current);
                            if (next.has(item.id)) next.delete(item.id);
                            else next.add(item.id);
                            return next;
                          })
                        }
                        aria-label={t('Select memory')}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm">{item.title}</p>
                        <p className="text-xs text-muted-foreground">
                          {item.spaceLabel} ·{' '}
                          {t('Importance {{value}}', { value: item.importance.toFixed(2) })} ·{' '}
                          {item.lastHitAt
                            ? t('Last retrieved {{date}}', {
                                date: formatDateTime(item.lastHitAt),
                              })
                            : t('Never retrieved')}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
                {candidates.total > candidates.items.length && (
                  <p className="text-xs text-muted-foreground">
                    {t('Showing the first {{shown}} of {{total}}.', {
                      shown: String(candidates.items.length),
                      total: String(candidates.total),
                    })}
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t('No archive candidates right now.')}
              </p>
            )}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" />}>{t('Close')}</DialogClose>
            <Button
              size="sm"
              disabled={candidateSelection.size === 0 || forgettingBusy !== null}
              onClick={archiveSelected}
            >
              {forgettingBusy === 'archive' ? t('Archiving…') : t('Archive selected')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsPage>
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
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="flex items-center justify-between gap-2">
        <span className="text-[13px]">{value}</span>
        {action}
      </dd>
    </div>
  );
}
