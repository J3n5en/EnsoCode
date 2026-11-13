import { app } from '@platform';
import { applyProxySettings } from '../../ipc/proxy';
import {
  patchSettingsState,
  readSettingsState,
  reloadSettingsFromDisk,
  SETTINGS_STATE_FIELDS,
} from '../../ipc/settings';
import { type ConfigCliHandle, startConfigCli } from './server';

let handle: ConfigCliHandle | null = null;

/** 写入走与 UI 相同的 Main 设置入口：更新内存副本、广播 renderer、推送 agent worker、防抖落盘 */
export async function startDesktopConfigCli(): Promise<void> {
  try {
    handle = await startConfigCli(app.getPath('userData'), {
      fields: SETTINGS_STATE_FIELDS,
      readState: readSettingsState,
      patch: (field, value) => patchSettingsState(field, value, undefined, 'all-renderers'),
      reload: reloadSettingsFromDisk,
      applyProxy: (mode, customUrl) => applyProxySettings({ mode, customUrl }),
    });
  } catch (error) {
    console.warn('[config-cli] listen failed', error);
  }
}

export function stopDesktopConfigCli(): void {
  handle?.close();
  handle = null;
}
