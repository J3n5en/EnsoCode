import { readSettingsState } from '../../ipc/settings';

/** 实验开关：关闭时秘书 IPC、工具执行与会话 spawn 一律按 disabled 拒绝 */
export function secretaryEnabled(): boolean {
  return readSettingsState()?.secretaryEnabled === true;
}
