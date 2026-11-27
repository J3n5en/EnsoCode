import type {
  DefaultModelRef,
  DeterministicModelUnavailability,
  UnavailableDefaultModel,
} from '@shared/defaultModel';
import type { ModelProvider } from '@shared/types';
import { findVirtualModel, isVirtualRef, type VirtualModelEntry } from '@shared/virtualModels';
import type { TFunction } from '@/i18n';

/** 不可用原因的可读说明；逐条写 t() 字面量，便于词条检查 */
export function unavailableReasonText(
  reason: DeterministicModelUnavailability,
  t: TFunction
): string {
  switch (reason) {
    case 'missing-selection':
      return t('no model is selected');
    case 'provider-missing':
      return t('its provider no longer exists');
    case 'provider-disabled':
      return t('its provider is disabled');
    case 'classifier-only':
      return t('its provider only serves approval classifiers');
    case 'model-missing':
      return t("the model is not in its provider's model list");
    case 'model-disabled':
      return t('the model is disabled');
    case 'api-key-missing':
      return t('its provider has no API key');
    case 'oauth-account-missing':
      return t('its subscription account is not signed in');
  }
}

/** 「服务商名 / 模型名」；虚拟模型用虚拟模型名，找不到时退回原始 id */
export function modelSelectionLabel(
  selection: DefaultModelRef,
  providers: readonly ModelProvider[],
  virtualModels?: readonly VirtualModelEntry[]
): string {
  if (isVirtualRef(selection)) {
    const entry = virtualModels ? findVirtualModel(virtualModels, selection) : undefined;
    return entry?.name ?? selection.modelId;
  }
  const provider = providers.find((entry) => entry.id === selection.providerId);
  const model = provider?.models.find((entry) => entry.id === selection.modelId);
  return `${provider?.name ?? selection.providerId} / ${model?.label ?? selection.modelId}`;
}

function scopeLabel(source: UnavailableDefaultModel['source'], t: TFunction): string {
  switch (source) {
    case 'default':
      return t('Default model');
    case 'project':
      return t('Project default model');
    case 'group':
      return t('Group default model');
  }
}

/** 新会话因默认模型不可用而无法开始：点名模型与原因，明说不会改用其他模型 */
export function unusableDefaultMessage(
  unavailable: UnavailableDefaultModel,
  providers: readonly ModelProvider[],
  virtualModels: readonly VirtualModelEntry[] | undefined,
  t: TFunction
): string {
  return t(
    '{{scope}} "{{model}}" is unavailable: {{reason}}. No other model will be used. Fix it in Settings or choose a model for this conversation.',
    {
      scope: scopeLabel(unavailable.source, t),
      model: modelSelectionLabel(unavailable.model, providers, virtualModels),
      reason: unavailableReasonText(unavailable.reason, t),
    }
  );
}
