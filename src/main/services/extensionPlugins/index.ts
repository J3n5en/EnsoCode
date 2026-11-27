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
import { isHeadlessRun } from '@shared/headlessRun';
import { IPC_CHANNELS } from '@shared/types/ipc';
import { readSettings } from '../../ipc/settings';
import { setNativeAgentTypeSource } from '../pluginRuntime';
import { remoteLeaderId } from '../remoteRenderer/senders';
import { broadcastToRenderers, localMainContents, rendererById } from '../renderers';
import { isSessionMuted } from '../sessionMuteGate';
import { BUILTIN_MARKET } from './builtinMarket';
import { DraftBroker } from './draftBroker';
import type { GateDeps } from './gate';
import type { OwnerBindings } from './injectTrust';
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
let contactBridge: PluginContactBridge | null = null;
let ownerBindingsProbe: (() => OwnerBindings) | null = null;

/** 秘书联系方式由 secretary 模块接上；没接上时插件调 contact.* 报不支持 */
export type PluginContactBridge = NonNullable<GateDeps['contact']>;

export function setPluginContactBridge(bridge: PluginContactBridge | null): void {
  contactBridge = bridge;
}

export function setPluginOwnerBindingsProbe(probe: (() => OwnerBindings) | null): void {
  ownerBindingsProbe = probe;
}

const EMPTY_OWNER_BINDINGS: OwnerBindings = {
  telegramOwnerIds: new Set(),
  telegramPrivateChatIds: new Set(),
};

export function pluginOwnerBindings(): OwnerBindings {
  return ownerBindingsProbe?.() ?? EMPTY_OWNER_BINDINGS;
}

const noContact = () => pluginError('UNSUPPORTED', '秘书联系方式还没就绪');

export function setPluginSessionBridge(bridge: PluginSessionBridge | null): void {
  sessionBridge = bridge;
}

export type PluginSessionDirectory = Required<NonNullable<GateDeps['sessions']>>;

/** 会话列表与状态由持有权威记录的 agent IPC 注入，避免这里反向依赖它 */
export function setPluginSessionDirectory(directory: PluginSessionDirectory | null): void {
  sessionDirectory = directory;
}

/** Main 侧恢复会话；不归 Main 恢复的会话返回 null */
export type PluginSessionResume = (
  sessionId: string
) => Promise<{ ok: boolean; error?: string } | null>;

let sessionResume: PluginSessionResume | null = null;

export function setPluginSessionResume(resume: PluginSessionResume | null): void {
  sessionResume = resume;
}

/** 替用户回答提问由持有会话的 agent IPC 注入 */
export type PluginAskAnswerer = NonNullable<GateDeps['answerAsk']>;

let askAnswerer: PluginAskAnswerer | null = null;

export function setPluginAskAnswerer(answerer: PluginAskAnswerer | null): void {
  askAnswerer = answerer;
}

/**
 * 先让窗口拉起会话；窗口里没有它（如没打开的秘书会话）就退到 Main 侧恢复。
 * Main 不接手的会话照报窗口的原因。
 */
export async function wakePluginSession(input: {
  ensure: () => Promise<unknown>;
  resume?: () => Promise<{ ok: boolean; error?: string } | null>;
}): Promise<void> {
  try {
    await input.ensure();
  } catch (error) {
    const resumed = await input.resume?.();
    if (!resumed) throw error;
    if (!resumed.ok) throw new Error(resumed.error ?? '恢复会话失败');
  }
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
  'NODE_EXTRA_CA_CERTS',
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

/** 只取已创建的实例：订阅与可见范围都在实例里，没创建就无需通知或清理 */
export function peekExtensionPlugins(): ExtensionPluginService | null {
  return service;
}

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
    pluginLoggingEnabled: () => {
      const persisted = readSettings()?.['enso-settings'] as
        | { state?: { pluginLoggingEnabled?: unknown } }
        | undefined;
      return persisted?.state?.pluginLoggingEnabled === true;
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
      contact: {
        register: (pluginId, channelId, caps) => {
          if (!contactBridge) throw noContact();
          contactBridge.register(pluginId, channelId, caps);
        },
        inbound: (pluginId, channelId, input) => {
          if (!contactBridge) throw noContact();
          contactBridge.inbound(pluginId, channelId, input);
        },
        setStatus: (pluginId, channelId, input) => {
          if (!contactBridge) throw noContact();
          contactBridge.setStatus(pluginId, channelId, input);
        },
      },
      notify: (title, body) => {
        if (!notification.isSupported()) return false;
        notification.show({ title, body });
        return true;
      },
      sessionMuted: (sessionId) => isSessionMuted(sessionId),
      answerAsk: (sessionId, requestId, answer) =>
        askAnswerer
          ? askAnswerer(sessionId, requestId, answer)
          : { ok: false, error: '当前环境不能回答提问' },
      viewEvent: (pluginId, name, data) => {
        broadcastToRenderers(IPC_CHANNELS.EXTENSION_PLUGINS_VIEW_EVENT, { pluginId, name, data });
      },
      composer: (target, op, payload) =>
        getDraftBroker().request(target.origin, target.sessionId, op, payload),
      sessions: {
        list: (origin) => sessionDirectory?.list(origin) ?? [],
        listAll: (options) => sessionDirectory?.listAll(options) ?? [],
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
          (op === 'openPluginView' || op === 'closePluginView'
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
      wakeSession: (sessionId, origin) => {
        const target = origin ?? localMainContents()?.id ?? remoteLeaderId(false) ?? null;
        return wakePluginSession({
          ensure: () =>
            getDraftBroker().request(target, sessionId, 'ensureSession', {}, SESSION_UI_TIMEOUT_MS),
          resume: async () => (sessionResume ? sessionResume(sessionId) : null),
        });
      },
      mcpTools: (target, signal) => (mcpBridge ? mcpBridge.mcpTools(target, signal) : noMcp()),
      mcpCall: (target, server, tool, args, signal) =>
        mcpBridge ? mcpBridge.mcpCall(target, server, tool, args, signal) : noMcp(),
      now: Date.now,
      ...(capabilities.clipboard
        ? {
            clipboard: (text: string) =>
              void clipboard
                .writeText(text)
                .catch((error) => console.warn('[plugins] clipboard write failed', error)),
          }
        : {}),
      ...(capabilities.openExternal
        ? { openExternal: (url: string) => shell.openExternal(url) }
        : {}),
    },
  });
  // 单次 run 不拉插件市场、不起常驻插件进程。
  if (!isHeadlessRun()) {
    service.startUpdateChecks();
    service.startBackground();
  }
  setNativeAgentTypeSource(service.agentTypeSource());
  app.on('before-quit', () => service?.dispose());
  return service;
}
