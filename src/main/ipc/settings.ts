import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { app, BrowserWindow, ipcMain } from 'electron';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import { getWindowWebContents, sendToWindow } from '../windows/createAppWindow';

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

// 内存缓存和防抖配置
let cachedSettings: Record<string, unknown> | null = null;
let pendingWrite: NodeJS.Timeout | null = null;
let maxWaitTimer: NodeJS.Timeout | null = null;
let isDirty = false;

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 5000;

export const SETTINGS_STATE_FIELDS = [
  'theme',
  'language',
  'terminalTheme',
  'terminalFontSize',
  'terminalFontFamily',
  'terminalFontWeight',
  'terminalFontWeightBold',
  'terminalShell',
  'worktreeRoot',
  'favoriteTerminalThemes',
  'statusLineSegments',
  'loadLocalSkills',
  'loadHarnessAssets',
  'windowsLocalShell',
  'exploreFoldEnabled',
  'bashInterceptEnabled',
  'hashlineEditEnabled',
  'compactStrategy',
  'smartCompactEnabled',
  'smartCompactModel',
  'smartCompactMode',
  'autoUpdate',
  'proxyMode',
  'customProxyUrl',
  'openChangesOnFileEdit',
  'compactReadOnlyTools',
  'expandLiveEdits',
  'chatWide',
  'notifyMainAgentOnly',
  'maxActiveCoworkers',
  'generationStallTimeoutMin',
  'autoArchiveIdleDays',
  'autoArchiveMergedWorktrees',
  'autoDeleteArchivedDays',
  'backgroundImageEnabled',
  'backgroundSourceType',
  'backgroundImagePath',
  'backgroundFolderPath',
  'backgroundUrlPath',
  'backgroundRandomEnabled',
  'backgroundRandomInterval',
  'backgroundOpacity',
  'backgroundBlur',
  'backgroundBrightness',
  'backgroundSaturation',
  'backgroundComposerOpacity',
  'backgroundCodeOpacity',
  'backgroundSizeMode',
  'backgroundRefreshNonce',
  'providers',
  'defaultModel',
  'titleSummaryEnabled',
  'titleSummaryModel',
  'memoryDistillModel',
  'memoryChatModel',
  'memoryLanguage',
  'approvalReviewer',
  'lastApprovalMode',
  'defaultReasoningEnabled',
  'defaultThinkingLevel',
  'subagentModelsEnabled',
  'subagentModels',
  'skills',
  'mcpServers',
  'instructions',
  'presets',
  'defaultPresetId',
  'agentTypes',
  'disabledBuiltinAgentTypes',
  'disabledBuiltinTools',
  'memoryEmbeddingModel',
  'memoryEmbeddingAutoDownload',
  'memoryModelIdleMinutes',
  'memoryEmbeddingRemoteProviderId',
  'memoryDistillEnabled',
  'memoryKgEnabled',
  'onboarded',
  'keybindings',
  'projects',
  'projectGroups',
  'usageModelPricing',
] as const;

export type SettingsStateField = (typeof SETTINGS_STATE_FIELDS)[number];

/** Device-local keys that config-sync must never fingerprint or write back. */
const CONFIG_SYNC_EXCLUDED_STATE_FIELDS = new Set<SettingsStateField>([
  'windowsLocalShell',
  'terminalShell',
  'worktreeRoot',
  'autoUpdate',
  'proxyMode',
  'customProxyUrl',
  'backgroundImageEnabled',
  'backgroundSourceType',
  'backgroundImagePath',
  'backgroundFolderPath',
  'backgroundUrlPath',
  'backgroundRandomEnabled',
  'backgroundRefreshNonce',
  'lastApprovalMode',
  'memoryEmbeddingAutoDownload',
  'memoryModelIdleMinutes',
  'memoryEmbeddingRemoteProviderId',
  'onboarded',
  'projects',
  'projectGroups',
]);

export const CONFIG_SYNC_COMMIT_FIELDS = SETTINGS_STATE_FIELDS.filter(
  (field) => !CONFIG_SYNC_EXCLUDED_STATE_FIELDS.has(field)
);

// 记忆 embedding 配置只存 id/开关，模型文件在 userData/memory/models；切换立即作用于之后的写入与查询
function notifyMemoryEmbeddingSettings(settings: Record<string, unknown>): void {
  void import('../services/memoryHost')
    .then(
      ({
        syncMemoryEmbeddingFromSettings,
        syncMemoryDistillFromSettings,
        syncMemoryKgFromSettings,
      }) => {
        const state = settingsStateOf(settings);
        syncMemoryEmbeddingFromSettings(state);
        syncMemoryDistillFromSettings(state);
        syncMemoryKgFromSettings(state);
      }
    )
    .catch(() => {});
}

function settingsStateOf(settings: Record<string, unknown> | null): Record<string, unknown> {
  const store = settings?.['enso-settings'];
  if (!store || typeof store !== 'object') return {};
  const state = (store as Record<string, unknown>).state;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}

export interface SettingsPatchResult {
  ok: boolean;
  previous?: unknown;
  value?: unknown;
  error?: string;
}

export function readSettings(): Record<string, unknown> | null {
  if (cachedSettings !== null) {
    return cachedSettings;
  }

  try {
    const settingsPath = getSettingsPath();
    if (existsSync(settingsPath)) {
      cachedSettings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return cachedSettings;
    }
  } catch {}
  cachedSettings = null;
  return null;
}

// 原子写入：先写临时文件再重命名，避免崩溃导致文件损坏
function atomicWriteSettings(data: Record<string, unknown>): boolean {
  try {
    const settingsPath = getSettingsPath();
    const tempPath = `${settingsPath}.tmp`;
    writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    renameSync(tempPath, settingsPath);
    return true;
  } catch {
    return false;
  }
}

export function flushSettings(): boolean {
  if (pendingWrite) {
    clearTimeout(pendingWrite);
    pendingWrite = null;
  }
  if (maxWaitTimer) {
    clearTimeout(maxWaitTimer);
    maxWaitTimer = null;
  }

  if (isDirty && cachedSettings !== null) {
    const written = atomicWriteSettings(cachedSettings);
    // Keep dirty state on failure so a later transaction/quit can retry the flush.
    if (written) isDirty = false;
    return written;
  }
  return true;
}

export type SettingsBroadcast = 'exclude-sender' | 'all-renderers';

/** 一次写入把这些字段从非空写成空，视为破坏性：写前把上一份文件快照下来，给用户留恢复余地。 */
const PROTECTED_FIELDS = ['providers', 'skills', 'mcpServers', 'instructions'] as const;
const MAX_BACKUPS = 5;

function settingsState(data: Record<string, unknown> | null): Record<string, unknown> {
  const store = data?.['enso-settings'];
  const state =
    store && typeof store === 'object' ? (store as Record<string, unknown>).state : null;
  return state && typeof state === 'object' ? (state as Record<string, unknown>) : {};
}

function destructiveFields(prev: Record<string, unknown> | null, next: Record<string, unknown>) {
  const before = settingsState(prev);
  const after = settingsState(next);
  return PROTECTED_FIELDS.filter((field) => {
    const was = before[field];
    const now = after[field];
    return Array.isArray(was) && was.length > 0 && (!Array.isArray(now) || now.length === 0);
  });
}

/** 快照当前磁盘文件为 settings.backup-<ts>.json，只留最近 MAX_BACKUPS 份。失败不影响写入。 */
function snapshotBeforeDestructiveWrite(fields: string[]): void {
  try {
    const settingsPath = getSettingsPath();
    if (!existsSync(settingsPath)) return;
    const dir = join(settingsPath, '..');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(settingsPath, join(dir, `settings.backup-${stamp}.json`));
    const stale = readdirSync(dir)
      .filter((f) => f.startsWith('settings.backup-') && f.endsWith('.json'))
      .sort()
      .slice(0, -MAX_BACKUPS);
    for (const f of stale) rmSync(join(dir, f), { force: true });
    console.warn(`[settings] destructive write empties ${fields.join(', ')}; snapshot saved`);
  } catch {}
}

/** 更新缓存、广播窗口、debounce 落盘（SETTINGS_WRITE / WRITE_KEY / Gateway 共用） */
function scheduleWrite(
  data: Record<string, unknown>,
  sender?: Electron.WebContents,
  broadcast: SettingsBroadcast = 'exclude-sender'
): boolean {
  try {
    const destructive = destructiveFields(readSettings(), data);
    if (destructive.length > 0) {
      flushSettings();
      snapshotBeforeDestructiveWrite(destructive);
    }
    cachedSettings = data;
    isDirty = true;
    notifyMemoryEmbeddingSettings(data);

    // 普通 store 写排除 sender；Gateway 写显式选择 all-renderers。
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      const ui = getWindowWebContents(win);
      if (broadcast === 'all-renderers' || !sender || ui !== sender) {
        sendToWindow(win, IPC_CHANNELS.SETTINGS_CHANGED);
      }
    }

    if (pendingWrite) {
      clearTimeout(pendingWrite);
    }

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        if (cachedSettings !== null) {
          const written = atomicWriteSettings(cachedSettings);
          if (written) isDirty = false;
        }
        maxWaitTimer = null;
        pendingWrite = null;
      }, MAX_WAIT_MS);
    }

    pendingWrite = setTimeout(() => {
      if (maxWaitTimer) {
        clearTimeout(maxWaitTimer);
        maxWaitTimer = null;
      }
      if (cachedSettings !== null) {
        const written = atomicWriteSettings(cachedSettings);
        if (written) isDirty = false;
      }
      pendingWrite = null;
    }, DEBOUNCE_MS);

    void import('../services/agentHost')
      .then(async ({ pushApprovalReviewer, pushMaxActiveCoworkers }) => {
        pushApprovalReviewer(await readStoredOauthCredentialKeys());
        pushMaxActiveCoworkers();
      })
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Fingerprint only portable settings fields used by import preview. */
export function settingsFingerprint(settings: Record<string, unknown> | null): string {
  const state = settingsStateOf(settings);
  const portable: Record<string, unknown> = {};
  for (const field of CONFIG_SYNC_COMMIT_FIELDS) {
    if (field in state) portable[field] = state[field];
  }
  return JSON.stringify(portable);
}

export interface SettingsTransactionResult {
  ok: boolean;
  backupPath?: string;
  error?: string;
}

/**
 * Apply a full sync allowlist patch as one durable settings transaction.
 * There is deliberately no await in this critical section: callers must not
 * observe a cache update or broadcast until the backup and atomic rename both
 * succeed.
 */
export function commitSettingsTransaction(
  expectedFingerprint: string,
  statePatch: Record<string, unknown>
): SettingsTransactionResult {
  const current = readSettings() ?? {};
  if (settingsFingerprint(current) !== expectedFingerprint) {
    return { ok: false, error: 'Settings changed since preview; preview again.' };
  }
  if (!flushSettings()) {
    return { ok: false, error: 'Unable to flush pending settings writes.' };
  }

  const latest = readSettings() ?? {};
  const settingsPath = getSettingsPath();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(
    app.getPath('userData'),
    `settings.config-sync-backup-${stamp}-${randomUUID()}.json`
  );
  try {
    // A complete pre-import snapshot is mandatory, including all unrelated stores.
    if (existsSync(settingsPath)) copyFileSync(settingsPath, backupPath);
    else writeFileSync(backupPath, JSON.stringify(latest, null, 2), 'utf8');
    chmodSync(backupPath, 0o600);
  } catch {
    return { ok: false, error: 'Unable to create settings backup.' };
  }
  try {
    const dir = app.getPath('userData');
    const stale = readdirSync(dir)
      .filter((file) => file.startsWith('settings.config-sync-backup-') && file.endsWith('.json'))
      .sort()
      .slice(0, -MAX_BACKUPS);
    for (const file of stale) rmSync(join(dir, file), { force: true });
  } catch {
    // Rotation is best-effort; a leftover extra backup must not fail the import.
  }

  const persisted =
    latest['enso-settings'] && typeof latest['enso-settings'] === 'object'
      ? (latest['enso-settings'] as Record<string, unknown>)
      : {};
  const currentState =
    persisted.state && typeof persisted.state === 'object'
      ? { ...(persisted.state as Record<string, unknown>) }
      : {};
  for (const field of CONFIG_SYNC_COMMIT_FIELDS) {
    if (field in statePatch) currentState[field] = statePatch[field];
  }
  const next = {
    ...latest,
    'enso-settings': {
      ...persisted,
      state: currentState,
    },
  };
  if (!atomicWriteSettings(next)) {
    return { ok: false, error: 'Unable to write settings.' };
  }

  cachedSettings = next;
  isDirty = false;
  notifyMemoryEmbeddingSettings(next);
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      sendToWindow(win, IPC_CHANNELS.SETTINGS_CHANGED);
    }
  } catch {
    // Durable write already succeeded; a dead renderer must not fail the import.
  }
  void import('../services/agentHost')
    .then(async ({ pushApprovalReviewer, pushMaxActiveCoworkers }) => {
      pushApprovalReviewer(await readStoredOauthCredentialKeys());
      pushMaxActiveCoworkers();
    })
    .catch(() => {});
  return { ok: true, backupPath };
}

/**
 * Gateway 的唯一设置写入口：只允许登记字段，保留 zustand 容器与其它字段，
 * 并复用现有缓存、原子写和多窗口广播。
 */
export function patchSettingsState(
  field: string,
  value: unknown,
  sender?: Electron.WebContents,
  broadcast: SettingsBroadcast = 'all-renderers'
): SettingsPatchResult {
  if (!SETTINGS_STATE_FIELDS.includes(field as SettingsStateField)) {
    return { ok: false, error: `Unregistered settings field: ${field}` };
  }
  const current = readSettings() ?? {};
  const persisted =
    current['enso-settings'] && typeof current['enso-settings'] === 'object'
      ? (current['enso-settings'] as Record<string, unknown>)
      : {};
  const state =
    persisted.state && typeof persisted.state === 'object'
      ? (persisted.state as Record<string, unknown>)
      : {};
  const previous = state[field];
  const nextState = { ...state, [field]: value };
  const next = {
    ...current,
    'enso-settings': {
      ...persisted,
      state: nextState,
    },
  };
  return scheduleWrite(next, sender, broadcast)
    ? { ok: true, previous, value }
    : { ok: false, error: `Failed to write settings field: ${field}` };
}

/** 删除项目及其会话元数据；两个 zustand store 在同一次顶层按键合并中原子更新。 */
export function removeProjectAndConversations(
  projectId: string,
  sender?: Electron.WebContents,
  broadcast: SettingsBroadcast = 'all-renderers'
): SettingsPatchResult {
  const current = readSettings() ?? {};
  const settingsStore =
    current['enso-settings'] && typeof current['enso-settings'] === 'object'
      ? (current['enso-settings'] as Record<string, unknown>)
      : {};
  const settingsState =
    settingsStore.state && typeof settingsStore.state === 'object'
      ? (settingsStore.state as Record<string, unknown>)
      : {};
  const projects = Array.isArray(settingsState.projects) ? settingsState.projects : [];
  const project = projects.find(
    (entry) =>
      entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === projectId
  );
  if (!project) return { ok: false, error: `Project not found: ${projectId}` };

  const conversationStore =
    current['enso-conversations'] && typeof current['enso-conversations'] === 'object'
      ? (current['enso-conversations'] as Record<string, unknown>)
      : {};
  const conversationState =
    conversationStore.state && typeof conversationStore.state === 'object'
      ? (conversationStore.state as Record<string, unknown>)
      : {};
  const conversations =
    conversationState.conversations && typeof conversationState.conversations === 'object'
      ? (conversationState.conversations as Record<string, unknown>)
      : {};
  const removedIds = Object.entries(conversations)
    .filter(([, entry]) => {
      const conversation =
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
      return conversation?.projectId === projectId;
    })
    .map(([id]) => id);
  const removedSet = new Set(removedIds);
  const nextConversations = Object.fromEntries(
    Object.entries(conversations).filter(([id]) => !removedSet.has(id))
  );
  const nextOrder = Array.isArray(conversationState.order)
    ? conversationState.order.filter((id) => typeof id !== 'string' || !removedSet.has(id))
    : conversationState.order;
  const next = {
    ...current,
    'enso-settings': {
      ...settingsStore,
      state: {
        ...settingsState,
        projects: projects.filter((entry) => entry !== project),
      },
    },
    'enso-conversations': {
      ...conversationStore,
      state: {
        ...conversationState,
        conversations: nextConversations,
        ...(nextOrder === undefined ? {} : { order: nextOrder }),
        ...(typeof conversationState.activeId === 'string' &&
        removedSet.has(conversationState.activeId)
          ? { activeId: undefined }
          : {}),
      },
    },
  };
  return scheduleWrite(next, sender, broadcast)
    ? { ok: true, previous: { project, conversationIds: removedIds }, value: null }
    : { ok: false, error: `Failed to remove project: ${projectId}` };
}

export function registerSettingsHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SETTINGS_READ, async () => {
    return readSettings();
  });

  // 按键合并写：只更新单个顶层键,避免多 store 并发 read-modify-write 互相覆盖
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE_KEY, async (event, name: string, value: unknown) => {
    const current = readSettings() ?? {};
    const next = { ...current };
    if (value === undefined) delete next[name];
    else next[name] = value;
    return scheduleWrite(next, event.sender);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE, async (event, data: unknown) => {
    return scheduleWrite(data as Record<string, unknown>, event.sender);
  });

  app.on('before-quit', () => {
    flushSettings();
  });
}
