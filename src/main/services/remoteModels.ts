import type { DefaultModelRef } from '@shared/defaultModel';
import type { SpawnModelConfig } from '@shared/types/agent';
import { resolveModelSelection } from './agentHost';
import { readStoredOauthCredentialKeys } from './oauthProviders';
import { titleModelCandidates } from './titleSummary';

/** 功能单独选的远程模型排最前，其后是标题模型的回退链 */
export async function remoteCandidates(
  state: Record<string, unknown>,
  preferred: unknown
): Promise<SpawnModelConfig[]> {
  const chain = [
    ...(preferred && typeof preferred === 'object'
      ? [preferred as { providerId: string; modelId: string }]
      : []),
    ...titleModelCandidates(state),
  ];
  return resolveRemoteModels(chain);
}

/** 按顺序解析成可用的模型配置，凭据缺失或模型不存在的跳过 */
export async function resolveRemoteModels(
  chain: readonly DefaultModelRef[]
): Promise<SpawnModelConfig[]> {
  const credentialKeys = await readStoredOauthCredentialKeys();
  const candidates: SpawnModelConfig[] = [];
  for (const candidate of chain) {
    const resolved = resolveModelSelection(candidate.providerId, candidate.modelId, credentialKeys);
    if (resolved.ok && resolved.selection) candidates.push(resolved.selection.config);
  }
  return candidates;
}
