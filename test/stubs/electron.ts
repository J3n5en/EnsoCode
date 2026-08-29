/**
 * 测试用 electron 桩。
 * 主进程模块顶层会 `import { app } from 'electron'`，在 node 环境下无法解析真实包，
 * 这里提供最小实现，让纯函数可以被单独导入测试。
 */
export const app = {
  getPath: (name: string) => `/tmp/enso-code-test/${name}`,
  getName: () => 'enso-code',
  on: () => {},
};

export const ipcMain = {
  handle: () => {},
  on: () => {},
};

export const BrowserWindow = {
  getAllWindows: () => [],
};

export const shell = { openExternal: () => {} };
export const Menu = { buildFromTemplate: () => ({ popup: () => {} }) };
export const powerMonitor = { on: () => {} };

export default { app, ipcMain, BrowserWindow, shell, Menu, powerMonitor };
