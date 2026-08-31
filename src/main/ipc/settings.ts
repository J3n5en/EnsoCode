import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import { app, BrowserWindow, ipcMain } from 'electron';

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
  'favoriteTerminalThemes',
  'statusLineSegments',
  'loadLocalSkills',
  'autoUpdate',
  'providers',
  'defaultModel',
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
  'onboarded',
  'keybindings',
  'projects',
] as const;

export type SettingsStateField = (typeof SETTINGS_STATE_FIELDS)[number];

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
    isDirty = false;
    return atomicWriteSettings(cachedSettings);
  }
  return true;
}

export type SettingsBroadcast = 'exclude-sender' | 'all-renderers';

/** 更新缓存、广播窗口、debounce 落盘（SETTINGS_WRITE / WRITE_KEY / Gateway 共用） */
function scheduleWrite(
  data: Record<string, unknown>,
  sender?: Electron.WebContents,
  broadcast: SettingsBroadcast = 'exclude-sender'
): boolean {
  try {
    cachedSettings = data;
    isDirty = true;

    // 普通 store 写排除 sender；Gateway 写显式选择 all-renderers。
    for (const win of BrowserWindow.getAllWindows()) {
      if (
        (broadcast === 'all-renderers' || !sender || win.webContents !== sender) &&
        !win.isDestroyed()
      ) {
        win.webContents.send(IPC_CHANNELS.SETTINGS_CHANGED);
      }
    }

    if (pendingWrite) {
      clearTimeout(pendingWrite);
    }

    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        if (cachedSettings !== null) {
          isDirty = false;
          atomicWriteSettings(cachedSettings);
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
        isDirty = false;
        atomicWriteSettings(cachedSettings);
      }
      pendingWrite = null;
    }, DEBOUNCE_MS);

    return true;
  } catch {
    return false;
  }
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
