import { eligibleOauthPoolAccountKeys, isOauthAccountPool } from './oauthAccountPool';
import { isClassifierOnlyProvider } from './providerCatalog';
import type { ModelProvider } from './types';
import type { ApprovalMode, ThinkingLevel } from './types/agent';
import { findVirtualModel, isVirtualRef, type VirtualModelEntry } from './virtualModels';

export interface DefaultModelRef {
  providerId: string;
  modelId: string;
}

export type OauthCredentialAvailability =
  | { status: 'unloaded' }
  | { status: 'loading' }
  | { status: 'error'; error: string }
  | { status: 'ready'; authenticatedAccountKeys: ReadonlySet<string> };

export interface ModelCredentialContext {
  oauthCredentials: OauthCredentialAvailability;
}

export type OauthCredentialUnavailableReason =
  | 'oauth-credentials-unloaded'
  | 'oauth-credentials-loading'
  | 'oauth-credentials-error';

export interface OauthCredentialBlock {
  reason: OauthCredentialUnavailableReason;
  suggestedAction:
    | 'load-oauth-credentials'
    | 'wait-for-oauth-credentials'
    | 'retry-oauth-credentials';
  credentialError?: string;
}

export type DeterministicModelUnavailability =
  | 'missing-selection'
  | 'provider-missing'
  | 'provider-disabled'
  | 'classifier-only'
  | 'model-missing'
  | 'model-disabled'
  | 'api-key-missing'
  | 'oauth-account-missing';

export type ModelUsability =
  | 'usable'
  | DeterministicModelUnavailability
  | OauthCredentialUnavailableReason;

interface NoChatModelBase {
  providerId: null;
  modelId: null;
  source: 'none';
  invalidDefault: boolean;
}

export type ChatModelSource = 'session' | 'project' | 'group' | 'default';

/** 已配置但确定不可用的默认模型（项目 / 分组 / 全局），供报错点名模型与原因 */
export interface UnavailableDefaultModel {
  source: Exclude<ChatModelSource, 'session'>;
  model: DefaultModelRef;
  reason: DeterministicModelUnavailability;
}

export type ChatModelResolution =
  | (DefaultModelRef & {
      source: ChatModelSource;
      invalidDefault: boolean;
    })
  | (NoChatModelBase &
      (
        | { reason: 'no-usable-model'; unavailableDefault?: UnavailableDefaultModel }
        | OauthCredentialBlock
      ));

export interface DefaultModelState {
  defaultModel: DefaultModelRef | null;
  providers: readonly ModelProvider[];
  credentials: ModelCredentialContext;
  virtualModels?: readonly VirtualModelEntry[];
}

/** 默认模型体检结果：只描述状态，从不给出替换模型 */
export type DefaultModelAssessment =
  | {
      status: 'unchanged';
      defaultModel: DefaultModelRef | null;
    }
  | ({
      status: 'deferred-oauth-unavailable';
      defaultModel: DefaultModelRef;
    } & OauthCredentialBlock)
  | {
      status: 'unavailable';
      defaultModel: DefaultModelRef;
      reason: DeterministicModelUnavailability;
    };

const isOauthUnknown = (value: ModelUsability): value is OauthCredentialUnavailableReason =>
  value === 'oauth-credentials-unloaded' ||
  value === 'oauth-credentials-loading' ||
  value === 'oauth-credentials-error';

const deterministicUnavailability = (
  value: ModelUsability
): DeterministicModelUnavailability | null =>
  value === 'usable' || isOauthUnknown(value) ? null : value;

export function oauthCredentialBlock(
  credentials: ModelCredentialContext
): OauthCredentialBlock | null {
  switch (credentials.oauthCredentials.status) {
    case 'unloaded':
      return {
        reason: 'oauth-credentials-unloaded',
        suggestedAction: 'load-oauth-credentials',
      };
    case 'loading':
      return {
        reason: 'oauth-credentials-loading',
        suggestedAction: 'wait-for-oauth-credentials',
      };
    case 'error':
      return {
        reason: 'oauth-credentials-error',
        suggestedAction: 'retry-oauth-credentials',
        credentialError: credentials.oauthCredentials.error,
      };
    case 'ready':
      return null;
  }
}

/**
 * 返回可用、确定失效或 OAuth 未知；不把不同原因压成 unavailable。
 * 虚拟模型按主模型判定；不传 virtualModels 的调用方（不接受虚拟模型的场景）视为 provider 缺失。
 */
export function modelUsability(
  selection: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext,
  virtualModels?: readonly VirtualModelEntry[]
): ModelUsability {
  if (!selection) return 'missing-selection';
  if (isVirtualRef(selection)) {
    if (!virtualModels) return 'provider-missing';
    const entry = findVirtualModel(virtualModels, selection);
    if (!entry) return 'model-missing';
    if (!entry.enabled) return 'model-disabled';
    return modelUsability(entry.primary, providers, credentials);
  }
  const provider = providers.find((entry) => entry.id === selection.providerId);
  if (!provider) return 'provider-missing';
  if (!provider.enabled) return 'provider-disabled';
  if (isClassifierOnlyProvider(provider)) return 'classifier-only';
  const model = provider.models.find((entry) => entry.id === selection.modelId);
  if (!model) return 'model-missing';
  if (model.enabled === false) return 'model-disabled';
  if (provider.id === AGY_PROVIDER_ID) return 'usable';
  if (provider.oauthAccountPool !== undefined && !isOauthAccountPool(provider))
    return 'oauth-account-missing';
  if (!provider.oauthAccountKey) return provider.apiKey ? 'usable' : 'api-key-missing';
  if (credentials.oauthCredentials.status !== 'ready') {
    return oauthCredentialBlock(credentials)?.reason ?? 'oauth-credentials-error';
  }
  if (isOauthAccountPool(provider)) {
    return eligibleOauthPoolAccountKeys(
      provider,
      selection.modelId,
      providers,
      credentials.oauthCredentials.authenticatedAccountKeys
    ).length > 0
      ? 'usable'
      : 'oauth-account-missing';
  }
  return credentials.oauthCredentials.authenticatedAccountKeys.has(provider.oauthAccountKey)
    ? 'usable'
    : 'oauth-account-missing';
}

export function isUsableModel(
  selection: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext,
  virtualModels?: readonly VirtualModelEntry[]
): selection is DefaultModelRef {
  return modelUsability(selection, providers, credentials, virtualModels) === 'usable';
}

/** 分类器专用供应商（如 Jev）作代审来源：需启用、有 apiKey、模型在清单内且未禁用 */
export function isUsableApprovalClassifier(
  selection: DefaultModelRef | null,
  providers: readonly ModelProvider[]
): boolean {
  if (!selection) return false;
  const provider = providers.find((entry) => entry.id === selection.providerId);
  if (!provider?.enabled || !isClassifierOnlyProvider(provider)) return false;
  if (!provider.apiKey || provider.oauthAccountKey) return false;
  const model = provider.models.find((entry) => entry.id === selection.modelId);
  return Boolean(model && model.enabled !== false);
}

/** 代审模型可用：聊天模型或分类器专用供应商的分类器 */
export function isUsableApprovalReviewer(
  reviewer: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext
): boolean {
  return (
    isUsableModel(reviewer, providers, credentials) ||
    isUsableApprovalClassifier(reviewer, providers)
  );
}

/** 新会话缺省审批档：优先上次档；assistant 仅在代审模型可用时保留，否则 full。 */
export function defaultApprovalMode(
  reviewer: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext,
  lastMode?: ApprovalMode | null
): ApprovalMode {
  const reviewerUsable = isUsableApprovalReviewer(reviewer, providers, credentials);
  if (lastMode === 'assistant') return reviewerUsable ? 'assistant' : 'full';
  if (lastMode === 'supervised' || lastMode === 'auto-edits' || lastMode === 'full') {
    return lastMode;
  }
  return reviewerUsable ? 'assistant' : 'full';
}

type ScopedReasoningSource = {
  defaultModel?: DefaultModelRef | null;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
};

export function scopedDefaultModels(
  project: (ScopedReasoningSource & { groupId?: string }) | null | undefined,
  groups: readonly (ScopedReasoningSource & { id: string })[]
): {
  projectDefaultModel: DefaultModelRef | null;
  groupDefaultModel: DefaultModelRef | null;
  projectReasoningEnabled?: boolean;
  projectThinkingLevel?: ThinkingLevel;
  groupReasoningEnabled?: boolean;
  groupThinkingLevel?: ThinkingLevel;
} {
  const group = project?.groupId ? groups.find((entry) => entry.id === project.groupId) : undefined;
  return {
    projectDefaultModel: project?.defaultModel ?? null,
    groupDefaultModel: group?.defaultModel ?? null,
    projectReasoningEnabled: project?.defaultReasoningEnabled,
    projectThinkingLevel: project?.defaultThinkingLevel,
    groupReasoningEnabled: group?.defaultReasoningEnabled,
    groupThinkingLevel: group?.defaultThinkingLevel,
  };
}

export function resolveChatReasoning(input: {
  projectReasoningEnabled?: boolean;
  projectThinkingLevel?: ThinkingLevel;
  groupReasoningEnabled?: boolean;
  groupThinkingLevel?: ThinkingLevel;
  defaultReasoningEnabled?: boolean;
  defaultThinkingLevel?: ThinkingLevel;
}): { reasoningEnabled: boolean; thinkingLevel: ThinkingLevel } {
  return {
    reasoningEnabled:
      input.projectReasoningEnabled ??
      input.groupReasoningEnabled ??
      input.defaultReasoningEnabled ??
      true,
    thinkingLevel:
      input.projectThinkingLevel ??
      input.groupThinkingLevel ??
      input.defaultThinkingLevel ??
      'medium',
  };
}

export function resolveChatModel(input: {
  defaultModel: DefaultModelRef | null;
  projectDefaultModel?: DefaultModelRef | null;
  groupDefaultModel?: DefaultModelRef | null;
  lastProviderId?: string;
  lastModelId?: string;
  providers: readonly ModelProvider[];
  credentials: ModelCredentialContext;
  virtualModels?: readonly VirtualModelEntry[];
}): ChatModelResolution {
  const defaultUsability = modelUsability(
    input.defaultModel,
    input.providers,
    input.credentials,
    input.virtualModels
  );
  const invalidDefault =
    input.defaultModel !== null &&
    defaultUsability !== 'usable' &&
    !isOauthUnknown(defaultUsability);
  const sessionModel =
    input.lastProviderId && input.lastModelId
      ? { providerId: input.lastProviderId, modelId: input.lastModelId }
      : null;
  const candidates: Array<{ selection: DefaultModelRef | null; source: ChatModelSource }> = [
    { selection: sessionModel, source: 'session' },
    { selection: input.projectDefaultModel ?? null, source: 'project' },
    { selection: input.groupDefaultModel ?? null, source: 'group' },
    { selection: input.defaultModel, source: 'default' },
  ];

  for (const candidate of candidates) {
    const usability = modelUsability(
      candidate.selection,
      input.providers,
      input.credentials,
      input.virtualModels
    );
    if (usability === 'usable' && candidate.selection) {
      return {
        ...candidate.selection,
        source: candidate.source,
        invalidDefault: candidate.source === 'default' ? false : invalidDefault,
      };
    }
    if (isOauthUnknown(usability)) {
      const blocked = oauthCredentialBlock(input.credentials);
      if (blocked) {
        return {
          providerId: null,
          modelId: null,
          source: 'none',
          invalidDefault,
          ...blocked,
        };
      }
    }
  }

  const blocked = isOauthUnknown(defaultUsability) ? oauthCredentialBlock(input.credentials) : null;
  if (blocked) {
    return {
      providerId: null,
      modelId: null,
      source: 'none',
      invalidDefault,
      ...blocked,
    };
  }
  // 点名第一个「配置了但确定不可用」的默认：用户要知道是哪个模型、为什么，而不是被悄悄换掉
  let unavailableDefault: UnavailableDefaultModel | undefined;
  for (const candidate of candidates) {
    if (candidate.source === 'session' || !candidate.selection) continue;
    const reason = deterministicUnavailability(
      modelUsability(candidate.selection, input.providers, input.credentials, input.virtualModels)
    );
    if (reason) {
      unavailableDefault = { source: candidate.source, model: candidate.selection, reason };
      break;
    }
  }
  return {
    providerId: null,
    modelId: null,
    source: 'none',
    invalidDefault,
    reason: 'no-usable-model',
    ...(unavailableDefault ? { unavailableDefault } : {}),
  };
}

/**
 * 体检全局默认模型：可用 → unchanged；OAuth 未知 → defer；确定不可用 → unavailable 带原因。
 * 从不替换、从不清空：用户选的默认只能由用户改，瞬时误判在数据就绪后自然恢复。
 */
export function assessDefaultModel(state: DefaultModelState): DefaultModelAssessment {
  if (!state.defaultModel) {
    return { status: 'unchanged', defaultModel: null };
  }
  const currentUsability = modelUsability(
    state.defaultModel,
    state.providers,
    state.credentials,
    state.virtualModels
  );
  if (currentUsability === 'usable') {
    return { status: 'unchanged', defaultModel: state.defaultModel };
  }
  const reason = deterministicUnavailability(currentUsability);
  if (reason) return { status: 'unavailable', defaultModel: state.defaultModel, reason };
  const blocked = oauthCredentialBlock(state.credentials) ?? {
    reason: 'oauth-credentials-loading' as const,
    suggestedAction: 'wait-for-oauth-credentials' as const,
  };
  return { status: 'deferred-oauth-unavailable', defaultModel: state.defaultModel, ...blocked };
}

/** 建会话因没有可用模型失败时的错误前缀；Main 侧按前缀识别，不按整串比对 */
export const NO_USABLE_MODEL_ERROR = 'no usable model';

export function isNoUsableModelError(error: string | undefined): boolean {
  return error === NO_USABLE_MODEL_ERROR || Boolean(error?.startsWith(`${NO_USABLE_MODEL_ERROR}:`));
}

const UNAVAILABLE_REASON_TEXT: Record<DeterministicModelUnavailability, string> = {
  'missing-selection': 'no model is selected',
  'provider-missing': 'its provider no longer exists',
  'provider-disabled': 'its provider is disabled',
  'classifier-only': 'its provider only serves approval classifiers',
  'model-missing': "the model is not in its provider's model list",
  'model-disabled': 'the model is disabled',
  'api-key-missing': 'its provider has no API key',
  'oauth-account-missing': 'its subscription account is not signed in',
};

/** 「服务商名 / 模型 id」；虚拟模型用虚拟模型名，找不到时退回原始 id */
export function modelRefLabel(
  ref: DefaultModelRef,
  providers: readonly ModelProvider[],
  virtualModels?: readonly VirtualModelEntry[]
): string {
  if (isVirtualRef(ref)) {
    const entry = virtualModels ? findVirtualModel(virtualModels, ref) : undefined;
    return `${entry?.name ?? ref.modelId} (virtual model)`;
  }
  const provider = providers.find((entry) => entry.id === ref.providerId);
  return `${provider?.name ?? ref.providerId} / ${ref.modelId}`;
}

const SCOPE_TEXT: Record<UnavailableDefaultModel['source'], { name: string; fix: string }> = {
  default: { name: 'the default model', fix: 'Settings → Models → Default model' },
  project: { name: 'the project default model', fix: "the project's settings" },
  group: { name: 'the project group default model', fix: "the project group's settings" },
};

/** 给秘书 / Main 调用方的报错：点名模型与原因，明说没有改用别的模型，并指向设置 */
export function unusableModelError(
  unavailable: UnavailableDefaultModel,
  providers: readonly ModelProvider[],
  virtualModels?: readonly VirtualModelEntry[]
): string {
  const scope = SCOPE_TEXT[unavailable.source];
  const label = modelRefLabel(unavailable.model, providers, virtualModels);
  return `${NO_USABLE_MODEL_ERROR}: ${scope.name} "${label}" is unavailable (${UNAVAILABLE_REASON_TEXT[unavailable.reason]}). No other model was used. Fix or re-pick it in ${scope.fix}.`;
}

import { AGY_PROVIDER_ID } from './agy/constants';
