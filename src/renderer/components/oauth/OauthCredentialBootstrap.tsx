import * as React from 'react';
import { bootstrapAgyModels } from '@/stores/agyAuth';
import { bootstrapModelDirectory, useModelDirectoryStore } from '@/stores/modelDirectory';
import {
  beginOauthCredentialRefresh,
  type OauthCredentialSnapshot,
  setOauthCredentialState,
  useOauthCredentialStore,
} from '@/stores/oauthCredentials';
import { useSettingsStore } from '@/stores/settings';
import { runOauthCredentialRefresh } from './oauthCredentialRefresh';

/** 所有登录完成、退登成功与 Main 失效通知共用的唯一 Renderer refresh。 */
export function refreshOauthCredentialState(): Promise<OauthCredentialSnapshot> {
  return runOauthCredentialRefresh({
    begin: beginOauthCredentialRefresh,
    listKeys: () => window.electronAPI.providers.listOauthCredentialKeys(),
    commit: setOauthCredentialState,
    revalidateDefaultModel: (snapshot) =>
      useSettingsStore.getState().revalidateDefaultModel(snapshot),
  });
}

/** 每个 renderer root 挂一次：启动即取真值，随后响应 Main 的跨窗口凭证失效通知。 */
export function OauthCredentialBootstrap() {
  React.useEffect(() => {
    void refreshOauthCredentialState();
    bootstrapModelDirectory();
    // agy 模型只读 Main 缓存，不探测
    bootstrapAgyModels();
    // 目录冷启动期间默认模型重验会 defer（不写回）；分区到达后补一次重验闭环
    let lastRevision = useModelDirectoryStore.getState().snapshot?.revision;
    const unsubscribeDirectory = useModelDirectoryStore.subscribe((state) => {
      const revision = state.snapshot?.revision;
      if (revision === undefined || revision === lastRevision) return;
      lastRevision = revision;
      useSettingsStore
        .getState()
        .revalidateDefaultModel(useOauthCredentialStore.getState().snapshot);
    });
    const unsubscribeCredentials = window.electronAPI.providers.onOauthCredentialsChanged(() => {
      void refreshOauthCredentialState();
    });
    return () => {
      unsubscribeDirectory();
      unsubscribeCredentials();
    };
  }, []);

  return null;
}
