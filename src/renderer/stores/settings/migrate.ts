import { type AccentColor, resolveAccentColor } from '@shared/accentColor';
import { resolveCompactStrategy } from '@shared/compactStrategy';
import { STATUS_LINE_PRESETS, STATUS_LINE_SEGMENT_IDS } from '@shared/statusLine';
import { type EditMode, resolveEditMode } from '@shared/types';
import {
  addComputerDefaultOff,
  COMPUTER_DEFAULT_OFF_SETTINGS_VERSION,
  effectiveSubagentAllowedModes,
} from '@shared/types/builtinTools';
import { isSpeechModelId } from '@shared/types/speech';

/**
 * 持久化数据的版本迁移。
 *
 * 为什么用 zustand persist 的 `migrate` 而不是 `onRehydrateStorage`：
 * `migrate` 只在持久版本落后时跑一次，结果随下一次落盘写回磁盘，旧字段就此消失
 * （persist 紧随 migrate 的那次回写发生在水合闸门打开前，会被 storage.ts 丢弃；
 * 因此 migrate 必须幂等，落盘前每次启动都会重跑一遍）；
 * `onRehydrateStorage` 每次 rehydrate（含多窗口同步广播）都会执行，且不触发回写，
 * 等于把一次性的形状迁移变成永久的读侧补丁。
 */

/** 当前持久化数据版本；改数据形状时 +1 并在 `migrateSettings` 里加一段 */
export const SETTINGS_VERSION = 15;

export function mergeSettingsState<T extends { editMode: EditMode; accentColor: AccentColor }>(
  persisted: unknown,
  current: T
): T {
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return current;
  const source = persisted as Record<string, unknown>;
  const { hashlineEditEnabled, bashInterceptEnabled, voiceModel, ...rest } = source;
  const editMode =
    'editMode' in source || 'hashlineEditEnabled' in source
      ? resolveEditMode(source.editMode, hashlineEditEnabled)
      : current.editMode;
  // 外部手改 settings.json 可能写进未知强调色，非法值落回默认
  const accentColor =
    'accentColor' in source ? resolveAccentColor(source.accentColor) : current.accentColor;
  // 已下架的识别模型（如 enso-asr）保留当前值，与 Main 的回落一致
  const voice = isSpeechModelId(voiceModel) ? { voiceModel } : {};
  void bashInterceptEnabled;
  return { ...current, ...rest, ...voice, editMode, accentColor } as T;
}

/**
 * v0 → v1：`ModelProvider.oauthProviderId` 改名为 `oauthAccountKey`。
 * v1 → v2：新增必填 `defaultModel`，旧设置明确迁为 null，不把数组第一项冒充用户选择。
 * v2 → v3：新增标题总结：缺省关闭（不让升级用户静默多烧 token）、无独立模型。
 * v3 → v4：新增助手代审模型，缺省未选（该档禁用）。
 * v4 → v5：记住上次审批档；缺省未选，新会话仍走代审可用性默认。
 * v5/v6 → v7：移除项目记忆配置，兼容曾保存独立记忆模型的开发版。
 * v7 → v8：旧落盘的空 `disabledBuiltinTools` 不是「用户打开了 memory」——
 * 只是 memory 加进默认关名单之前就写下的「全开」。补上 memory，缺字段不动（initialState 已是关）。
 * v8 → v9：压缩策略改为互斥枚举；旧 `smartCompactEnabled` 布尔迁为 `compactStrategy`，缺字段不动。
 * v9 → v10：文件编辑模式改为互斥枚举；旧 hashline 开关迁移后删除。
 * v10 → v11：移除 Hashline 与 bash 拦截；hashline 回落 replace。
 * v11 → v12：默认编辑模式改为 apply_patch，已有 replace 一并切过去。
 * v12 → v13：subagent/coworker 合并；旧开关迁为 mode 掩码。
 */
export function migrateSettings(persisted: unknown, version: number): unknown {
  if (version >= SETTINGS_VERSION) return persisted;
  if (!persisted || typeof persisted !== 'object' || Array.isArray(persisted)) return persisted;

  let state = { ...(persisted as Record<string, unknown>) };
  if (version < 1 && Array.isArray(state.providers)) {
    state = {
      ...state,
      providers: state.providers.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
        const provider = entry as Record<string, unknown>;
        if (typeof provider.oauthProviderId !== 'string') return provider;
        const { oauthProviderId, ...rest } = provider;
        return { ...rest, oauthAccountKey: oauthProviderId };
      }),
    };
  }

  if (version < 2) {
    state = { ...state, defaultModel: null };
  }

  if (version < 3) {
    state = { ...state, titleSummaryEnabled: false, titleSummaryModel: null };
  }
  if (version < 4) {
    state = { ...state, approvalReviewer: null };
  }
  if (version < 5) {
    state = { ...state, lastApprovalMode: null };
  }
  if (version < 7) {
    const { localMemoryEnabled, memoryModel, memoryConcurrency, ...rest } = state;
    state = rest;
  }
  if (version < 8 && Array.isArray(state.disabledBuiltinTools)) {
    const list = state.disabledBuiltinTools.filter((id): id is string => typeof id === 'string');
    if (!list.includes('memory')) {
      state = { ...state, disabledBuiltinTools: [...list, 'memory'] };
    }
  }
  if (
    version < 9 &&
    (typeof state.smartCompactEnabled === 'boolean' || 'compactStrategy' in state)
  ) {
    state = {
      ...state,
      compactStrategy: resolveCompactStrategy(state.compactStrategy, state.smartCompactEnabled),
    };
  }
  if (version < 10) {
    const { hashlineEditEnabled, ...rest } = state;
    state = {
      ...rest,
      editMode: resolveEditMode(state.editMode, hashlineEditEnabled),
    };
  }
  if (version < 11) {
    const { bashInterceptEnabled, ...rest } = state;
    state = {
      ...rest,
      editMode: resolveEditMode(state.editMode),
    };
    void bashInterceptEnabled;
  }
  if (version < 12) {
    state = { ...state, editMode: 'apply_patch' };
  }
  if (version < 13) {
    state = migrateAgentToolModes(state);
  }
  if (version < COMPUTER_DEFAULT_OFF_SETTINGS_VERSION) {
    state = addComputerDefaultOff(state);
  }
  if (version < 15 && Array.isArray(state.statusLineSegments)) {
    const segments = state.statusLineSegments;
    const oldDefault = [
      'model',
      'tokens',
      'cache',
      'context',
      'turns',
      'speed',
      'duration',
      'sessionTime',
    ];
    const oldFull = STATUS_LINE_SEGMENT_IDS.filter((id) => id !== 'requestBody');
    const matches = (preset: readonly string[]) =>
      segments.length === preset.length && preset.every((id, i) => segments[i] === id);
    if (matches(oldDefault))
      state = { ...state, statusLineSegments: [...STATUS_LINE_PRESETS.default] };
    else if (matches(oldFull))
      state = { ...state, statusLineSegments: [...STATUS_LINE_PRESETS.full] };
  }
  return state;
}

function migrateAgentToolModes(state: Record<string, unknown>): Record<string, unknown> {
  const migrateEntry = (entry: Record<string, unknown>): Record<string, unknown> => {
    if (!Array.isArray(entry.disabledBuiltinTools)) return entry;
    const legacy = entry.disabledBuiltinTools.filter((id): id is string => typeof id === 'string');
    const modes = effectiveSubagentAllowedModes(entry.subagentAllowedModes, legacy);
    const disabled = legacy.filter((id) => id !== 'coworker' && id !== 'subagent');
    if (modes.length === 0) disabled.push('subagent');
    return {
      ...entry,
      disabledBuiltinTools: [...new Set(disabled)],
      subagentAllowedModes: modes,
    };
  };
  const migrated = migrateEntry(state);
  if (!Array.isArray(migrated.projects)) return migrated;
  return {
    ...migrated,
    projects: migrated.projects.map((project) =>
      project && typeof project === 'object' && !Array.isArray(project)
        ? migrateEntry(project as Record<string, unknown>)
        : project
    ),
  };
}
