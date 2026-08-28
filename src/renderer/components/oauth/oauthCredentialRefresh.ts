import type { OauthCredentialSnapshot } from '@/stores/oauthCredentials';

export interface OauthCredentialRefreshDependencies {
  begin: () => number;
  listKeys: () => Promise<string[]>;
  commit: (snapshot: OauthCredentialSnapshot) => boolean;
  revalidateDefaultModel: (snapshot: OauthCredentialSnapshot) => unknown;
}

/**
 * auth.json 真值刷新：只有最新 revision 的 ready 快照可触发默认模型重验证。
 * error 只提交 fail-closed 状态，绝不据此写回默认模型。
 */
export async function runOauthCredentialRefresh(
  dependencies: OauthCredentialRefreshDependencies
): Promise<OauthCredentialSnapshot> {
  const revision = dependencies.begin();
  try {
    const keys = await dependencies.listKeys();
    const authenticatedAccountKeys = new Set(keys);
    const snapshot: OauthCredentialSnapshot = {
      revision,
      availability: { status: 'ready', authenticatedAccountKeys },
    };
    if (dependencies.commit(snapshot)) dependencies.revalidateDefaultModel(snapshot);
    return snapshot;
  } catch (error) {
    const snapshot: OauthCredentialSnapshot = {
      revision,
      availability: {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      },
    };
    dependencies.commit(snapshot);
    return snapshot;
  }
}
