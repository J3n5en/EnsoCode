import type { DefaultModelRef } from '@shared/defaultModel';
import type { ThinkingLevel } from '@shared/types/agent';
import { APPROVAL_MODES, THINKING_LEVELS } from '@shared/types/agentConstants';
import {
  asModelRef,
  providersFromSettings,
  readSettingsState,
  virtualModelsFromSettings,
} from '../agentHost';
import { type MainSessionDefaultsResult, mainSessionDefaults } from './sessionFactory';

type ScopedSource = {
  id?: string;
  groupId?: string;
  defaultModel?: DefaultModelRef;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

function scopedSource(value: unknown): ScopedSource {
  const entry = record(value);
  if (!entry) return {};
  const defaultModel = asModelRef(entry.defaultModel);
  const thinkingLevel = THINKING_LEVELS.find((level) => level === entry.defaultThinkingLevel);
  return {
    ...(typeof entry.id === 'string' ? { id: entry.id } : {}),
    ...(typeof entry.groupId === 'string' ? { groupId: entry.groupId } : {}),
    ...(defaultModel ? { defaultModel } : {}),
    ...(typeof entry.defaultReasoningEnabled === 'boolean'
      ? { defaultReasoningEnabled: entry.defaultReasoningEnabled }
      : {}),
    ...(thinkingLevel ? { defaultThinkingLevel: thinkingLevel } : {}),
  };
}

/** 上次记过日志的报错；同一个不可用原因只记一次，恢复后清掉 */
let loggedUnavailable: string | null = null;

function logDefaultsTransition(result: MainSessionDefaultsResult): void {
  if (result.ok) {
    if (loggedUnavailable !== null) console.info('[default-model] main: usable again');
    loggedUnavailable = null;
    return;
  }
  if (result.error === loggedUnavailable) return;
  loggedUnavailable = result.error;
  console.warn(`[default-model] main: ${result.error}`);
}

/** Main 建会话（秘书派活）的默认值：与 renderer 的 newConversation 同口径 */
export function mainSessionDefaultsFor(
  projectId: string,
  authenticatedAccountKeys: ReadonlySet<string>,
  model?: DefaultModelRef
): MainSessionDefaultsResult {
  const state = readSettingsState() ?? {};
  const projects = Array.isArray(state.projects) ? state.projects : [];
  const groups = Array.isArray(state.projectGroups) ? state.projectGroups : [];
  const presets = Array.isArray(state.presets) ? state.presets : [];
  const thinkingLevel = THINKING_LEVELS.find((level) => level === state.defaultThinkingLevel);
  const lastApprovalMode = APPROVAL_MODES.find((mode) => mode === state.lastApprovalMode);
  const result = mainSessionDefaults({
    project: projects.map(scopedSource).find((entry) => entry.id === projectId) ?? null,
    groups: groups
      .map(scopedSource)
      .flatMap((entry) => (entry.id ? [{ ...entry, id: entry.id }] : [])),
    defaultModel: asModelRef(state.defaultModel),
    ...(typeof state.defaultReasoningEnabled === 'boolean'
      ? { defaultReasoningEnabled: state.defaultReasoningEnabled }
      : {}),
    ...(thinkingLevel ? { defaultThinkingLevel: thinkingLevel } : {}),
    providers: providersFromSettings(),
    credentials: {
      oauthCredentials: { status: 'ready', authenticatedAccountKeys },
    },
    virtualModels: virtualModelsFromSettings(),
    approvalReviewer: asModelRef(state.approvalReviewer),
    lastApprovalMode: lastApprovalMode ?? null,
    defaultPresetId: typeof state.defaultPresetId === 'string' ? state.defaultPresetId : 'default',
    presets: presets
      .map((preset) => record(preset))
      .flatMap((preset) => (typeof preset?.id === 'string' ? [{ id: preset.id }] : [])),
    ...(model ? { model } : {}),
  });
  logDefaultsTransition(result);
  return result;
}
