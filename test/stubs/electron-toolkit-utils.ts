/**
 * `@electron-toolkit/utils` 桩。真包顶层 require('electron')，绕开 vitest 的 electron alias，
 * 在 node 下会把 electron 当成 CJS 路径字符串而炸掉所有间接 import 它的主进程模块。
 */
export const is = { dev: false };
export const electronApp = { setAppUserModelId: () => {} };
export const optimizer = { watchWindowShortcuts: () => {} };
