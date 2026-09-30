import { createHash } from 'node:crypto';
import type { SpawnModelConfig } from '@shared/types/agent';
import { createCodexCompactFactory } from './codexCompact';
import {
  createEnsoCompactFactory,
  ensoCompactInlineExtension as defaultEnsoCompactInlineExtension,
} from './ensoCompact/extension';

/** provider 注册 id：掺 api/baseUrl/apiKey 指纹。不含斜杠，扩展才能按 provider/id 解析。 */
export function providerKeyFor(model: { api: string; baseUrl: string; apiKey: string }): string {
  const keyFp = createHash('sha256').update(model.apiKey).digest('hex').slice(0, 8);
  const host = createHash('sha256')
    .update(`${model.api}\0${model.baseUrl}`)
    .digest('hex')
    .slice(0, 12);
  return `enso-${host}-${keyFp}`;
}

export function formatSmartCompactSummaryModel(model: SpawnModelConfig): string {
  const provider = model.oauthAccountKey ?? providerKeyFor(model);
  return `${provider}/${model.modelId}`;
}

export function parseSmartCompactSummaryRef(
  formatted: string | undefined
): { provider: string; id: string } | undefined {
  if (!formatted) return undefined;
  const slash = formatted.indexOf('/');
  if (slash <= 0 || slash === formatted.length - 1) return undefined;
  return { provider: formatted.slice(0, slash), id: formatted.slice(slash + 1) };
}

export function smartCompactInlineExtension(
  route?: {
    summaryModel?: SpawnModelConfig | null;
    mode?: 'auto' | 'fast' | 'balanced' | 'thorough';
  },
  codexNative = false
) {
  if (!route && !codexNative) return defaultEnsoCompactInlineExtension;
  const options = {
    mode: route?.mode,
    summaryModel: route?.summaryModel
      ? parseSmartCompactSummaryRef(formatSmartCompactSummaryModel(route.summaryModel))
      : undefined,
  };
  return {
    name: codexNative ? 'enso-codex-compact' : 'enso-compact',
    hidden: true as const,
    factory: codexNative ? createCodexCompactFactory(options) : createEnsoCompactFactory(options),
  };
}
