/**
 * 测试解析 `@platform` 到这里：进程级能力透传 electron 桩（vi.mock('electron') 仍然生效），
 * 平台新增的能力给测试默认值。
 */
export {
  app,
  clipboard,
  ipcMain,
  net,
  powerMonitor,
  powerSaveBlocker,
  safeStorage,
  session,
  shell,
  utilityProcess,
} from 'electron';

export const hostKind = 'desktop' as const;
export const agentWorkerPath = '/tmp/agent.js';
export const pluginHostPath = '/tmp/plugin-host.js';
export const resourcesPath = '/tmp/resources';

export const images = { fromBuffer: () => null };

export const notification = {
  isSupported: () => false,
  show: () => null,
};

export function processMetrics(): never[] {
  return [];
}
