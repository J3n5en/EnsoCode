/**
 * Node 宿主的平台实现。没有窗口、钥匙串和 Chromium 会话：
 * 密钥落在数据目录的 0600 主密钥上，子进程用 child_process.fork。
 */
import { type ChildProcess, fork } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import type {
  IpcHandler,
  IpcListener,
  PlatformApp,
  PlatformPathName,
  ProcessMetric,
  WillQuitEvent,
  WorkerForkOptions,
} from '../main/platform/types';

export const hostKind = 'server' as const;
/** 服务器构建把 agent worker 与入口并排输出 */
export const agentWorkerPath = path.join(import.meta.dirname, 'agent.js');
export const pluginHostPath = path.join(import.meta.dirname, 'plugin-host.js');
const appRoot = path.resolve(
  process.env.ENSO_APP_ROOT?.trim() || path.join(import.meta.dirname, '../..')
);
export const resourcesPath = path.join(appRoot, 'resources');

/** 每次读取，这样 `enso-server run --data-dir` 能在入口解析后再生效。 */
function dataDir(): string {
  return path.resolve(process.env.ENSO_DATA_DIR?.trim() || path.join(homedir(), '.enso-server'));
}

function ensureUserData(): string {
  const userData = dataDir();
  mkdirSync(userData, { recursive: true });
  return userData;
}

type AppEvent = 'before-quit' | 'will-quit';
type AppListener = (event: WillQuitEvent) => void;
const beforeQuit = new Set<AppListener>();
const willQuit = new Set<AppListener>();
const appListeners = (event: AppEvent) => (event === 'before-quit' ? beforeQuit : willQuit);

export const app = {
  isPackaged: process.env.ENSO_PACKAGED !== '0',
  getPath(name: PlatformPathName): string {
    switch (name) {
      case 'userData':
        return ensureUserData();
      case 'temp':
        return tmpdir();
      case 'home':
        return homedir();
      case 'appData':
        return path.dirname(dataDir());
      case 'logs':
        return path.join(ensureUserData(), 'logs');
      case 'downloads':
        return path.join(ensureUserData(), 'downloads');
      default:
        return ensureUserData();
    }
  },
  getAppPath(): string {
    return appRoot;
  },
  getName: () => 'enso-code',
  getVersion(): string {
    try {
      const raw = readFileSync(path.join(this.getAppPath(), 'package.json'), 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
    } catch {
      return '0.0.0';
    }
  },
  quit(): void {
    for (const listener of beforeQuit) listener({ preventDefault() {} });
    let held = false;
    const event = {
      preventDefault() {
        held = true;
      },
    };
    for (const listener of willQuit) listener(event);
    if (!held) process.exit(0);
  },
  setBadgeCount(): boolean {
    return false;
  },
  async getFileIcon(): Promise<{ isEmpty(): boolean; toDataURL(): string }> {
    return { isEmpty: () => true, toDataURL: () => '' };
  },
  on: (event: AppEvent, listener: AppListener) => appListeners(event).add(listener),
  once(event: AppEvent, listener: AppListener) {
    const wrapped: AppListener = (quitEvent) => {
      appListeners(event).delete(wrapped);
      listener(quitEvent);
    };
    appListeners(event).add(wrapped);
  },
  removeListener: (event: AppEvent, listener: AppListener) => appListeners(event).delete(listener),
} as PlatformApp;

const handlers = new Map<string, IpcHandler>();
const listeners = new Map<string, Set<IpcListener>>();

export const ipcMain = {
  handle(channel: string, handler: IpcHandler) {
    handlers.set(channel, handler);
  },
  removeHandler(channel: string) {
    handlers.delete(channel);
  },
  on(channel: string, listener: IpcListener) {
    const set = listeners.get(channel) ?? new Set<IpcListener>();
    listeners.set(channel, set);
    set.add(listener);
  },
  removeListener(channel: string, listener: IpcListener) {
    listeners.get(channel)?.delete(listener);
  },
  off(channel: string, listener: IpcListener) {
    this.removeListener(channel, listener);
  },
  removeAllListeners(channel?: string) {
    if (channel === undefined) listeners.clear();
    else listeners.delete(channel);
  },
};

export const shell = {
  async openExternal(url: string) {
    console.log(`[enso-server] open ${url}`);
  },
  async openPath(target: string) {
    console.log(`[enso-server] open path ${target}`);
    return 'opening paths is not available on the server';
  },
  showItemInFolder(target: string) {
    console.log(`[enso-server] reveal ${target}`);
  },
};

const KEY_FILE = 'secret.key';

function masterKey(): Buffer {
  const file = path.join(ensureUserData(), KEY_FILE);
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw new Error(`secret key at ${file} must be 32 bytes`);
  return key;
}

export const safeStorage = {
  isAsyncEncryptionAvailable: async () => true,
  async encryptStringAsync(plainText: string): Promise<Buffer> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
    const body = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  async decryptStringAsync(encrypted: Buffer) {
    const iv = encrypted.subarray(0, 12);
    const tag = encrypted.subarray(12, 28);
    const body = encrypted.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
    decipher.setAuthTag(tag);
    const result = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return { result, shouldReEncrypt: false };
  },
};

export const powerMonitor = { on: () => undefined };
export const powerSaveBlocker = { start: () => 1, stop: () => undefined };

const inertSession = {
  setProxy: async () => undefined,
  resolveProxy: async () => 'DIRECT',
  clearCache: async () => undefined,
  clearCodeCaches: async () => undefined,
  clearStorageData: async () => undefined,
};

export const session = { defaultSession: inertSession, fromPartition: () => inertSession };
export const net = { fetch: globalThis.fetch.bind(globalThis) };

class ForkedWorker extends EventEmitter {
  private exited = false;

  constructor(private readonly child: ChildProcess) {
    super();
    child.on('spawn', () => this.emit('spawn'));
    child.on('message', (message) => this.emit('message', message));
    child.on('error', (error) => {
      process.stderr.write(
        `[enso-server] worker: ${error instanceof Error ? error.message : String(error)}\n`
      );
      this.finish(1);
    });
    child.on('exit', (code) => this.finish(code ?? 0));
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  postMessage(message: unknown): void {
    this.child.send(message as import('node:child_process').Serializable);
  }

  kill(): boolean {
    const ok = this.child.kill();
    const pid = this.child.pid;
    const timer = setTimeout(() => {
      if (this.exited || pid === undefined) return;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // 进程已经退出
      }
    }, 2_000);
    timer.unref?.();
    return ok;
  }

  private finish(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code);
  }
}

export const utilityProcess = {
  fork(modulePath: string, args: string[], options: WorkerForkOptions) {
    // run 把 worker 的 stdout 接到本进程 stderr，避免诊断混进机器可读输出。
    const headless = process.env.ENSO_HEADLESS_RUN === '1';
    const child = fork(modulePath, args, {
      env: options.env,
      serialization: 'advanced',
      stdio: headless
        ? ['ignore', 'pipe', 'pipe', 'ipc']
        : ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    if (headless) {
      child.stdout?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
      });
    }
    return new ForkedWorker(child);
  },
};

export const clipboard = { writeText: async () => {}, writeBuffer: async () => {} };

export const images = { fromBuffer: () => null };

export const mediaAccess = { microphone: async () => true };

export const notification = {
  isSupported: () => false,
  show: () => null,
};

export function processMetrics(): ProcessMetric[] {
  return [
    {
      pid: process.pid,
      type: 'Node',
      name: 'enso-server',
      cpu: { percentCPUUsage: 0 },
      memory: { workingSetSize: Math.round(process.memoryUsage().rss / 1024) },
    },
  ];
}
