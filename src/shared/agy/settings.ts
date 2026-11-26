import type { ModelProvider } from '../types/llm';
import { AGY_DEFAULT_MODEL_ID, AGY_PROVIDER_ID, AGY_PROVIDER_NAME } from './constants';
import type { AgyModelOption, AgySettings } from './types';

export function parseAgySettings(value: unknown): AgySettings {
  const row =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as { binaryPath?: unknown; skipPermissions?: unknown })
      : undefined;
  return {
    binaryPath: typeof row?.binaryPath === 'string' ? row.binaryPath : '',
    skipPermissions: row?.skipPermissions === true,
  };
}

export function agySettingsProvider(models: readonly AgyModelOption[]): ModelProvider {
  const list = models.length > 0 ? models : [{ id: AGY_DEFAULT_MODEL_ID, name: AGY_PROVIDER_NAME }];
  return {
    id: AGY_PROVIDER_ID,
    name: AGY_PROVIDER_NAME,
    api: 'openai-completions',
    apiKey: '',
    baseUrl: '',
    enabled: true,
    models: list.map((model) => ({ id: model.id, label: model.name })),
  };
}

/** 只能在会话里经 agy bridge 跑的 provider：标题、提交信息、代审、压缩这类一次性请求不能用。 */
export function isSessionOnlyProvider(provider: { id?: string }): boolean {
  return provider.id === AGY_PROVIDER_ID;
}
