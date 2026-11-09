import { join } from 'node:path';
import {
  app,
  clipboard,
  hostKind,
  notification,
  pluginHostPath,
  shell,
  utilityProcess,
} from '@platform';
import type { PluginHostCapabilities } from '@shared/extensionPlugins/protocol';
import { IPC_CHANNELS } from '@shared/types';
import { readSettings } from '../../ipc/settings';
import { setNativeAgentTypeSource } from '../pluginRuntime';
import { remoteLeaderId } from '../remoteRenderer/senders';
import { broadcastToRenderers, localMainContents, rendererById } from '../renderers';
import { BUILTIN_MARKET } from './builtinMarket';
import { DraftBroker } from './draftBroker';
import type { GateDeps } from './gate';
import { envMarketSources, marketPublicKeys, PluginMarket } from './market';
import { pluginError } from './process';
import { ExtensionPluginService, type PluginSessionBridge } from './service';

export type { PluginSessionBridge };

/** 宿主 MCP 由 agentHost 注入（经 worker 执行），避免这里反向依赖 agentHost */
export type PluginMcpBridge = Pick<GateDeps, 'mcpTools' | 'mcpCall'>;

let service: ExtensionPluginService | null = null;
let mcpBridge: PluginMcpBridge | null = null;
let draftBroker: DraftBroker | null = null;
let sessionBridge: PluginSessionBridge | null = null;
let sessionDirectory: PluginSessionDirectory | null = null;

export function setPluginSessionBridge(bridge: PluginSessionBridge | null): void {
  sessionBridge = bridge;
}

export type PluginSessionDirectory = Required<NonNullable<GateDeps['sessions']>>;

/** 会话列表与状态由持有权威记录的 agent IPC 注入，避免这里反向依赖它 */
export function setPluginSessionDirectory(directory: PluginSessionDirectory | null): void {
  sessionDirectory = directory;
}

/** 新建会话要等权威记录创建完成，比草稿操作慢 */
const SESSION_UI_TIMEOUT_MS = 15_000;

/** 服务端的剪贴板和外链是空操作，capabilities 按宿主种类如实报告 */
export function pluginHostCapabilities(input: {
  host: 'desktop' | 'server';
  hostVersion: string;
  notify: boolean;
  clipboard: boolean;
  openExternal: boolean;
}): PluginHostCapabilities {
  const desktop = input.host === 'desktop';
  return {
    host: input.host,
    hostVersion: input.hostVersion,
    notify: input.notify,
    mcp: true,
    clipboard: desktop && input.clipboard,
    openExternal: desktop && input.openExternal,
    composer: true,
  };
}

const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
];

/** 插件进程不继承 Main 的环境变量，只给运行 Node 必需的几项和代理设置 */
export function pluginHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

export function getDraftBroker(): DraftBroker {
  draftBroker ??= new DraftBroker({
    channel: IPC_CHANNELS.EXTENSION_PLUGINS_DRAFT_REQUEST,
    find: rendererById,
  });
  return draftBroker;
}

export function setPluginMcpBridge(bridge: PluginMcpBridge | null): void {
  mcpBridge = bridge;
}

const noMcp = () => Promise.reject(pluginError('UNSUPPORTED', '当前环境无法调用 MCP'));

export function getExtensionPlugins(): ExtensionPluginService {
  if (service) return service;
  const capabilities = pluginHostCapabilities({
    host: hostKind,
    hostVersion: app.getVersion(),
    notify: notification.isSupported(),
    clipboard: typeof clipboard.writeText === 'function',
    openExternal: typeof shell.openExternal === 'function',
  });
  service = new ExtensionPluginService({
    root: join(app.getPath('userData'), 'extension-plugins'),
    hostVersion: app.getVersion(),
    hostPath: pluginHostPath,
    env: pluginHostEnv(process.env),
    sourceEnv: process.env,
    capabilities,
    sessionBridge: () => sessionBridge,
    fork: (modulePath, args, options) => utilityProcess.fork(modulePath, args, options),
    autoUpdatePlugins: () => {
      const persisted = readSettings()?.['enso-settings'] as
        | { state?: { pluginAutoUpdate?: unknown } }
        | undefined;
      return persisted?.state?.pluginAutoUpdate !== false;
    },
    market: new PluginMarket({
      root: join(app.getPath('userData'), 'extension-plugins'),
      fetch: (url, init) => fetch(url, init),
      hostVersion: app.getVersion(),
      publicKeys: marketPublicKeys(process.env),
      builtin: BUILTIN_MARKET,
      ...(envMarketSources(process.env)
        ? { sources: () => envMarketSources(process.env) ?? [] }
        : {}),
    }),
    gate: {
      fetch: (url, init) => fetch(url, init),
      notify: (title, body) => {
        if (!notification.isSupported()) return false;
        notification.show({ title, body });
        return true;
      },
      viewEvent: (pluginId, name, data) => {
        broadcastToRenderers(IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_EVENT, { pluginId, name, data });
      },
      composer: (target, op, payload) =>
        getDraftBroker().request(target.origin, target.sessionId, op, payload),
      sessions: {
        list: (origin) => sessionDirectory?.list(origin) ?? [],
        listAll: () => sessionDirectory?.listAll() ?? [],
        status: (sessionId) =>
          sessionDirectory?.status(sessionId) ?? {
            sessionId,
            state: 'idle',
            pendingAsks: 0,
            pendingApprovals: 0,
          },
      },
      sessionUi: (target, op, payload) => {
        const origin =
          target.origin ??
          (op === 'openPluginView'
            ? (localMainContents()?.id ?? remoteLeaderId(false) ?? null)
            : null);
        return getDraftBroker().request(
          origin,
          target.sessionId,
          op,
          payload,
          SESSION_UI_TIMEOUT_MS
        );
      },
      // 发起窗口一定活着（它刚调用了插件），优先交给它。后台投递没有发起窗口时退到主窗口，
      // 服务器模式下本机主窗口恒为 null，再退到远端主界面
      wakeSession: async (sessionId, origin) => {
        const target = origin ?? localMainContents()?.id ?? remoteLeaderId(false) ?? null;
        await getDraftBroker().request(
          target,
          sessionId,
          'ensureSession',
          {},
          SESSION_UI_TIMEOUT_MS
        );
      },
      mcpTools: (target, signal) => (mcpBridge ? mcpBridge.mcpTools(target, signal) : noMcp()),
      mcpCall: (target, server, tool, args, signal) =>
        mcpBridge ? mcpBridge.mcpCall(target, server, tool, args, signal) : noMcp(),
      now: Date.now,
      ...(capabilities.clipboard ? { clipboard: (text: string) => clipboard.writeText(text) } : {}),
      ...(capabilities.openExternal
        ? { openExternal: (url: string) => shell.openExternal(url) }
        : {}),
    },
  });
  service.startUpdateChecks();
  service.startBackground();
  setNativeAgentTypeSource(service.agentTypeSource());
  app.on('before-quit', () => service?.dispose());
  return service;
}
