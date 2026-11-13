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
import { app, ipcMain, type RendererContents } from '@platform';
import {
  type ContextMenuOpen,
  type FileOpenRule,
  normalizeContextMenuOpen,
  normalizeFileOpenRules,
  parseContextMenuOpen,
  parseFileOpenRules,
} from '@shared/fileOpening';
import { type Locale, normalizeLocale } from '@shared/i18n';
import { collectPresetPromptIds } from '@shared/presetPrompts';
import { normalizeSshTimeoutSeconds } from '@shared/sshTimeout';
import { IPC_CHANNELS, isEditMode, resolveEditMode } from '@shared/types';
import { appDesktop } from '../services/desktopHooks';
import { readStoredOauthCredentialKeys } from '../services/oauthProviders';
import {
  parseTrayPreventDisplaySleep,
  parseTraySleepPolicy,
  type TraySleepPolicy,
} from '../services/pairPowerKeepAlive';
import {
  CONVERSATIONS_KEY,
  mergeConversationsWrite,
  noteConversationsRead,
} from '../services/remoteRenderer/conversationSync';
import { sendToRemoteRenderers } from '../services/remoteRenderer/senders';
import { broadcastToRenderers } from '../services/renderers';
import { deleteSystemPrompt } from '../services/systemPromptStore';
import { localUi } from '../services/uiHost';

function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

// 内存缓存和防抖配置
let cachedSettings: Record<string, unknown> | null = null;
let pendingWrite: NodeJS.Timeout | null = null;
let maxWaitTimer: NodeJS.Timeout | null = null;
let isDirty = false;
const pendingSystemPromptDeletes = new Set<string>();

const DEBOUNCE_MS = 500;
const MAX_WAIT_MS = 5000;

export const SETTINGS_STATE_FIELDS = [
  'theme',
  'themeId',
  'accentColor',
  'userCssEnabled',
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
  'rtkEnabled',
  'computerPreview',
  'computerAllowAllApps',
  'editMode',
  'openLinksInBuiltinBrowser',
  'hashlineEditEnabled',
  'compactStrategy',
  'smartCompactEnabled',
  'smartCompactModel',
  'smartCompactMode',
  'autoUpdate',
  'autoRestartWhenIdle',
  'pluginAutoUpdate',
  'proxyMode',
  'customProxyUrl',
  'customCaCertPath',
  'openChangesOnFileEdit',
  'fileOpenRules',
  'contextMenuOpen',
  'compactReadOnlyTools',
  'expandLiveEdits',
  'expandLiveReasoning',
  'autoCollapseTurns',
  'collapseCompletedActivity',
  'collapseLiveActivity',
  'liveActivityFoldDelaySec',
  'pinUnfinishedTodos',
  'pinnedModels',
  'headerSessionTabs',
  'headerRecentMinutes',
  'chatWide',
  'navRailSide',
  'chatTypography',
  'notifyMainAgentOnly',
  'maxActiveCoworkers',
  'autoRetryLimit',
  'privacyMasking',
  'shell',
  'sshTimeoutSeconds',
  'generationStallTimeoutMin',
  'autoArchiveIdleDays',
  'autoArchiveMergedWorktrees',
  'autoDeleteArchivedDays',
  'activeRetentionMinutes',
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
  'backgroundMask',
  'borderOpacity',
  'backgroundComposerOpacity',
  'backgroundCodeOpacity',
  'backgroundSizeMode',
  'backgroundRefreshNonce',
  'providers',
  'defaultModel',
  'defaultModelFollowLast',
  'titleSummaryEnabled',
  'titleSummaryModel',
  'imageGenerationModel',
  'memoryDistillModel',
  'memoryChatModel',
  'memoryLanguage',
  'approvalReviewer',
  'approvalAutoManage',
  'approvalAllowThreshold',
  'lastApprovalMode',
  'defaultReasoningEnabled',
  'defaultThinkingLevel',
  'subagentModelsEnabled',
  'subagentModels',
  'virtualModels',
  'skills',
  'plugins',
  'mcpServers',
  'instructions',
  'presets',
  'defaultPresetId',
  'agentTypes',
  'disabledBuiltinAgentTypes',
  'disabledBuiltinTools',
  'webSearchChain',
  'disabledWorkflowPresets',
  'subagentAllowedModes',
  'memoryEmbeddingModel',
  'memoryEmbeddingAutoDownload',
  'memoryModelIdleMinutes',
  'memoryEmbeddingRemoteProviderId',
  'memoryDistillEnabled',
  'voiceInputEnabled',
  'botModeEnabled',
  'scratchSessionsEnabled',
  'dropShelfEnabled',
  'botMaxRunningTurns',
  'botDiscussModeEnabled',
  'botRouteClassifier',
  'botAssistantModel',
  'protectedActionsInCode',
  'dcgEnabled',
  'voiceInputDevice',
  'voiceModel',
  'voiceCorrectionEnabled',
  'voiceCorrectionModel',
  'voiceCorrectionRemoteModel',
  'voiceVocabulary',
  'voiceGeminiApiKey',
  'memoryKgEnabled',
  'onboarded',
  'keybindings',
  'projects',
  'projectGroups',
  'usageModelPricing',
] as const;

export type SettingsStateField = (typeof SETTINGS_STATE_FIELDS)[number];

/** 仅限本机的字段：config-sync 绝不计入指纹，也绝不回写。 */
const CONFIG_SYNC_EXCLUDED_STATE_FIELDS = new Set<SettingsStateField>([
  'hashlineEditEnabled',
  'pinnedModels',
  'approvalAutoManage',
  'approvalAllowThreshold',
  'privacyMasking',
  'shell',
  'virtualModels',
  'windowsLocalShell',
  'computerPreview',
  'computerAllowAllApps',
  'terminalShell',
  'openLinksInBuiltinBrowser',
  'worktreeRoot',
  'fileOpenRules',
  'contextMenuOpen',
  'autoUpdate',
  'autoRestartWhenIdle',
  'pluginAutoUpdate',
  'proxyMode',
  'customProxyUrl',
  'customCaCertPath',
  'sshTimeoutSeconds',
  'backgroundImageEnabled',
  'backgroundSourceType',
  'backgroundImagePath',
  'backgroundFolderPath',
  'backgroundUrlPath',
  'backgroundRandomEnabled',
  'backgroundRefreshNonce',
  'themeId',
  'userCssEnabled',
  'lastApprovalMode',
  'memoryEmbeddingAutoDownload',
  'memoryModelIdleMinutes',
  'memoryEmbeddingRemoteProviderId',
  'voiceInputEnabled',
  'botModeEnabled',
  'scratchSessionsEnabled',
  'dropShelfEnabled',
  'botMaxRunningTurns',
  'botDiscussModeEnabled',
  'botRouteClassifier',
  'botAssistantModel',
  'protectedActionsInCode',
  'dcgEnabled',
  'voiceInputDevice',
  'voiceModel',
  'voiceCorrectionEnabled',
  'voiceCorrectionModel',
  'voiceCorrectionRemoteModel',
  'voiceVocabulary',
  'voiceGeminiApiKey',
  'onboarded',
  'headerSessionTabs',
  'headerRecentMinutes',
  'plugins',
  'projects',
  'projectGroups',
  'disabledWorkflowPresets',
  // 与 CONFIG_SYNC_FIELD_POLICY 的 excluded 一致：引用本机 provider 条目，跨机悬空
  'webSearchChain',
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

function notifyTrayToggleShortcut(settings: Record<string, unknown>): void {
  const keybindings = settingsStateOf(settings).keybindings;
  appDesktop().syncTrayToggleShortcut(keybindings);
}

function notifyDropShelf(settings: Record<string, unknown>): void {
  appDesktop().syncDropShelf(settingsStateOf(settings).dropShelfEnabled === true);
}

function notifyAppLanguage(
  previous: Record<string, unknown> | null,
  next: Record<string, unknown>
): void {
  if (settingsStateOf(previous).language !== settingsStateOf(next).language) {
    appDesktop().syncAppLanguage();
  }
}

function notifySpeechSettings(settings: Record<string, unknown>): void {
  const state = settingsStateOf(settings);
  void import('../services/speech/service')
    .then(({ syncSpeechFromSettings }) => syncSpeechFromSettings(state))
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

function systemPromptIds(settings: Record<string, unknown> | null): Set<string> {
  const presets = settingsStateOf(settings).presets;
  const ids = new Set<string>();
  for (const preset of Array.isArray(presets) ? presets : []) {
    for (const id of collectPresetPromptIds(preset)) ids.add(id);
  }
  return ids;
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
    // 含供应商 apiKey、MCP env 明文：只给本人读写，rename 后 settings.json 沿用这个权限
    writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
    renameSync(tempPath, settingsPath);
    tightenOwnerOnly(settingsPath);
    // 正文只能在引用成功落盘后回收；失败/防抖窗口内必须保留旧磁盘配置的正文。
    if (pendingSystemPromptDeletes.size > 0) {
      const referenced = systemPromptIds(data);
      for (const id of pendingSystemPromptDeletes) {
        if (referenced.has(id) || deleteSystemPrompt(id).ok) pendingSystemPromptDeletes.delete(id);
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** mode 只在新建时生效；残留的 0644 .tmp 被 rename 上来后这里再收紧。失败不挡住落盘。 */
function tightenOwnerOnly(file: string): void {
  if (process.platform === 'win32') return;
  try {
    chmodSync(file, 0o600);
  } catch {
    // 权限收紧失败不让设置写盘失败
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
    // 写入失败时保留 dirty 状态，之后的事务或退出时可再次尝试 flush。
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
  sender?: RendererContents,
  broadcast: SettingsBroadcast = 'exclude-sender',
  /** 远端主界面已经通过会话补丁拿到这次变化：不再让它经中继整份重读 settings */
  patchedRemoteMain = false
): boolean {
  try {
    const store = objectRecord(data['enso-settings']);
    const state = objectRecord(store?.state);
    if (state) {
      let normalized = state;
      if ('fileOpenRules' in state) {
        const rules = parseFileOpenRules(state.fileOpenRules);
        if (!rules) return false;
        normalized = { ...normalized, fileOpenRules: rules };
      }
      if ('contextMenuOpen' in state) {
        const config = parseContextMenuOpen(state.contextMenuOpen);
        if (!config) return false;
        normalized = { ...normalized, contextMenuOpen: config };
      }
      data = { ...data, 'enso-settings': { ...store, state: normalized } };
    }
    const previous = readSettings();
    const destructive = destructiveFields(previous, data);
    if (destructive.length > 0) {
      flushSettings();
      snapshotBeforeDestructiveWrite(destructive);
    }
    if (settingsStateOf(previous).presets !== settingsStateOf(data).presets) {
      const nextPromptIds = systemPromptIds(data);
      for (const id of systemPromptIds(previous)) {
        if (!nextPromptIds.has(id)) pendingSystemPromptDeletes.add(id);
      }
    }
    cachedSettings = data;
    isDirty = true;
    notifyMemoryEmbeddingSettings(data);
    notifyTrayToggleShortcut(data);
    notifyDropShelf(data);
    notifySpeechSettings(data);
    notifyAppLanguage(previous, data);
    if (
      settingsStateOf(previous).botModeEnabled !== settingsStateOf(data).botModeEnabled ||
      settingsStateOf(previous).botMaxRunningTurns !== settingsStateOf(data).botMaxRunningTurns
    ) {
      void import('./bots')
        .then(({ syncBotModeServices }) => syncBotModeServices())
        .catch(() => {});
    }
    // 讨论模式开关不能走 syncBotModeServices：后者在 Bot 模式关闭时会销毁整套服务
    if (
      (settingsStateOf(previous).botDiscussModeEnabled === true) !==
      (settingsStateOf(data).botDiscussModeEnabled === true)
    ) {
      void import('./bots').then(({ syncBotDiscussMode }) => syncBotDiscussMode()).catch(() => {});
    }

    // 普通 store 写排除 sender；Gateway 写显式选择 all-renderers。
    for (const contents of localUi()?.allContents() ?? []) {
      if (broadcast === 'all-renderers' || !sender || contents !== sender) {
        contents.send(IPC_CHANNELS.SETTINGS_CHANGED);
      }
    }
    sendToRemoteRenderers(
      IPC_CHANNELS.SETTINGS_CHANGED,
      [],
      broadcast === 'all-renderers' ? undefined : sender?.id,
      patchedRemoteMain ? 'main' : undefined
    );

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
      .then(
        async ({
          pushApprovalReviewer,
          pushCompactRoute,
          pushMaxActiveCoworkers,
          pushAutoRetryLimit,
          pushPrivacyMasking,
          pushShellLimits,
          pushDisabledWorkflowPresets,
          pushBuiltinTools,
          pushModelDirectory,
          pushWebSearchConfig,
          pushImageGenerationConfig,
        }) => {
          pushApprovalReviewer(await readStoredOauthCredentialKeys());
          pushCompactRoute(await readStoredOauthCredentialKeys());
          pushMaxActiveCoworkers();
          pushAutoRetryLimit();
          pushPrivacyMasking();
          pushShellLimits();
          pushDisabledWorkflowPresets();
          pushBuiltinTools();
          pushModelDirectory();
          pushWebSearchConfig();
          pushImageGenerationConfig();
        }
      )
      .catch(() => {});
    // 目录只重合成自定义分区；动态 import 避免 settings ↔ modelDirectory 静态环。
    void import('../services/modelDirectory')
      .then(({ notifyModelDirectorySettingsChanged }) => notifyModelDirectorySettingsChanged())
      .catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** 只对导入预览用到的可迁移设置字段计算指纹。 */
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
 * 把完整的同步白名单补丁作为一次持久化设置事务应用。
 * 这段临界区刻意不含 await：备份和原子 rename 都成功之前，
 * 调用方不能观察到缓存更新或广播。
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
    // 导入前必须先做完整快照，包括所有不相关的 store。
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
    // 轮转尽力而为；多留下一份旧备份不能导致导入失败。
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
  if ('editMode' in statePatch) delete currentState.hashlineEditEnabled;
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
  notifyTrayToggleShortcut(next);
  notifyDropShelf(next);
  notifySpeechSettings(next);
  notifyAppLanguage(latest, next);
  try {
    broadcastToRenderers(IPC_CHANNELS.SETTINGS_CHANGED);
  } catch {
    // 持久化写入已成功；renderer 已失效也不能让导入失败。
  }
  void import('../services/agentHost')
    .then(
      async ({
        pushApprovalReviewer,
        pushCompactRoute,
        pushMaxActiveCoworkers,
        pushAutoRetryLimit,
        pushPrivacyMasking,
        pushShellLimits,
        pushDisabledWorkflowPresets,
        pushBuiltinTools,
        pushModelDirectory,
        pushWebSearchConfig,
        pushImageGenerationConfig,
      }) => {
        pushApprovalReviewer(await readStoredOauthCredentialKeys());
        pushCompactRoute(await readStoredOauthCredentialKeys());
        pushMaxActiveCoworkers();
        pushAutoRetryLimit();
        pushPrivacyMasking();
        pushShellLimits();
        pushDisabledWorkflowPresets();
        pushBuiltinTools();
        pushModelDirectory();
        pushWebSearchConfig();
        pushImageGenerationConfig();
      }
    )
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
  sender?: RendererContents,
  broadcast: SettingsBroadcast = 'all-renderers'
): SettingsPatchResult {
  if (!SETTINGS_STATE_FIELDS.includes(field as SettingsStateField)) {
    return { ok: false, error: `Unregistered settings field: ${field}` };
  }
  let targetField = field as SettingsStateField;
  let targetValue = value;
  if (targetField === 'hashlineEditEnabled') {
    if (typeof value !== 'boolean') return { ok: false, error: 'Invalid legacy edit mode' };
    targetField = 'editMode';
    targetValue = resolveEditMode(undefined, value);
  } else if (targetField === 'editMode' && !isEditMode(value)) {
    return { ok: false, error: 'Invalid edit mode' };
  } else if (targetField === 'fileOpenRules') {
    const rules = parseFileOpenRules(value);
    if (!rules) return { ok: false, error: 'Invalid file open rules' };
    targetValue = rules;
  } else if (targetField === 'contextMenuOpen') {
    const config = parseContextMenuOpen(value);
    if (!config) return { ok: false, error: 'Invalid context menu opening' };
    targetValue = config;
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
  const previous = state[targetField];
  const nextState = { ...state, [targetField]: targetValue };
  if (targetField === 'editMode') delete nextState.hashlineEditEnabled;
  const next = {
    ...current,
    'enso-settings': {
      ...persisted,
      state: nextState,
    },
  };
  return scheduleWrite(next, sender, broadcast)
    ? { ok: true, previous, value: targetValue }
    : { ok: false, error: `Failed to write settings field: ${field}` };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 当前设置 state 快照（本机配置 CLI 读取用） */
export function readSettingsState(): Record<string, unknown> {
  return settingsStateOf(readSettings());
}

/** 丢弃内存副本并以磁盘为准重读，再走与普通写入相同的通知与广播（本机配置 CLI 的 reload） */
export function reloadSettingsFromDisk(): boolean {
  if (pendingWrite) clearTimeout(pendingWrite);
  if (maxWaitTimer) clearTimeout(maxWaitTimer);
  pendingWrite = null;
  maxWaitTimer = null;
  isDirty = false;
  cachedSettings = null;
  const data = readSettings();
  return data !== null && scheduleWrite(data, undefined, 'all-renderers');
}

const TRAY_SETTINGS_KEY = 'enso-tray';

export function readTraySleepPolicy(): TraySleepPolicy {
  return parseTraySleepPolicy(objectRecord(readSettings()?.[TRAY_SETTINGS_KEY])?.sleepPolicy);
}

export function writeTraySleepPolicy(policy: TraySleepPolicy): boolean {
  return writeTrayState({ sleepPolicy: policy });
}

export function readTrayPreventDisplaySleep(): boolean {
  return parseTrayPreventDisplaySleep(
    objectRecord(readSettings()?.[TRAY_SETTINGS_KEY])?.preventDisplaySleep
  );
}

export function readSshTimeoutSeconds(): number {
  return normalizeSshTimeoutSeconds(settingsStateOf(readSettings()).sshTimeoutSeconds);
}

/**
 * 从 Main 持久化设置读取本机打开规则，坏配置只回退默认行为，绝不采信请求中的动作或应用路径。
 */
export function readFileOpenRules(): FileOpenRule[] {
  return normalizeFileOpenRules(settingsStateOf(readSettings()).fileOpenRules);
}

export function readLocale(): Locale {
  const language = settingsStateOf(readSettings()).language;
  return normalizeLocale(typeof language === 'string' ? language : undefined);
}

export function readContextMenuOpen(): ContextMenuOpen {
  return normalizeContextMenuOpen(settingsStateOf(readSettings()).contextMenuOpen);
}

export function writeTrayPreventDisplaySleep(enabled: boolean): boolean {
  return writeTrayState({ preventDisplaySleep: enabled });
}

function trayState(): Record<string, unknown> {
  return objectRecord(readSettings()?.[TRAY_SETTINGS_KEY]) ?? {};
}

function writeTrayState(patch: Record<string, unknown>): boolean {
  const current = readSettings() ?? {};
  return scheduleWrite({
    ...current,
    [TRAY_SETTINGS_KEY]: { ...trayState(), ...patch },
  });
}

export function writeTrayReenterAfterUpdate(reenter: boolean): boolean {
  return writeTrayState({ reenterAfterUpdate: reenter });
}

export function consumeTrayReenterAfterUpdate(): boolean {
  if (trayState().reenterAfterUpdate !== true) return false;
  writeTrayReenterAfterUpdate(false);
  return true;
}

/** 无 renderer 时由 Main 改会话元数据；形状与 zustand persist 的 enso-conversations 一致。 */
export function patchConversationsState(
  mutate: (state: {
    conversations: Record<string, Record<string, unknown>>;
    order: string[];
    activeId: unknown;
  }) => void
): boolean {
  const current = readSettings() ?? {};
  const store = objectRecord(current['enso-conversations']) ?? {};
  const state = objectRecord(store.state) ?? {};
  const conversations: Record<string, Record<string, unknown>> = {};
  for (const [id, value] of Object.entries(objectRecord(state.conversations) ?? {})) {
    const row = objectRecord(value);
    if (row) conversations[id] = row;
  }
  const order = Array.isArray(state.order)
    ? state.order.filter((id): id is string => typeof id === 'string')
    : [];
  const nextState = { conversations, order, activeId: state.activeId };
  mutate(nextState);
  return scheduleWrite({
    ...current,
    'enso-conversations': {
      ...store,
      state: { ...state, ...nextState },
    },
  });
}

export function readPersistedConversation(sessionId: string): Record<string, unknown> | null {
  const store = objectRecord(readSettings()?.['enso-conversations']);
  const conversations = objectRecord(objectRecord(store?.state)?.conversations);
  return conversations ? objectRecord(conversations[sessionId]) : null;
}

/** 删除项目及其会话元数据；两个 zustand store 在同一次顶层按键合并中原子更新。 */
export function removeProjectAndConversations(
  projectId: string,
  sender?: RendererContents,
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
  ipcMain.handle(IPC_CHANNELS.SETTINGS_READ, async (event) => {
    const data = readSettings();
    noteConversationsRead(event.sender, data?.[CONVERSATIONS_KEY]);
    return data;
  });

  // 按键合并写：只更新单个顶层键,避免多 store 并发 read-modify-write 互相覆盖
  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE_KEY, async (event, name: unknown, value: unknown) => {
    if (typeof name !== 'string') return false;
    const current = readSettings() ?? {};
    const next = { ...current };
    const merged =
      name === CONVERSATIONS_KEY
        ? mergeConversationsWrite(event.sender, current[name], value)
        : value;
    if (merged === undefined) delete next[name];
    else next[name] = merged;
    return scheduleWrite(
      next,
      event.sender,
      'exclude-sender',
      name === CONVERSATIONS_KEY && value !== undefined
    );
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_WRITE, async (event, data: unknown) => {
    const record = objectRecord(data);
    return record ? scheduleWrite(record, event.sender) : false;
  });

  app.on('before-quit', () => {
    flushSettings();
  });
}
