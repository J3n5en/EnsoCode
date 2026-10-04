import { eligibleOauthPoolAccountKeys, isOauthAccountPool } from './oauthAccountPool';
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

export type ChatModelResolution =
  | (DefaultModelRef & {
      source: ChatModelSource;
      invalidDefault: boolean;
    })
  | (NoChatModelBase & ({ reason: 'no-usable-model' } | OauthCredentialBlock));

export interface DefaultModelNotice {
  previous: DefaultModelRef;
  next: DefaultModelRef | null;
}

export interface DefaultModelState {
  defaultModel: DefaultModelRef | null;
  providers: readonly ModelProvider[];
  credentials: ModelCredentialContext;
  virtualModels?: readonly VirtualModelEntry[];
}

export type SanitizeDefaultModelResult =
  | {
      status: 'unchanged';
      defaultModel: DefaultModelRef | null;
      notice: null;
    }
  | ({
      status: 'deferred-oauth-unavailable';
      defaultModel: DefaultModelRef;
      notice: null;
    } & OauthCredentialBlock)
  | {
      status: 'sanitized';
      defaultModel: DefaultModelRef | null;
      notice: DefaultModelNotice;
    };

const isOauthUnknown = (value: ModelUsability): value is OauthCredentialUnavailableReason =>
  value === 'oauth-credentials-unloaded' ||
  value === 'oauth-credentials-loading' ||
  value === 'oauth-credentials-error';

function oauthCredentialBlock(credentials: ModelCredentialContext): OauthCredentialBlock | null {
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
  const model = provider.models.find((entry) => entry.id === selection.modelId);
  if (!model) return 'model-missing';
  if (model.enabled === false) return 'model-disabled';
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

/** 新会话缺省审批档：优先上次档；assistant 仅在代审模型可用时保留，否则 full。 */
export function defaultApprovalMode(
  reviewer: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext,
  lastMode?: ApprovalMode | null
): ApprovalMode {
  const reviewerUsable = isUsableModel(reviewer, providers, credentials);
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
  return {
    providerId: null,
    modelId: null,
    source: 'none',
    invalidDefault,
    ...(blocked ?? { reason: 'no-usable-model' as const }),
  };
}

/** 确定可用候选优先；只有没有可用项且确有 OAuth 未知候选时才 defer。 */
export function sanitizeDefaultModel(state: DefaultModelState): SanitizeDefaultModelResult {
  if (!state.defaultModel) {
    return { status: 'unchanged', defaultModel: null, notice: null };
  }
  const currentUsability = modelUsability(
    state.defaultModel,
    state.providers,
    state.credentials,
    state.virtualModels
  );
  if (currentUsability === 'usable') {
    return { status: 'unchanged', defaultModel: state.defaultModel, notice: null };
  }
  if (isOauthUnknown(currentUsability)) {
    const blocked = oauthCredentialBlock(state.credentials);
    if (blocked) {
      return {
        status: 'deferred-oauth-unavailable',
        defaultModel: state.defaultModel,
        notice: null,
        ...blocked,
      };
    }
  }

  let unknownCandidate: OauthCredentialBlock | null = null;
  for (const provider of state.providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      if (model.enabled === false) continue;
      const candidate = { providerId: provider.id, modelId: model.id };
      const usability = modelUsability(candidate, state.providers, state.credentials);
      if (usability === 'usable') {
        return {
          status: 'sanitized',
          defaultModel: candidate,
          notice: { previous: state.defaultModel, next: candidate },
        };
      }
      if (!unknownCandidate && isOauthUnknown(usability)) {
        unknownCandidate = oauthCredentialBlock(state.credentials);
      }
    }
  }
  if (unknownCandidate) {
    return {
      status: 'deferred-oauth-unavailable',
      defaultModel: state.defaultModel,
      notice: null,
      ...unknownCandidate,
    };
  }
  return {
    status: 'sanitized',
    defaultModel: null,
    notice: { previous: state.defaultModel, next: null },
  };
}
