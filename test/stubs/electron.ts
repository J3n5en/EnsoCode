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

export const safeStorage = {
  isEncryptionAvailable: () => false,
  encryptString: (s: string) => Buffer.from(s, 'utf-8'),
  decryptString: (b: Buffer) => b.toString('utf-8'),
};

export const shell = { openExternal: () => {} };
/** 默认转给 global fetch，便于现有 vi.stubGlobal('fetch') 用例继续工作。 */
export const net = {
  fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
    globalThis.fetch(input, init)) as typeof fetch,
};
export class WebContentsView {}
export const session = {
  fromPartition: () => ({}),
  defaultSession: {
    setProxy: async () => {},
    resolveProxy: async () => 'DIRECT',
  },
};
export const Menu = { buildFromTemplate: () => ({ popup: () => {} }) };
export const screen = {
  on: () => {},
  removeListener: () => {},
};
export const powerMonitor = { on: () => {} };
export const powerSaveBlocker = { start: () => 0, stop: () => {} };

export default {
  app,
  ipcMain,
  BrowserWindow,
  safeStorage,
  shell,
  net,
  WebContentsView,
  session,
  Menu,
  screen,
  powerMonitor,
  powerSaveBlocker,
};
