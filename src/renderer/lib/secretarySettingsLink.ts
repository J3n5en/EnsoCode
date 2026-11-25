import type { SettingsDeepLink } from '@shared/settingsDeepLink';
import { openSettings } from '@/stores/appView';

/** 设置页正在编辑的秘书：打开设置前写入，设置页靠它（和 storage 事件）对上同一个秘书 */
export const SETTINGS_SECRETARY_KEY = 'enso-settings-secretary';

/** 打开设置 → 秘书（或秘书组的其他分区），并让设置页切到这个秘书；不指定时沿用设置页上次选的 */
export function openSecretarySettings(
  secretaryId?: string | null,
  link: SettingsDeepLink = { category: 'secretary', rowId: 'secretary.root' }
): void {
  if (secretaryId) {
    try {
      localStorage.setItem(SETTINGS_SECRETARY_KEY, secretaryId);
    } catch {
      // 存不下时设置页停在上次选的秘书，页面里还能手动切
    }
  }
  openSettings(link);
}
