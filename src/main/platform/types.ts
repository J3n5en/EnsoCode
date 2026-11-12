import type { EventEmitter } from 'node:events';

/** 主界面 / 设置等 renderer 的最小形状：本地 WebContents 与远端 RemoteSender 都满足 */
export interface RendererContents {
  readonly id: number;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed(): boolean;
  on(event: 'destroyed', listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
}

export interface IpcInvokeEvent {
  readonly sender: RendererContents;
}

export interface IpcEvent {
  readonly sender: RendererContents;
  returnValue: unknown;
}

export type IpcHandler = (event: IpcInvokeEvent, ...args: any[]) => unknown;
export type IpcListener = (event: IpcEvent, ...args: any[]) => void;

export interface PlatformIpcMain {
  handle(channel: string, handler: IpcHandler): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: IpcListener): unknown;
  removeListener(channel: string, listener: IpcListener): unknown;
  off(channel: string, listener: IpcListener): unknown;
  removeAllListeners(channel?: string): unknown;
}

export type PlatformPathName = 'userData' | 'temp' | 'home' | 'appData' | 'logs' | 'downloads';
export type PlatformAppEvent = 'before-quit' | 'will-quit';

export interface WillQuitEvent {
  preventDefault(): void;
}

export interface PlatformApp {
  readonly isPackaged: boolean;
  getPath(name: PlatformPathName): string;
  getAppPath(): string;
  getName(): string;
  getVersion(): string;
  quit(): void;
  setBadgeCount(count: number): boolean;
  getFileIcon(
    filePath: string,
    options: { size: 'small' | 'normal' | 'large' }
  ): Promise<{ isEmpty(): boolean; toDataURL(): string }>;
  on(event: 'before-quit', listener: () => void): unknown;
  on(event: 'will-quit', listener: (event: WillQuitEvent) => void): unknown;
  once(event: 'before-quit', listener: () => void): unknown;
  once(event: 'will-quit', listener: (event: WillQuitEvent) => void): unknown;
  removeListener(event: 'before-quit', listener: () => void): unknown;
  removeListener(event: 'will-quit', listener: (event: WillQuitEvent) => void): unknown;
}

export interface ProcessMetric {
  pid: number;
  type: string;
  name?: string;
  serviceName?: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
}

export interface PlatformShell {
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<string>;
  showItemInFolder(path: string): void;
}

export interface PlatformSafeStorage {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(plainText: string): Promise<Buffer>;
  decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export interface PlatformPowerMonitor {
  on(event: 'resume', listener: () => void): unknown;
}

export interface PlatformPowerSaveBlocker {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
}

export interface PlatformNet {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Chromium 会话的最小子集；服务器没有浏览器会话，给空实现 */
export interface PlatformSession {
  setProxy(config: {
    mode?: 'direct' | 'system' | 'auto_detect' | 'fixed_servers' | 'pac_script';
    proxyRules?: string;
  }): Promise<void>;
  resolveProxy(url: string): Promise<string>;
  clearCache(): Promise<void>;
  clearCodeCaches(options: { urls?: string[] }): Promise<void>;
  clearStorageData(): Promise<void>;
}

export interface PlatformSessions {
  readonly defaultSession: PlatformSession;
  fromPartition(partition: string): PlatformSession;
}

export interface WorkerForkOptions {
  serviceName: string;
  env: NodeJS.ProcessEnv;
  /** 'pipe' 时桌面端暴露 stdout/stderr；服务器版忽略 */
  stdio?: 'pipe';
}

/** utilityProcess 子集：'spawn' 后 postMessage 才保证送达 */
export interface WorkerProcess extends EventEmitter {
  readonly pid: number | undefined;
  readonly stdout?: NodeJS.ReadableStream | null;
  readonly stderr?: NodeJS.ReadableStream | null;
  postMessage(message: unknown): void;
  kill(): boolean;
}

export interface PlatformUtilityProcess {
  fork(modulePath: string, args: string[], options: WorkerForkOptions): WorkerProcess;
}

export interface PlatformClipboard {
  writeText(text: string): Promise<void>;
  writeBuffer(format: string, buffer: Buffer): Promise<void>;
}

export interface DecodedImage {
  getSize(): { width: number; height: number };
  resize(options: {
    width: number;
    height: number;
    quality?: 'good' | 'better' | 'best';
  }): DecodedImage;
  toJPEG(quality: number): Buffer;
}

export interface PlatformImages {
  fromBuffer(data: Buffer): DecodedImage | null;
}

export interface PlatformMediaAccess {
  /** 服务器没有本机麦克风，直接视为已授权（采集发生在浏览器端） */
  microphone(): Promise<boolean>;
}

export interface PlatformNotification {
  isSupported(): boolean;
  show(options: { title: string; body: string }): { close(): void } | null;
}
