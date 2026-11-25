import { openSettings } from '@/stores/appView';

export type MainSettingsRequestSource = Pick<
  Window['electronAPI']['window'],
  'consumeSettingsDeepLink' | 'onSettingsDeepLink'
>;

/** 主进程转来的「打开设置」（托盘、应用菜单、enso:// 深链）：挂载时取一次，之后每次推送再取 */
export function bindMainSettingsRequests(api: MainSettingsRequestSource): () => void {
  const take = () =>
    void api.consumeSettingsDeepLink().then((request) => {
      if (request) openSettings(request.link);
    });
  take();
  return api.onSettingsDeepLink(take);
}
