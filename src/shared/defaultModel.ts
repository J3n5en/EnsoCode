import type { ModelProvider } from './types';

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

export type ChatModelResolution =
  | (DefaultModelRef & {
      source: 'session' | 'default';
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

/** 返回可用、确定失效或 OAuth 未知；不把不同原因压成 unavailable。 */
export function modelUsability(
  selection: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext
): ModelUsability {
  if (!selection) return 'missing-selection';
  const provider = providers.find((entry) => entry.id === selection.providerId);
  if (!provider) return 'provider-missing';
  if (!provider.enabled) return 'provider-disabled';
  const model = provider.models.find((entry) => entry.id === selection.modelId);
  if (!model) return 'model-missing';
  if (model.enabled === false) return 'model-disabled';
  if (!provider.oauthAccountKey) return provider.apiKey ? 'usable' : 'api-key-missing';
  if (credentials.oauthCredentials.status !== 'ready') {
    return oauthCredentialBlock(credentials)?.reason ?? 'oauth-credentials-error';
  }
  return credentials.oauthCredentials.authenticatedAccountKeys.has(provider.oauthAccountKey)
    ? 'usable'
    : 'oauth-account-missing';
}

export function isUsableModel(
  selection: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext
): selection is DefaultModelRef {
  return modelUsability(selection, providers, credentials) === 'usable';
}

/** 新会话缺省审批档：代审模型可用则 assistant，否则 full。 */
export function defaultApprovalMode(
  reviewer: DefaultModelRef | null,
  providers: readonly ModelProvider[],
  credentials: ModelCredentialContext
): 'assistant' | 'full' {
  return isUsableModel(reviewer, providers, credentials) ? 'assistant' : 'full';
}

export function resolveChatModel(input: {
  defaultModel: DefaultModelRef | null;
  lastProviderId?: string;
  lastModelId?: string;
  providers: readonly ModelProvider[];
  credentials: ModelCredentialContext;
}): ChatModelResolution {
  const defaultUsability = modelUsability(input.defaultModel, input.providers, input.credentials);
  const invalidDefault =
    input.defaultModel !== null &&
    defaultUsability !== 'usable' &&
    !isOauthUnknown(defaultUsability);
  const sessionModel =
    input.lastProviderId && input.lastModelId
      ? { providerId: input.lastProviderId, modelId: input.lastModelId }
      : null;
  const sessionUsability = modelUsability(sessionModel, input.providers, input.credentials);

  if (sessionUsability === 'usable' && sessionModel) {
    return { ...sessionModel, source: 'session', invalidDefault };
  }
  if (isOauthUnknown(sessionUsability)) {
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
  if (defaultUsability === 'usable' && input.defaultModel) {
    return { ...input.defaultModel, source: 'default', invalidDefault: false };
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
  const currentUsability = modelUsability(state.defaultModel, state.providers, state.credentials);
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
