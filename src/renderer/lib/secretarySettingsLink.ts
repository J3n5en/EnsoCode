/** 设置页正在编辑的秘书：设置窗口与主窗口同源，靠它（和 storage 事件）对上同一个秘书 */
export const SETTINGS_SECRETARY_KEY = 'enso-settings-secretary';

/** 打开设置 → 秘书，并让设置页切到这个秘书；不指定时沿用设置页上次选的 */
export function openSecretarySettings(secretaryId?: string): void {
  if (secretaryId) {
    try {
      localStorage.setItem(SETTINGS_SECRETARY_KEY, secretaryId);
    } catch {
      // 存不下时设置页停在上次选的秘书，页面里还能手动切
    }
  }
  void window.electronAPI.window.openSettings({ category: 'secretary', rowId: 'secretary.root' });
}
