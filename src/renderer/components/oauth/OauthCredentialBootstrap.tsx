import * as React from 'react';
import {
  beginOauthCredentialRefresh,
  type OauthCredentialSnapshot,
  setOauthCredentialState,
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
    return window.electronAPI.providers.onOauthCredentialsChanged(() => {
      void refreshOauthCredentialState();
    });
  }, []);

  return null;
}
