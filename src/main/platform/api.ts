/**
 * 宿主平台门面：核心只从 `@platform` 取进程级能力，禁止直接 import 'electron'。
 * tsc 解析到这里做类型约束；构建时按宿主替换为具体实现：
 * 桌面 `src/main/desktop/platform.ts`、服务器 `src/server/platform.ts`、测试 `test/stubs/platform.ts`。
 */
import type {
  PlatformApp,
  PlatformClipboard,
  PlatformImages,
  PlatformIpcMain,
  PlatformNet,
  PlatformNotification,
  PlatformPowerMonitor,
  PlatformPowerSaveBlocker,
  PlatformSafeStorage,
  PlatformSessions,
  PlatformShell,
  PlatformUtilityProcess,
  ProcessMetric,
} from './types';

export type * from './types';

export declare const hostKind: 'desktop' | 'server';
export declare const app: PlatformApp;
export declare const ipcMain: PlatformIpcMain;
export declare const shell: PlatformShell;
export declare const safeStorage: PlatformSafeStorage;
export declare const powerMonitor: PlatformPowerMonitor;
export declare const powerSaveBlocker: PlatformPowerSaveBlocker;
export declare const net: PlatformNet;
export declare const session: PlatformSessions;
export declare const utilityProcess: PlatformUtilityProcess;
export declare const clipboard: PlatformClipboard;
export declare const images: PlatformImages;
export declare const notification: PlatformNotification;
/** agent worker 入口脚本的绝对路径 */
export declare const agentWorkerPath: string;
export declare const memoryWorkerPath: string;
/** 插件宿主进程入口脚本的绝对路径 */
export declare const pluginHostPath: string;
/** 打包资源目录（rtk 等随包二进制） */
export declare const resourcesPath: string;
/** 主进程自身的进程指标；服务器上只有 Node 进程 */
export declare function processMetrics(): ProcessMetric[];
